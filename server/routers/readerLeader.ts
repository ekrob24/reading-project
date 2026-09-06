import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";
import { protectedProcedure, router } from "../_core/trpc";
import { analyseReadingText } from "../reader";
import { assertSafeExerciseSet } from "../exerciseSafety";
import { extractReadingMaterial } from "../documentExtraction";
import { createReadingReport } from "../readerReports";
import { scoreQuiz } from "../quizPolicy";
import { createBrandedPdfReport } from "../pdfReports";
import {
  approveReadingMaterial,
  assignReadingMaterialToClasses,
  addLearnerToTeacherClass,
  addLearnersToTeacherClass,
  createAdditionalClassForTeacher,
  createChildProfile,
  createClassForTeacher,
  createReadingMaterial,
  enrollChildInClass,
  getChildProfileForUser,
  getChildProgress,
  getAssignedMaterialForChild,
  getLearnerReadingSettings,
  getParentDashboard,
  getSessionById,
  getSessionPlayback,
  getTeacherSessionReview,
  getTeacherMaterialReview,
  getTeacherDashboard,
  getTeacherMonthlyTrendExport,
  listParentReminders,
  listTeacherClasses,
  listTeacherTermPresets,
  isTeacher,
  linkParentToFamily,
  listAssignedMaterialsForChild,
  makeReadingMaterialAssignable,
  listTeacherMaterials,
  mayAccessChildProfile,
  saveGeneratedExercises,
  saveQuizAttempt,
  addSessionComment,
  getSessionComments,
  getQuizHistory,
  getReportContext,
  getSchoolBrandingForTeacher,
  saveSchoolBranding,
  seedDemoCohort,
  saveReadingSession,
  saveLearnerReadingSettings,
  saveHomePracticeChecklist,
  markParentReminderRead,
  markAllParentRemindersRead,
  saveTeacherTermPreset,
  saveTeacherInterventionDecision,
  deleteTeacherTermPreset,
  setUserRole,
} from "../readerDb";
import { storageGet, storagePut, storageGetSignedUrl } from "../storage";
import { buildWordTimings } from "../wordTiming";
import { createMonthlyTrendCsv, monthlyTrendFilename } from "../trendExport";

const childRole = z.literal("child");
const teacherRole = z.literal("teacher");
const parentRole = z.literal("parent");
const assessmentModeSchema = z.enum(["GUIDED_PRACTICE", "ASSISTED_PRACTICE", "MONTHLY_ASSESSMENT"]);
const languageSupportSchema = z.enum(["STANDARD_ENGLISH", "IRISH_ENGLISH_SUPPORT"]);
const materialRightsSourceSchema = z.enum(["original", "public_domain", "permission_obtained"]);
const trendDateRangeSchema = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional();
const termPresetSchema = z.object({ name: z.string().trim().min(2).max(80), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const wordStateSchema = z.object({ id: z.string().regex(/^word-\d+$/), text: z.string().min(1).max(80), status: z.enum(["unread", "current", "correct", "incorrect", "retried_correct"]), attempts: z.number().int().min(0).max(12) });
const exerciseSetSchema = z.object({
  vocabulary: z.array(z.object({ word: z.string().min(1).max(50), childFriendlyMeaning: z.string().min(1).max(200) })).min(3).max(6),
  questions: z.array(z.object({ prompt: z.string().min(1).max(240), options: z.array(z.string().min(1).max(120)).min(3).max(4), answer: z.string().min(1).max(120), explanation: z.string().min(1).max(240) })).min(3).max(4),
  activity: z.string().min(1).max(300),
});

function code(prefix: string) {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function requireTeacher(role: string) {
  if (!isTeacher(role as "user" | "admin" | "child" | "teacher" | "parent")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This action is available to teacher accounts." });
  }
}

function llmContentAsText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return content.map(part => "text" in (part as object) ? (part as { text: string }).text : "").join("");
}

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "reading-material";
}

export const readerLeaderRouter = router({
  account: router({
    me: protectedProcedure.query(async ({ ctx }) => {
      const role = ctx.user.role;
      const profile = role === "child" ? await getChildProfileForUser(ctx.user.id) : null;
      return { user: ctx.user, role, profile };
    }),
    setupChild: protectedProcedure.input(z.object({ displayName: z.string().trim().min(2).max(80) })).mutation(async ({ ctx, input }) => {
      await setUserRole(ctx.user.id, childRole.value);
      const profile = await createChildProfile(ctx.user.id, input.displayName, code("FAMILY"));
      return { profile, familyCode: profile.familyCode };
    }),
    setupTeacher: protectedProcedure.input(z.object({ className: z.string().trim().min(2).max(120) })).mutation(async ({ ctx, input }) => {
      await setUserRole(ctx.user.id, teacherRole.value);
      const readerClass = await createClassForTeacher(ctx.user.id, input.className, code("CLASS"));
      return { readerClass, joinCode: readerClass.joinCode };
    }),
    linkParent: protectedProcedure.input(z.object({ familyCode: z.string().trim().min(4).max(12) })).mutation(async ({ ctx, input }) => {
      await setUserRole(ctx.user.id, parentRole.value);
      const profile = await linkParentToFamily(ctx.user.id, input.familyCode.toUpperCase());
      return { profile };
    }),
    joinClass: protectedProcedure.input(z.object({ classCode: z.string().trim().min(4).max(12) })).mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Only child accounts can join a class." });
      const readerClass = await enrollChildInClass(ctx.user.id, input.classCode.toUpperCase());
      return { readerClass };
    }),
  }),
  materials: router({
    extractUpload: protectedProcedure.input(z.object({
      sourceFilename: z.string().trim().min(1).max(255),
      sourceFileBase64: z.string().min(1).max(7_000_000),
      sourceFileMime: z.string().trim().min(1).max(120),
    })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      const bytes = Buffer.from(input.sourceFileBase64, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > 5_000_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Use a reading document under 5 MB." });
      const extracted = await extractReadingMaterial(bytes, input.sourceFileMime, input.sourceFilename);
      const stored = await storagePut(`reader-leader/materials/${ctx.user.id}/${safeFilename(input.sourceFilename)}`, bytes, input.sourceFileMime);
      return { ...extracted, sourceFilename: input.sourceFilename, storageKey: stored.key };
    }),
    assignedForMe: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Assigned reading materials are available to child accounts." });
      return listAssignedMaterialsForChild(ctx.user.id);
    }),
    listMine: protectedProcedure.query(async ({ ctx }) => {
      requireTeacher(ctx.user.role);
      return listTeacherMaterials(ctx.user.id);
    }),
    review: protectedProcedure.input(z.object({ materialId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      const [review, classes] = await Promise.all([getTeacherMaterialReview(ctx.user.id, input.materialId), listTeacherClasses(ctx.user.id)]);
      if (!review) throw new TRPCError({ code: "NOT_FOUND", message: "This material is not available to your class." });
      return { ...review, availableClasses: classes.map(readerClass => ({ id: readerClass.id, name: readerClass.name, joinCode: readerClass.joinCode })) };
    }),
    create: protectedProcedure.input(z.object({
      title: z.string().trim().min(3).max(180),
      author: z.string().trim().min(2).max(180),
      rightsSource: materialRightsSourceSchema,
      interestAge: z.string().trim().min(2).max(80),
      genre: z.string().trim().min(2).max(80),
      readingLevel: z.string().trim().min(2).max(80),
      sourceText: z.string().trim().min(80).max(8000),
      sourceFilename: z.string().trim().min(1).max(255).optional(),
      sourceFileBase64: z.string().max(7_000_000).optional(),
      sourceFileMime: z.string().max(120).optional(),
      storageKey: z.string().max(512).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      let storageKey = input.storageKey;
      if (storageKey && !storageKey.startsWith(`reader-leader/materials/${ctx.user.id}/`)) throw new TRPCError({ code: "FORBIDDEN", message: "This uploaded document does not belong to your account." });
      if (input.sourceFileBase64 && input.sourceFilename) {
        const bytes = Buffer.from(input.sourceFileBase64, "base64");
        if (bytes.byteLength > 5_000_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Use a source document under 5 MB." });
        const stored = await storagePut(`reader-leader/materials/${ctx.user.id}/${safeFilename(input.sourceFilename)}`, bytes, input.sourceFileMime || "text/plain");
        storageKey = stored.key;
      }
      return createReadingMaterial({ teacherUserId: ctx.user.id, title: input.title, author: input.author, rightsSource: input.rightsSource, interestAge: input.interestAge, genre: input.genre, readingLevel: input.readingLevel, sourceText: input.sourceText, sourceFilename: input.sourceFilename, storageKey });
    }),
    generateExercises: protectedProcedure.input(z.object({ materialId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      const materials = await listTeacherMaterials(ctx.user.id);
      const material = materials.find(item => item.id === input.materialId);
      if (!material) throw new TRPCError({ code: "FORBIDDEN", message: "This material is not available to your class." });
      const prompt = `Create a concise, encouraging comprehension activity for children aged 8–10. Reading level: ${material.readingLevel}. Reading text:\n\n${material.sourceText.slice(0, 7000)}\n\nReturn only the requested structured result. Use accessible language. Include 3–6 meaningful vocabulary terms and 3–4 multiple-choice comprehension questions. Do not include sensitive, frightening, discriminatory, or adult content. Avoid diagnosing reading ability.`;
      const result = await invokeLLM({
        model: "gpt-5-mini",
        messages: [{ role: "system", content: "You are a primary literacy specialist creating safe, useful teacher-reviewed materials." }, { role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "reading_exercise_set", strict: true, schema: { type: "object", properties: { vocabulary: { type: "array", items: { type: "object", properties: { word: { type: "string" }, childFriendlyMeaning: { type: "string" } }, required: ["word", "childFriendlyMeaning"], additionalProperties: false }, minItems: 3, maxItems: 6 }, questions: { type: "array", items: { type: "object", properties: { prompt: { type: "string" }, options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 4 }, answer: { type: "string" }, explanation: { type: "string" } }, required: ["prompt", "options", "answer", "explanation"], additionalProperties: false }, minItems: 3, maxItems: 4 }, activity: { type: "string" } }, required: ["vocabulary", "questions", "activity"], additionalProperties: false } } },
      });
      const content = llmContentAsText(result.choices[0]?.message.content ?? "");
      const exerciseSet = assertSafeExerciseSet(exerciseSetSchema.parse(JSON.parse(content)));
      const saved = await saveGeneratedExercises(material.id, exerciseSet, "gpt-5-mini");
      return { material, exercise: saved };
    }),
    approve: protectedProcedure.input(z.object({ materialId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return { success: true, details: await approveReadingMaterial(ctx.user.id, input.materialId) };
    }),
    makeAssignable: protectedProcedure.input(z.object({ materialId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return { success: true, details: await makeReadingMaterialAssignable(ctx.user.id, input.materialId) };
    }),
    assign: protectedProcedure.input(z.object({ materialId: z.number().int().positive(), classIds: z.array(z.number().int().positive()).min(1).max(100).refine(classIds => new Set(classIds).size === classIds.length, "Choose each class only once.") })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return assignReadingMaterialToClasses(ctx.user.id, input.materialId, input.classIds);
    }),
  }),
  sessions: router({
    processAndSave: protectedProcedure.input(z.object({
      childProfileId: z.number().int().positive(),
      materialId: z.number().int().positive().nullable().optional(),
      storyTitle: z.string().min(3).max(180),
      expectedText: z.string().min(20).max(8000),
      audioBase64: z.string().min(1).max(6_000_000),
      audioMime: z.string().optional(),
      durationSeconds: z.number().int().min(10).max(900),
      assessmentMode: assessmentModeSchema.default("ASSISTED_PRACTICE"),
      wordStates: z.array(wordStateSchema).max(1000).optional(),
    })).mutation(async ({ ctx, input }) => {
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed || ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Only the signed-in child can save this reading session." });
      const bytes = Buffer.from(input.audioBase64, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > 4_500_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Keep this practice recording under 4.5 MB and try again." });
      const mimeType = input.audioMime?.startsWith("audio/") ? input.audioMime : "audio/webm";
      const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";
      const stored = await storagePut(`reader-leader/recordings/${ctx.user.id}/session-${Date.now()}.${extension}`, bytes, mimeType);
      const learnerSettings = await getLearnerReadingSettings(input.childProfileId);
      const transcriptionPrompt = learnerSettings.languageSupport === "IRISH_ENGLISH_SUPPORT"
        ? "Transcribe a child reading aloud in Irish English. Preserve the words as spoken, including regional pronunciation. Do not correct mistakes or convert dialect features."
        : "Transcribe an English-speaking child reading aloud. Preserve the words as spoken. Do not correct mistakes.";
      const transcription = await (await import("../_core/voiceTranscription")).transcribeAudio({ audioUrl: await storageGetSignedUrl(stored.key), language: "en", prompt: transcriptionPrompt });
      if ("error" in transcription) throw new Error(transcription.error);
      const analysis = analyseReadingText(input.expectedText, transcription.text, input.durationSeconds, input.assessmentMode, input.wordStates, learnerSettings.languageSupport);
      const interventions = analysis.events.filter(event => event.eventType !== "correct").slice(0, 5).map(event => ({ word: event.expectedWord, eventType: event.eventType, heardWord: event.recognisedWord ?? undefined, provisionalIrishEnglish: event.provisionalIrishEnglish, action: event.action === "teacher_review" ? "teacher_review" as const : event.action === "stay_silent" ? "stay_silent" as const : "prompt" as const, note: event.eventType === "dialect_variation" ? "Irish English variation provisionally accepted — please confirm this reading moment from the saved audio." : event.action === "teacher_review" ? "Possible pronunciation variation — flagged for teacher review. The coach stayed silent." : "Try that word again when you are ready." }));
      const wordTimings = buildWordTimings(transcription.text, analysis.durationSeconds, transcription.segments);
      const session = await saveReadingSession({ childProfileId: input.childProfileId, materialId: input.materialId, storyTitle: input.storyTitle, transcript: analysis.transcript, accuracy: analysis.accuracy, wordsCorrectPerMinute: analysis.pace, durationSeconds: analysis.durationSeconds, audioStorageKey: stored.key, assessmentMode: input.assessmentMode, languageSupport: learnerSettings.languageSupport, practiceWords: analysis.practiceWords, interventions, wordStates: analysis.wordStates, wordTimings });
      return { session, analysis };
    }),
    save: protectedProcedure.input(z.object({
      childProfileId: z.number().int().positive(),
      materialId: z.number().int().positive().nullable().optional(),
      storyTitle: z.string().min(3).max(180),
      expectedText: z.string().min(20).max(8000),
      transcript: z.string().min(1).max(8000),
      durationSeconds: z.number().int().min(10).max(900),
      assessmentMode: assessmentModeSchema.default("ASSISTED_PRACTICE"),
      wordStates: z.array(wordStateSchema).max(1000).optional(),
      demoInterventions: z.array(z.object({ word: z.string().min(1).max(80), action: z.enum(["prompt", "model", "stay_silent", "teacher_review"]), note: z.string().min(1).max(300) })).max(3).optional().default([]),
    })).mutation(async ({ ctx, input }) => {
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed || ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Only the signed-in child can save this reading session." });
      const learnerSettings = await getLearnerReadingSettings(input.childProfileId);
      const analysis = analyseReadingText(input.expectedText, input.transcript, input.durationSeconds, input.assessmentMode, input.wordStates, learnerSettings.languageSupport);
      const interventions = analysis.events.filter(event => event.eventType !== "correct").slice(0, 5).map(event => {
        const action: "prompt" | "model" | "stay_silent" | "teacher_review" = event.action === "teacher_review"
          ? "teacher_review"
          : event.action === "stay_silent"
            ? "stay_silent"
            : "prompt";
        return {
          word: event.expectedWord,
          eventType: event.eventType,
          heardWord: event.recognisedWord ?? undefined,
          provisionalIrishEnglish: event.provisionalIrishEnglish,
          action,
          note: event.eventType === "dialect_variation" ? "Irish English variation provisionally accepted — please confirm this reading moment from the saved audio." : event.action === "teacher_review" ? "Possible pronunciation variation — flagged for teacher review. The coach stayed silent." : event.action === "practise_gently" ? "Try that word again when you are ready." : "Reading event noted without interruption.",
        };
      });
      const wordTimings = buildWordTimings(analysis.transcript, analysis.durationSeconds);
      const session = await saveReadingSession({ childProfileId: input.childProfileId, materialId: input.materialId, storyTitle: input.storyTitle, transcript: analysis.transcript, accuracy: analysis.accuracy, wordsCorrectPerMinute: analysis.pace, durationSeconds: analysis.durationSeconds, assessmentMode: input.assessmentMode, languageSupport: learnerSettings.languageSupport, practiceWords: analysis.practiceWords, interventions: [...input.demoInterventions, ...interventions], wordStates: analysis.wordStates, wordTimings });
      return { session, analysis };
    }),
    teacherReview: protectedProcedure.input(z.object({ sessionId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      const review = await getTeacherSessionReview(input.sessionId);
      if (!review) throw new TRPCError({ code: "NOT_FOUND", message: "Reading session not found." });
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, review.session.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This child is not assigned to your class." });
      return review;
    }),
    decideIntervention: protectedProcedure.input(z.object({ sessionId: z.number().int().positive(), interventionIndex: z.number().int().min(0).max(100), teacherDecision: z.enum(["confirmed", "overridden"]) })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      const session = await getSessionById(input.sessionId);
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Reading session not found." });
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, session.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This child is not assigned to your class." });
      return saveTeacherInterventionDecision(input.sessionId, input.interventionIndex, input.teacherDecision);
    }),
    childProgress: protectedProcedure.input(z.object({ childProfileId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This child profile is not available to your account." });
      return getChildProgress(input.childProfileId);
    }),
    audioUrl: protectedProcedure.input(z.object({ sessionId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const playback = await getSessionPlayback(input.sessionId);
      const session = playback?.session;
      if (!session || !session.audioStorageKey) throw new TRPCError({ code: "NOT_FOUND", message: "This saved session does not have an audio recording." });
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, session.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This recording is not available to your account." });
      const audio = await storageGet(session.audioStorageKey);
      return { ...audio, transcript: session.transcript, wordTimings: playback.wordTimings };
    }),
    comments: protectedProcedure.input(z.object({ sessionId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const session = await getSessionById(input.sessionId);
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Reading session not found." });
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, session.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This session is not available to your account." });
      return getSessionComments([input.sessionId]);
    }),
    addComment: protectedProcedure.input(z.object({ sessionId: z.number().int().positive(), comment: z.string().trim().min(2).max(1200) })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      const session = await getSessionById(input.sessionId);
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Reading session not found." });
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, session.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This child is not assigned to your class." });
      return addSessionComment({ sessionId: input.sessionId, teacherUserId: ctx.user.id, comment: input.comment });
    }),
  }),
  learners: router({
    settings: protectedProcedure.input(z.object({ childProfileId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This learner is not available to your account." });
      return getLearnerReadingSettings(input.childProfileId);
    }),
    saveSettings: protectedProcedure.input(z.object({ childProfileId: z.number().int().positive(), defaultReadingMode: assessmentModeSchema, targetWcpm: z.number().int().min(30).max(250), languageSupport: languageSupportSchema.default("STANDARD_ENGLISH") })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This learner is not assigned to your class." });
      return saveLearnerReadingSettings(input.childProfileId, { defaultReadingMode: input.defaultReadingMode, targetWcpm: input.targetWcpm, languageSupport: input.languageSupport });
    }),
  }),
  classes: router({
    create: protectedProcedure.input(z.object({ name: z.string().trim().min(2).max(120) })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return createAdditionalClassForTeacher(ctx.user.id, input.name, code("CLASS"));
    }),
    addLearner: protectedProcedure.input(z.object({ classId: z.number().int().positive(), displayName: z.string().trim().min(2).max(80), bookBand: z.string().trim().min(2).max(80) })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return addLearnerToTeacherClass({ teacherUserId: ctx.user.id, ...input, familyCode: code("FAM") });
    }),
    importLearners: protectedProcedure.input(z.object({ classId: z.number().int().positive(), rows: z.array(z.object({ row: z.number().int().min(2).max(101), displayName: z.string().trim().min(1).max(80), bookBand: z.string().trim().min(2).max(80).optional() })).min(1).max(100) })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return addLearnersToTeacherClass({ teacherUserId: ctx.user.id, classId: input.classId, rows: input.rows, createFamilyCode: () => code("FAM") });
    }),
  }),
  termPresets: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireTeacher(ctx.user.role);
      return listTeacherTermPresets(ctx.user.id);
    }),
    save: protectedProcedure.input(termPresetSchema).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return saveTeacherTermPreset(ctx.user.id, input);
    }),
    remove: protectedProcedure.input(z.object({ presetId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return deleteTeacherTermPreset(ctx.user.id, input.presetId);
    }),
  }),
  homePractice: router({
    saveChecklist: protectedProcedure.input(z.object({ childProfileId: z.number().int().positive(), completedSteps: z.array(z.boolean()).max(3) })).mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "parent") throw new TRPCError({ code: "FORBIDDEN", message: "Home-practice checklists are available to linked parent accounts." });
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This learner is not linked to your family account." });
      return saveHomePracticeChecklist(ctx.user.id, input.childProfileId, input.completedSteps);
    }),
    markReminderRead: protectedProcedure.input(z.object({ reminderId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "parent") throw new TRPCError({ code: "FORBIDDEN", message: "This reminder centre is available to parent accounts." });
      await markParentReminderRead(ctx.user.id, input.reminderId);
      return { success: true } as const;
    }),
    markAllRemindersRead: protectedProcedure.mutation(async ({ ctx }) => {
      if (ctx.user.role !== "parent") throw new TRPCError({ code: "FORBIDDEN", message: "This reminder centre is available to parent accounts." });
      return markAllParentRemindersRead(ctx.user.id);
    }),
    reminders: protectedProcedure.input(z.object({ childProfileId: z.number().int().positive().optional(), range: trendDateRangeSchema })).query(async ({ ctx, input }) => {
      if (ctx.user.role !== "parent") throw new TRPCError({ code: "FORBIDDEN", message: "This reminder centre is available to parent accounts." });
      if (input.childProfileId && !(await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This learner is not linked to your family account." });
      }
      return listParentReminders(ctx.user.id, { childProfileId: input.childProfileId, ...input.range });
    }),
  }),
  quizzes: router({
    forAssignedMaterial: protectedProcedure.input(z.object({ materialId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      if (ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Quizzes are available to child accounts." });
      const material = await getAssignedMaterialForChild(ctx.user.id, input.materialId);
      if (!material?.exerciseSet) throw new TRPCError({ code: "NOT_FOUND", message: "There is no approved quiz for this reading passage yet." });
      return { materialId: material.id, title: material.title, activity: material.exerciseSet.activity, questions: material.exerciseSet.questions.map(question => ({ prompt: question.prompt, options: question.options })) };
    }),
    submit: protectedProcedure.input(z.object({
      childProfileId: z.number().int().positive(),
      materialId: z.number().int().positive(),
      answers: z.array(z.object({ questionIndex: z.number().int().min(0), selectedAnswer: z.string().min(1).max(120) })).min(1).max(4),
    })).mutation(async ({ ctx, input }) => {
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed || ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Only the signed-in child can submit this quiz." });
      const material = await getAssignedMaterialForChild(ctx.user.id, input.materialId);
      if (!material?.exerciseSet) throw new TRPCError({ code: "NOT_FOUND", message: "This assigned passage does not have an approved quiz." });
      const answers = scoreQuiz(material.exerciseSet.questions, input.answers);
      const score = answers.filter(answer => answer.correct).length;
      const attempt = await saveQuizAttempt({ childProfileId: input.childProfileId, materialId: input.materialId, answers, score, totalQuestions: material.exerciseSet.questions.length });
      return { attempt, score, totalQuestions: material.exerciseSet.questions.length, explanations: material.exerciseSet.questions.map((question, index) => ({ questionIndex: index, explanation: question.explanation })) };
    }),
    history: protectedProcedure.input(z.object({ childProfileId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed || ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Quiz history is available to the signed-in child." });
      return getQuizHistory(input.childProfileId);
    }),
  }),
  reports: router({
    monthlyTrend: protectedProcedure.input(z.object({ classId: z.number().int().positive().optional(), range: trendDateRangeSchema })).query(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return getTeacherMonthlyTrendExport(ctx.user.id, input.classId, input.range);
    }),
    monthlyTrendCsv: protectedProcedure.input(z.object({ classId: z.number().int().positive().optional(), range: trendDateRangeSchema })).query(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      const trend = await getTeacherMonthlyTrendExport(ctx.user.id, input.classId, input.range);
      return { filename: monthlyTrendFilename(trend.className, input.range), csv: createMonthlyTrendCsv(trend.className, trend.points) };
    }),
    download: protectedProcedure.input(z.object({ childProfileId: z.number().int().positive(), audience: z.enum(["child", "parent", "teacher"]) })).query(async ({ ctx, input }) => {
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This report is not available to your account." });
      if (input.audience === "child" && ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Use the report designed for your account." });
      if (input.audience === "parent" && ctx.user.role !== "parent") throw new TRPCError({ code: "FORBIDDEN", message: "Use the report designed for your account." });
      if (input.audience === "teacher" && !isTeacher(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Use the report designed for your account." });
      const progress = await getChildProgress(input.childProfileId);
      return createReadingReport({ audience: input.audience, childName: progress.profile.displayName, bookBand: progress.profile.bookBand, sessions: progress.sessions });
    }),
    downloadPdf: protectedProcedure.input(z.object({ childProfileId: z.number().int().positive(), audience: z.enum(["child", "parent", "teacher"]) })).query(async ({ ctx, input }) => {
      const allowed = await mayAccessChildProfile({ id: ctx.user.id, role: ctx.user.role }, input.childProfileId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "This report is not available to your account." });
      if (input.audience === "child" && ctx.user.role !== "child") throw new TRPCError({ code: "FORBIDDEN", message: "Use the report designed for your account." });
      if (input.audience === "parent" && ctx.user.role !== "parent") throw new TRPCError({ code: "FORBIDDEN", message: "Use the report designed for your account." });
      if (input.audience === "teacher" && !isTeacher(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Use the report designed for your account." });
      const context = await getReportContext(input.childProfileId);
      const data = await createBrandedPdfReport({ audience: input.audience, childName: context.profile.displayName, bookBand: context.profile.bookBand, sessions: context.sessions, branding: context.branding, comments: context.comments });
      return { filename: `${context.profile.displayName.toLowerCase().replace(/\s+/g, "-")}-${input.audience}-reading-report.pdf`, mimeType: "application/pdf", dataBase64: data.toString("base64") };
    }),
  }),
  branding: router({
    mine: protectedProcedure.query(async ({ ctx }) => { requireTeacher(ctx.user.role); return getSchoolBrandingForTeacher(ctx.user.id); }),
    save: protectedProcedure.input(z.object({ schoolName: z.string().trim().min(2).max(120), accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), footerLine: z.string().trim().min(4).max(180) })).mutation(async ({ ctx, input }) => {
      requireTeacher(ctx.user.role);
      return saveSchoolBranding(ctx.user.id, input);
    }),
  }),
  dashboards: router({
    teacher: protectedProcedure.query(async ({ ctx }) => {
      requireTeacher(ctx.user.role);
      return getTeacherDashboard(ctx.user.id);
    }),
    parent: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "parent" && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "This dashboard is available to parent accounts." });
      return getParentDashboard(ctx.user.id);
    }),
  }),
  demo: router({
    seedCohort: protectedProcedure.mutation(async ({ ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an administrator can create the guided demo cohort." });
      return seedDemoCohort(ctx.user.id);
    }),
  }),
});
