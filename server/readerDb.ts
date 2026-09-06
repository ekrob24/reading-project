import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  AccountRole,
  childProfiles,
  classEnrollments,
  familyLinks,
  homePracticeChecklists,
  learnerReadingSettings,
  materialAssignments,
  parentReminders,
  readerClasses,
  readingExercises,
  readingMaterialDetails,
  readingMaterials,
  readingSessions,
  quizAttempts,
  schoolBranding,
  sessionComments,
  teacherTermPresets,
  type ExerciseSet,
  type MaterialRightsSource,
  type QuizAnswer,
  type StoredIntervention,
  type AssessmentMode,
  type StoredWordState,
  type StoredWordTiming,
  type ReadingLanguageSupport,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { storagePut } from "./storage";
import { buildMonthlyAssessmentTrend, isValidTrendDateRange, minutesReadThisWeek, type TrendDateRange } from "./learningAnalytics";
import { createDemoPlaybackTone } from "./demoPlaybackFixture";
import { isPracticeChecklistComplete, normalisePracticeSteps, practiceChecklistDate } from "./homePractice";
import { analyseReadingText } from "./reader";

export type AuthenticatedReader = { id: number; role: AccountRole };

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Reader Leader data is temporarily unavailable.");
  return db;
}

export function isTeacher(role: AccountRole) {
  return role === "teacher" || role === "admin";
}

export async function setUserRole(userId: number, role: "child" | "teacher" | "parent") {
  const db = await requireDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("Account not found.");
  if (user.role !== "user" && user.role !== role && user.role !== "admin") {
    throw new Error("This account already has a Reader Leader role.");
  }
  if (user.role !== "admin") await db.update(users).set({ role }).where(eq(users.id, userId));
}

export async function getChildProfileForUser(userId: number) {
  const db = await requireDb();
  const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.userId, userId)).limit(1);
  return profile;
}

export async function createChildProfile(userId: number, displayName: string, familyCode: string) {
  const db = await requireDb();
  const [existing] = await db.select().from(childProfiles).where(eq(childProfiles.userId, userId)).limit(1);
  if (existing) return existing;
  await db.insert(childProfiles).values({ userId, displayName, familyCode });
  const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.userId, userId)).limit(1);
  if (!profile) throw new Error("Could not create child profile.");
  return profile;
}

const defaultLearnerSettings = (childProfileId: number) => ({ childProfileId, defaultReadingMode: "ASSISTED_PRACTICE" as AssessmentMode, targetWcpm: 100, languageSupport: "STANDARD_ENGLISH" as ReadingLanguageSupport });

export async function getLearnerReadingSettings(childProfileId: number) {
  const db = await requireDb();
  const [settings] = await db.select().from(learnerReadingSettings).where(eq(learnerReadingSettings.childProfileId, childProfileId)).limit(1);
  return settings ?? defaultLearnerSettings(childProfileId);
}

export async function saveLearnerReadingSettings(childProfileId: number, settings: { defaultReadingMode: AssessmentMode; targetWcpm: number; languageSupport: ReadingLanguageSupport }) {
  const db = await requireDb();
  await db.insert(learnerReadingSettings).values({ childProfileId, ...settings }).onDuplicateKeyUpdate({ set: settings });
  return getLearnerReadingSettings(childProfileId);
}

export async function createClassForTeacher(teacherUserId: number, name: string, joinCode: string) {
  const db = await requireDb();
  const [existing] = await db.select().from(readerClasses).where(eq(readerClasses.teacherUserId, teacherUserId)).limit(1);
  if (existing) return existing;
  await db.insert(readerClasses).values({ teacherUserId, name, joinCode });
  const [readerClass] = await db.select().from(readerClasses).where(eq(readerClasses.teacherUserId, teacherUserId)).limit(1);
  if (!readerClass) throw new Error("Could not create class.");
  return readerClass;
}

export async function createAdditionalClassForTeacher(teacherUserId: number, name: string, joinCode: string) {
  const db = await requireDb();
  await db.insert(readerClasses).values({ teacherUserId, name, joinCode });
  const [readerClass] = await db.select().from(readerClasses).where(eq(readerClasses.joinCode, joinCode)).limit(1);
  if (!readerClass) throw new Error("Could not create the new class.");
  return readerClass;
}

export type TeacherTermPresetInput = { name: string; startDate: string; endDate: string };

export async function listTeacherTermPresets(teacherUserId: number) {
  const db = await requireDb();
  return db.select().from(teacherTermPresets).where(eq(teacherTermPresets.teacherUserId, teacherUserId)).orderBy(desc(teacherTermPresets.updatedAt), desc(teacherTermPresets.id));
}

export async function saveTeacherTermPreset(teacherUserId: number, input: TeacherTermPresetInput) {
  if (!isValidTrendDateRange({ startDate: input.startDate, endDate: input.endDate }) || input.startDate > input.endDate) {
    throw new Error("Choose a valid start date and an end date on or after it.");
  }
  const db = await requireDb();
  await db.insert(teacherTermPresets).values({ teacherUserId, ...input }).onDuplicateKeyUpdate({ set: { startDate: input.startDate, endDate: input.endDate, updatedAt: new Date() } });
  const [preset] = await db.select().from(teacherTermPresets).where(and(eq(teacherTermPresets.teacherUserId, teacherUserId), eq(teacherTermPresets.name, input.name))).limit(1);
  if (!preset) throw new Error("Could not save the term preset.");
  return preset;
}

export async function deleteTeacherTermPreset(teacherUserId: number, presetId: number) {
  const db = await requireDb();
  await db.delete(teacherTermPresets).where(and(eq(teacherTermPresets.id, presetId), eq(teacherTermPresets.teacherUserId, teacherUserId)));
  return { success: true } as const;
}

export async function addLearnerToTeacherClass(input: { teacherUserId: number; classId: number; displayName: string; bookBand: string; familyCode: string }) {
  const db = await requireDb();
  const [readerClass] = await db.select().from(readerClasses).where(and(eq(readerClasses.id, input.classId), eq(readerClasses.teacherUserId, input.teacherUserId))).limit(1);
  if (!readerClass) throw new Error("This class is not available to your account.");
  const learnerOpenId = `teacher-roster-${input.teacherUserId}-${crypto.randomUUID()}`;
  await db.insert(users).values({ openId: learnerOpenId, name: input.displayName, loginMethod: "teacher-roster", role: "child" });
  const [learnerUser] = await db.select().from(users).where(eq(users.openId, learnerOpenId)).limit(1);
  if (!learnerUser) throw new Error("Could not create the learner record.");
  await db.insert(childProfiles).values({ userId: learnerUser.id, displayName: input.displayName, bookBand: input.bookBand, familyCode: input.familyCode });
  const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.userId, learnerUser.id)).limit(1);
  if (!profile) throw new Error("Could not create the learner profile.");
  await db.insert(classEnrollments).values({ classId: readerClass.id, childProfileId: profile.id });
  await db.insert(learnerReadingSettings).values(defaultLearnerSettings(profile.id)).onDuplicateKeyUpdate({ set: { childProfileId: profile.id } });
  return { readerClass, profile };
}

export async function addLearnersToTeacherClass(input: { teacherUserId: number; classId: number; rows: { row: number; displayName: string; bookBand?: string }[]; createFamilyCode: () => string }) {
  const db = await requireDb();
  const [readerClass] = await db.select().from(readerClasses).where(and(eq(readerClasses.id, input.classId), eq(readerClasses.teacherUserId, input.teacherUserId))).limit(1);
  if (!readerClass) throw new Error("This class is not available to your account.");
  const created: { row: number; childProfileId: number; displayName: string; bookBand: string }[] = [];
  const errors: { row: number; message: string }[] = [];
  const importedNames = new Set<string>();
  const existingRoster = await db.select({ displayName: childProfiles.displayName }).from(classEnrollments)
    .innerJoin(childProfiles, eq(classEnrollments.childProfileId, childProfiles.id))
    .where(eq(classEnrollments.classId, readerClass.id));
  const existingNames = new Set(existingRoster.map(item => item.displayName.trim().replace(/\s+/g, " ").toLocaleLowerCase()));
  for (const row of input.rows) {
    const displayName = row.displayName.trim().replace(/\s+/g, " ");
    const nameKey = displayName.toLocaleLowerCase();
    if (!displayName) { errors.push({ row: row.row, message: "A learner name is required." }); continue; }
    if (importedNames.has(nameKey)) { errors.push({ row: row.row, message: "This learner name appears more than once in the import." }); continue; }
    if (existingNames.has(nameKey)) { errors.push({ row: row.row, message: "This learner is already in the selected class roster." }); continue; }
    importedNames.add(nameKey);
    try {
      const result = await addLearnerToTeacherClass({ teacherUserId: input.teacherUserId, classId: input.classId, displayName, bookBand: row.bookBand?.trim() || "Level 3 · Sky Blue", familyCode: input.createFamilyCode() });
      created.push({ row: row.row, childProfileId: result.profile.id, displayName: result.profile.displayName, bookBand: result.profile.bookBand });
      existingNames.add(nameKey);
    } catch {
      errors.push({ row: row.row, message: "This learner could not be added. Please try the row again." });
    }
  }
  return { readerClass, created, errors };
}

export async function linkParentToFamily(parentUserId: number, familyCode: string) {
  const db = await requireDb();
  const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.familyCode, familyCode)).limit(1);
  if (!profile) throw new Error("We could not find a child profile with that family code.");
  await db.insert(familyLinks).values({ parentUserId, childProfileId: profile.id }).onDuplicateKeyUpdate({ set: { parentUserId } });
  return profile;
}

export async function enrollChildInClass(childUserId: number, joinCode: string) {
  const db = await requireDb();
  const profile = await getChildProfileForUser(childUserId);
  if (!profile) throw new Error("Create a child profile before joining a class.");
  const [readerClass] = await db.select().from(readerClasses).where(eq(readerClasses.joinCode, joinCode)).limit(1);
  if (!readerClass) throw new Error("We could not find a class with that code.");
  await db.insert(classEnrollments).values({ classId: readerClass.id, childProfileId: profile.id }).onDuplicateKeyUpdate({ set: { classId: readerClass.id } });
  return readerClass;
}

export async function mayAccessChildProfile(viewer: AuthenticatedReader, childProfileId: number) {
  if (viewer.role === "admin") return true;
  const db = await requireDb();
  if (viewer.role === "child") {
    const [row] = await db.select({ id: childProfiles.id }).from(childProfiles).where(and(eq(childProfiles.id, childProfileId), eq(childProfiles.userId, viewer.id))).limit(1);
    return Boolean(row);
  }
  if (viewer.role === "parent") {
    const [row] = await db.select({ id: familyLinks.id }).from(familyLinks).where(and(eq(familyLinks.childProfileId, childProfileId), eq(familyLinks.parentUserId, viewer.id))).limit(1);
    return Boolean(row);
  }
  if (viewer.role === "teacher") {
    const [row] = await db.select({ id: classEnrollments.id }).from(classEnrollments)
      .innerJoin(readerClasses, eq(classEnrollments.classId, readerClasses.id))
      .where(and(eq(classEnrollments.childProfileId, childProfileId), eq(readerClasses.teacherUserId, viewer.id))).limit(1);
    return Boolean(row);
  }
  return false;
}

export async function createReadingMaterial(input: { teacherUserId: number; title: string; readingLevel: string; sourceText: string; author: string; rightsSource: MaterialRightsSource; interestAge: string; genre: string; sourceFilename?: string; storageKey?: string }) {
  const db = await requireDb();
  const { author, rightsSource, interestAge, genre, ...materialInput } = input;
  return db.transaction(async transaction => {
    await transaction.insert(readingMaterials).values(materialInput);
    const [material] = await transaction.select().from(readingMaterials).where(and(eq(readingMaterials.teacherUserId, input.teacherUserId), eq(readingMaterials.title, input.title))).orderBy(desc(readingMaterials.id)).limit(1);
    if (!material) throw new Error("Could not save reading material.");
    await transaction.insert(readingMaterialDetails).values({ materialId: material.id, author, rightsSource, interestAge, genre });
    const [details] = await transaction.select().from(readingMaterialDetails).where(eq(readingMaterialDetails.materialId, material.id)).limit(1);
    if (!details) throw new Error("Could not save reading material details.");
    return { ...material, details };
  });
}

export async function listTeacherMaterials(teacherUserId: number) {
  const db = await requireDb();
  const materials = await db.select().from(readingMaterials).where(eq(readingMaterials.teacherUserId, teacherUserId)).orderBy(desc(readingMaterials.createdAt));
  if (!materials.length) return [];
  const details = await db.select().from(readingMaterialDetails).where(inArray(readingMaterialDetails.materialId, materials.map(material => material.id)));
  return materials.map(material => ({ ...material, details: details.find(item => item.materialId === material.id) ?? null }));
}

export async function getTeacherMaterialReview(teacherUserId: number, materialId: number) {
  const db = await requireDb();
  const [row] = await db.select({ material: readingMaterials, exercise: readingExercises, details: readingMaterialDetails })
    .from(readingMaterials)
    .leftJoin(readingExercises, eq(readingMaterials.id, readingExercises.materialId))
    .leftJoin(readingMaterialDetails, eq(readingMaterials.id, readingMaterialDetails.materialId))
    .where(and(eq(readingMaterials.id, materialId), eq(readingMaterials.teacherUserId, teacherUserId)))
    .limit(1);
  if (!row) return undefined;
  const assignments = await db.select({ classId: materialAssignments.classId }).from(materialAssignments).where(eq(materialAssignments.materialId, materialId));
  return { ...row, assignedClassIds: assignments.map(item => item.classId) };
}

export async function listTeacherClasses(teacherUserId: number) {
  const db = await requireDb();
  return db.select().from(readerClasses).where(eq(readerClasses.teacherUserId, teacherUserId)).orderBy(readerClasses.name);
}

export async function approveReadingMaterial(teacherUserId: number, materialId: number) {
  const db = await requireDb();
  const [row] = await db.select({ material: readingMaterials, details: readingMaterialDetails })
    .from(readingMaterials)
    .innerJoin(readingMaterialDetails, eq(readingMaterials.id, readingMaterialDetails.materialId))
    .where(and(eq(readingMaterials.id, materialId), eq(readingMaterials.teacherUserId, teacherUserId)))
    .limit(1);
  if (!row) throw new Error("This reading material is not available to your account or is missing required metadata.");
  if (row.details.lifecycleStatus === "assignable") return row.details;
  const approvedAt = row.details.approvedAt ?? new Date();
  await db.update(readingMaterialDetails).set({ lifecycleStatus: "teacher_approved", approvedByUserId: teacherUserId, approvedAt, assignableAt: null }).where(eq(readingMaterialDetails.materialId, materialId));
  const [details] = await db.select().from(readingMaterialDetails).where(eq(readingMaterialDetails.materialId, materialId)).limit(1);
  if (!details) throw new Error("Could not approve this reading material.");
  return details;
}

export async function makeReadingMaterialAssignable(teacherUserId: number, materialId: number) {
  const db = await requireDb();
  const [row] = await db.select({ material: readingMaterials, details: readingMaterialDetails })
    .from(readingMaterials)
    .innerJoin(readingMaterialDetails, eq(readingMaterials.id, readingMaterialDetails.materialId))
    .where(and(eq(readingMaterials.id, materialId), eq(readingMaterials.teacherUserId, teacherUserId)))
    .limit(1);
  if (!row) throw new Error("This reading material is not available to your account or is missing required metadata.");
  if (row.details.lifecycleStatus === "draft") throw new Error("Approve this reading material before making it assignable.");
  if (row.details.lifecycleStatus !== "assignable") {
    await db.update(readingMaterialDetails).set({ lifecycleStatus: "assignable", assignableAt: new Date() }).where(eq(readingMaterialDetails.materialId, materialId));
  }
  await db.update(readingExercises).set({ approvedAt: new Date() }).where(eq(readingExercises.materialId, materialId));
  const [details] = await db.select().from(readingMaterialDetails).where(eq(readingMaterialDetails.materialId, materialId)).limit(1);
  if (!details) throw new Error("Could not make this reading material assignable.");
  return details;
}

export async function assignReadingMaterialToClasses(teacherUserId: number, materialId: number, classIds: number[]) {
  const db = await requireDb();
  const [row] = await db.select({ material: readingMaterials, details: readingMaterialDetails })
    .from(readingMaterials)
    .innerJoin(readingMaterialDetails, eq(readingMaterials.id, readingMaterialDetails.materialId))
    .where(and(eq(readingMaterials.id, materialId), eq(readingMaterials.teacherUserId, teacherUserId)))
    .limit(1);
  if (!row) throw new Error("This reading material is not available to your account or is missing required metadata.");
  if (row.details.lifecycleStatus !== "assignable") throw new Error("Make this reading material assignable before choosing classes.");
  const classes = await db.select().from(readerClasses).where(and(eq(readerClasses.teacherUserId, teacherUserId), inArray(readerClasses.id, classIds)));
  if (classes.length !== classIds.length) throw new Error("Choose only classes that belong to your teacher account.");
  await db.transaction(async transaction => {
    await transaction.delete(materialAssignments).where(eq(materialAssignments.materialId, materialId));
    await transaction.insert(materialAssignments).values(classes.map(readerClass => ({ classId: readerClass.id, materialId })));
    await transaction.update(readingMaterials).set({ status: "assigned" }).where(eq(readingMaterials.id, materialId));
  });
  return { materialId, assignedClasses: classes.map(readerClass => ({ id: readerClass.id, name: readerClass.name, joinCode: readerClass.joinCode })) };
}

export async function listAssignedMaterialsForChild(childUserId: number) {
  const db = await requireDb();
  return db.select({
    id: readingMaterials.id,
    title: readingMaterials.title,
    readingLevel: readingMaterials.readingLevel,
    sourceText: readingMaterials.sourceText,
    exerciseSet: readingExercises.exerciseSet,
  }).from(childProfiles)
    .innerJoin(classEnrollments, eq(childProfiles.id, classEnrollments.childProfileId))
    .innerJoin(materialAssignments, eq(classEnrollments.classId, materialAssignments.classId))
    .innerJoin(readingMaterials, eq(materialAssignments.materialId, readingMaterials.id))
    .leftJoin(readingExercises, eq(readingMaterials.id, readingExercises.materialId))
    .where(and(eq(childProfiles.userId, childUserId), eq(readingMaterials.status, "assigned")))
    .orderBy(desc(materialAssignments.assignedAt));
}

export async function saveGeneratedExercises(materialId: number, exerciseSet: ExerciseSet, modelName: string) {
  const db = await requireDb();
  await db.insert(readingExercises).values({ materialId, exerciseSet, modelName }).onDuplicateKeyUpdate({ set: { exerciseSet, modelName } });
  const [exercise] = await db.select().from(readingExercises).where(eq(readingExercises.materialId, materialId)).limit(1);
  if (!exercise) throw new Error("Could not save generated exercises.");
  return exercise;
}

export async function saveReadingSession(input: {
  childProfileId: number;
  materialId?: number | null;
  storyTitle: string;
  transcript: string;
  accuracy: number;
  wordsCorrectPerMinute: number;
  durationSeconds: number;
  audioStorageKey?: string | null;
  assessmentMode?: AssessmentMode;
  languageSupport?: ReadingLanguageSupport;
  practiceWords: string[];
  interventions: StoredIntervention[];
  wordStates?: StoredWordState[];
  wordTimings?: StoredWordTiming[];
}) {
  const db = await requireDb();
  await db.insert(readingSessions).values({ ...input, materialId: input.materialId ?? null, audioStorageKey: input.audioStorageKey ?? null, assessmentMode: input.assessmentMode ?? "ASSISTED_PRACTICE", languageSupport: input.languageSupport ?? "STANDARD_ENGLISH", wordStates: input.wordStates ?? [], wordTimings: input.wordTimings ?? [], completed: 1 });
  const [session] = await db.select().from(readingSessions).where(eq(readingSessions.childProfileId, input.childProfileId)).orderBy(desc(readingSessions.id)).limit(1);
  if (!session) throw new Error("Could not save reading session.");
  return session;
}

export async function getSessionById(sessionId: number) {
  const db = await requireDb();
  const [session] = await db.select().from(readingSessions).where(eq(readingSessions.id, sessionId)).limit(1);
  return session;
}

export async function getSessionPlayback(sessionId: number) {
  const session = await getSessionById(sessionId);
  if (!session) return undefined;
  return { session, wordTimings: session.wordTimings ?? [] };
}

export async function getTeacherSessionReview(sessionId: number) {
  const db = await requireDb();
  const [review] = await db.select({ session: readingSessions, childName: childProfiles.displayName, bookBand: childProfiles.bookBand })
    .from(readingSessions)
    .innerJoin(childProfiles, eq(readingSessions.childProfileId, childProfiles.id))
    .where(eq(readingSessions.id, sessionId))
    .limit(1);
  return review;
}

export async function saveTeacherInterventionDecision(sessionId: number, interventionIndex: number, teacherDecision: "confirmed" | "overridden") {
  const db = await requireDb();
  const session = await getSessionById(sessionId);
  if (!session) throw new Error("Reading session not found.");
  const intervention = session.interventions[interventionIndex];
  if (!intervention) throw new Error("Reading moment not found.");
  const interventions = session.interventions.map((item, index) => index === interventionIndex ? { ...item, teacherDecision } : item);
  await db.update(readingSessions).set({ interventions }).where(eq(readingSessions.id, sessionId));
  const [updated] = await db.select().from(readingSessions).where(eq(readingSessions.id, sessionId)).limit(1);
  if (!updated) throw new Error("Could not save the teacher decision.");
  return updated;
}

export async function getAssignedMaterialForChild(childUserId: number, materialId: number) {
  const materials = await listAssignedMaterialsForChild(childUserId);
  return materials.find(material => material.id === materialId);
}

export async function saveQuizAttempt(input: { childProfileId: number; materialId: number; answers: QuizAnswer[]; score: number; totalQuestions: number }) {
  const db = await requireDb();
  await db.insert(quizAttempts).values(input);
  const [attempt] = await db.select().from(quizAttempts).where(and(eq(quizAttempts.childProfileId, input.childProfileId), eq(quizAttempts.materialId, input.materialId))).orderBy(desc(quizAttempts.id)).limit(1);
  if (!attempt) throw new Error("Could not save quiz attempt.");
  return attempt;
}

export async function getQuizHistory(childProfileId: number) {
  const db = await requireDb();
  return db.select().from(quizAttempts).where(eq(quizAttempts.childProfileId, childProfileId)).orderBy(desc(quizAttempts.completedAt)).limit(12);
}

export async function getSchoolBrandingForTeacher(teacherUserId: number) {
  const db = await requireDb();
  const [branding] = await db.select().from(schoolBranding).where(eq(schoolBranding.teacherUserId, teacherUserId)).limit(1);
  return branding ?? { teacherUserId, schoolName: "Reader Leader School", accentColor: "#2563EB", footerLine: "Every reader can grow with practice and encouragement." };
}

export async function saveSchoolBranding(teacherUserId: number, branding: { schoolName: string; accentColor: string; footerLine: string }) {
  const db = await requireDb();
  await db.insert(schoolBranding).values({ teacherUserId, ...branding }).onDuplicateKeyUpdate({ set: branding });
  return getSchoolBrandingForTeacher(teacherUserId);
}

export async function addSessionComment(input: { sessionId: number; teacherUserId: number; comment: string }) {
  const db = await requireDb();
  await db.insert(sessionComments).values(input);
  const [saved] = await db.select().from(sessionComments).where(and(eq(sessionComments.sessionId, input.sessionId), eq(sessionComments.teacherUserId, input.teacherUserId))).orderBy(desc(sessionComments.id)).limit(1);
  if (!saved) throw new Error("Could not save teacher feedback.");
  return saved;
}

export async function getSessionComments(sessionIds: number[]) {
  const db = await requireDb();
  if (!sessionIds.length) return [];
  return db.select().from(sessionComments).where(inArray(sessionComments.sessionId, sessionIds)).orderBy(desc(sessionComments.createdAt));
}

export async function getReportContext(childProfileId: number) {
  const progress = await getChildProgress(childProfileId);
  const db = await requireDb();
  const [teacherLink] = await db.select({ teacherUserId: readerClasses.teacherUserId }).from(classEnrollments).innerJoin(readerClasses, eq(classEnrollments.classId, readerClasses.id)).where(eq(classEnrollments.childProfileId, childProfileId)).limit(1);
  const branding = teacherLink ? await getSchoolBrandingForTeacher(teacherLink.teacherUserId) : { schoolName: "Reader Leader School", accentColor: "#2563EB", footerLine: "Every reader can grow with practice and encouragement." };
  const comments = await getSessionComments(progress.sessions.map(session => session.id));
  return { ...progress, branding, comments };
}

export async function getChildProgress(childProfileId: number) {
  const db = await requireDb();
  const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.id, childProfileId)).limit(1);
  if (!profile) throw new Error("Child profile not found.");
  const sessions = await db.select().from(readingSessions).where(eq(readingSessions.childProfileId, childProfileId)).orderBy(desc(readingSessions.createdAt)).limit(36);
  const total = sessions.length || 1;
  const averageAccuracy = Math.round(sessions.reduce((sum, session) => sum + session.accuracy, 0) / total);
  const averageWcpm = Math.round(sessions.reduce((sum, session) => sum + session.wordsCorrectPerMinute, 0) / total);
  const practiceWords = Array.from(new Set(sessions.flatMap(session => session.practiceWords))).slice(0, 4);
  return {
    profile,
    sessions,
    quizHistory: await getQuizHistory(childProfileId),
    assessmentTrend: buildMonthlyAssessmentTrend(sessions),
    minutesReadThisWeek: minutesReadThisWeek(sessions),
    learnerSettings: await getLearnerReadingSettings(childProfileId),
    summary: { sessionsCompleted: sessions.length, averageAccuracy, averageWcpm, practiceWords },
  };
}

export async function getTeacherDashboard(teacherUserId: number) {
  const db = await requireDb();
  const classes = await db.select().from(readerClasses).where(eq(readerClasses.teacherUserId, teacherUserId));
  const termPresets = await listTeacherTermPresets(teacherUserId);
  if (!classes.length) return { classes: [], pupils: [], needsReview: [], materials: [], recentSessions: [], classAssessmentTrend: [], termPresets, branding: await getSchoolBrandingForTeacher(teacherUserId) };
  const classIds = classes.map(readerClass => readerClass.id);
  const enrolled = await db.select({ childProfileId: classEnrollments.childProfileId, classId: classEnrollments.classId, displayName: childProfiles.displayName, bookBand: childProfiles.bookBand })
    .from(classEnrollments).innerJoin(childProfiles, eq(classEnrollments.childProfileId, childProfiles.id)).where(inArray(classEnrollments.classId, classIds));
  const profileIds = enrolled.map(row => row.childProfileId);
  const sessions = profileIds.length ? await db.select().from(readingSessions).where(inArray(readingSessions.childProfileId, profileIds)).orderBy(desc(readingSessions.createdAt)) : [];
  const settingsRows = profileIds.length ? await db.select().from(learnerReadingSettings).where(inArray(learnerReadingSettings.childProfileId, profileIds)) : [];
  const pupils = enrolled.map(pupil => {
    const pupilSessions = sessions.filter(session => session.childProfileId === pupil.childProfileId);
    const count = pupilSessions.length || 1;
    const settings = settingsRows.find(item => item.childProfileId === pupil.childProfileId) ?? defaultLearnerSettings(pupil.childProfileId);
    return { ...pupil, className: classes.find(readerClass => readerClass.id === pupil.classId)?.name ?? "Class", sessionCount: pupilSessions.length, accuracy: Math.round(pupilSessions.reduce((sum, session) => sum + session.accuracy, 0) / count), wcpm: Math.round(pupilSessions.reduce((sum, session) => sum + session.wordsCorrectPerMinute, 0) / count), settings };
  });
  const classSummaries = classes.map(readerClass => {
    const classPupils = pupils.filter(pupil => pupil.classId === readerClass.id);
    const classSessions = sessions.filter(session => classPupils.some(pupil => pupil.childProfileId === session.childProfileId));
    const trackedPupils = classPupils.filter(pupil => pupil.sessionCount > 0);
    const pupilCount = trackedPupils.length || 1;
    return { ...readerClass, pupilCount: classPupils.length, averageAccuracy: Math.round(trackedPupils.reduce((sum, pupil) => sum + pupil.accuracy, 0) / pupilCount), averageWcpm: Math.round(trackedPupils.reduce((sum, pupil) => sum + pupil.wcpm, 0) / pupilCount), assessmentTrend: buildMonthlyAssessmentTrend(classSessions) };
  });
  const needsReview = sessions.flatMap(session => session.interventions.filter(intervention => intervention.action === "teacher_review").map(intervention => ({ sessionId: session.id, childProfileId: session.childProfileId, storyTitle: session.storyTitle, ...intervention }))).slice(0, 5);
  const materials = await listTeacherMaterials(teacherUserId);
  const comments = await getSessionComments(sessions.map(session => session.id));
  const recentSessions = sessions.slice(0, 8).map(session => ({ ...session, childName: enrolled.find(pupil => pupil.childProfileId === session.childProfileId)?.displayName ?? "Reader", comments: comments.filter(comment => comment.sessionId === session.id) }));
  return { classes: classSummaries, pupils, needsReview, materials, recentSessions, classAssessmentTrend: buildMonthlyAssessmentTrend(sessions), termPresets, branding: await getSchoolBrandingForTeacher(teacherUserId) };
}

export async function getTeacherMonthlyTrendExport(teacherUserId: number, classId?: number, range?: TrendDateRange) {
  if (!isValidTrendDateRange(range)) throw new Error("Choose an end date that is on or after the start date.");
  const db = await requireDb();
  const classes = await db.select().from(readerClasses).where(eq(readerClasses.teacherUserId, teacherUserId));
  const selectedClass = classId ? classes.find(readerClass => readerClass.id === classId) : undefined;
  if (classId && !selectedClass) throw new Error("This class is not available to your account.");
  const classIds = selectedClass ? [selectedClass.id] : classes.map(readerClass => readerClass.id);
  const enrolled = classIds.length ? await db.select({ childProfileId: classEnrollments.childProfileId }).from(classEnrollments).where(inArray(classEnrollments.classId, classIds)) : [];
  const profileIds = enrolled.map(row => row.childProfileId);
  const sessions = profileIds.length ? await db.select().from(readingSessions).where(inArray(readingSessions.childProfileId, profileIds)) : [];
  return { className: selectedClass?.name ?? "All teacher classes", points: buildMonthlyAssessmentTrend(sessions, range) };
}

export async function getHomePracticeChecklist(parentUserId: number, childProfileId: number, now = new Date()) {
  const db = await requireDb();
  const checklistDate = practiceChecklistDate(now);
  const [checklist] = await db.select().from(homePracticeChecklists).where(and(eq(homePracticeChecklists.parentUserId, parentUserId), eq(homePracticeChecklists.childProfileId, childProfileId), eq(homePracticeChecklists.checklistDate, checklistDate))).limit(1);
  return checklist ?? { parentUserId, childProfileId, checklistDate, completedSteps: normalisePracticeSteps([]), completedAt: null, updatedAt: now };
}

export async function saveHomePracticeChecklist(parentUserId: number, childProfileId: number, completedSteps: boolean[], now = new Date()) {
  const db = await requireDb();
  const checklistDate = practiceChecklistDate(now);
  const steps = normalisePracticeSteps(completedSteps);
  const completed = isPracticeChecklistComplete(steps);
  const [existing] = await db.select().from(homePracticeChecklists).where(and(eq(homePracticeChecklists.parentUserId, parentUserId), eq(homePracticeChecklists.childProfileId, childProfileId), eq(homePracticeChecklists.checklistDate, checklistDate))).limit(1);
  if (existing) await db.update(homePracticeChecklists).set({ completedSteps: steps, completedAt: completed ? existing.completedAt ?? now : null }).where(eq(homePracticeChecklists.id, existing.id));
  else await db.insert(homePracticeChecklists).values({ parentUserId, childProfileId, checklistDate, completedSteps: steps, completedAt: completed ? now : null });
  const [checklist] = await db.select().from(homePracticeChecklists).where(and(eq(homePracticeChecklists.parentUserId, parentUserId), eq(homePracticeChecklists.childProfileId, childProfileId), eq(homePracticeChecklists.checklistDate, checklistDate))).limit(1);
  if (!checklist) throw new Error("Could not save home-practice progress.");
  let reminderCreated = false;
  if (completed) {
    const [existingReminder] = await db.select({ id: parentReminders.id }).from(parentReminders).where(eq(parentReminders.checklistId, checklist.id)).limit(1);
    if (!existingReminder) {
      const [profile] = await db.select({ displayName: childProfiles.displayName }).from(childProfiles).where(eq(childProfiles.id, childProfileId)).limit(1);
      await db.insert(parentReminders).values({ parentUserId, childProfileId, checklistId: checklist.id, title: "Home practice complete", message: `${profile?.displayName ?? "Your reader"} completed today’s three home-practice steps. Celebrate the calm, focused effort.` });
      reminderCreated = true;
    }
  }
  return { checklist, reminderCreated };
}

export type ParentReminderFilter = { childProfileId?: number; startDate?: string; endDate?: string };

export async function listParentReminders(parentUserId: number, filter?: ParentReminderFilter) {
  if (!isValidTrendDateRange(filter)) throw new Error("Choose an end date on or after the start date.");
  const db = await requireDb();
  const clauses = [eq(parentReminders.parentUserId, parentUserId)];
  if (filter?.childProfileId) clauses.push(eq(parentReminders.childProfileId, filter.childProfileId));
  if (filter?.startDate) clauses.push(gte(parentReminders.createdAt, new Date(`${filter.startDate}T00:00:00.000Z`)));
  if (filter?.endDate) clauses.push(lte(parentReminders.createdAt, new Date(`${filter.endDate}T23:59:59.999Z`)));
  return db.select({ id: parentReminders.id, childProfileId: parentReminders.childProfileId, childName: childProfiles.displayName, title: parentReminders.title, message: parentReminders.message, status: parentReminders.status, createdAt: parentReminders.createdAt, readAt: parentReminders.readAt })
    .from(parentReminders).innerJoin(childProfiles, eq(parentReminders.childProfileId, childProfiles.id)).where(and(...clauses)).orderBy(desc(parentReminders.createdAt)).limit(48);
}

export async function getParentUnreadReminderCount(parentUserId: number) {
  const db = await requireDb();
  const [result] = await db.select({ total: count() }).from(parentReminders).where(and(eq(parentReminders.parentUserId, parentUserId), eq(parentReminders.status, "unread")));
  return Number(result?.total ?? 0);
}

export async function markParentReminderRead(parentUserId: number, reminderId: number) {
  const db = await requireDb();
  await db.update(parentReminders).set({ status: "read", readAt: new Date() }).where(and(eq(parentReminders.id, reminderId), eq(parentReminders.parentUserId, parentUserId)));
}

export async function markAllParentRemindersRead(parentUserId: number) {
  const db = await requireDb();
  const unread = await db.select({ id: parentReminders.id }).from(parentReminders).where(and(eq(parentReminders.parentUserId, parentUserId), eq(parentReminders.status, "unread")));
  if (unread.length) await db.update(parentReminders).set({ status: "read", readAt: new Date() }).where(and(eq(parentReminders.parentUserId, parentUserId), eq(parentReminders.status, "unread")));
  return { markedRead: unread.length };
}

export async function getParentDashboard(parentUserId: number) {
  const db = await requireDb();
  const children = await db.select({ childProfileId: childProfiles.id, displayName: childProfiles.displayName, bookBand: childProfiles.bookBand })
    .from(familyLinks).innerJoin(childProfiles, eq(familyLinks.childProfileId, childProfiles.id)).where(eq(familyLinks.parentUserId, parentUserId));
  const progress = await Promise.all(children.map(async child => ({ ...child, ...(await getChildProgress(child.childProfileId)), practiceChecklist: await getHomePracticeChecklist(parentUserId, child.childProfileId) })));
  const reminders = await listParentReminders(parentUserId);
  return { children: progress, reminders, unreadReminderCount: await getParentUnreadReminderCount(parentUserId) };
}

/** Creates a clearly labelled cohort only when an administrator requests it from the dashboard. */
export async function seedDemoCohort(adminUserId: number) {
  const db = await requireDb();
  const ensureUser = async (openId: string, name: string, role: "child" | "parent") => {
    await db.insert(users).values({ openId, name, loginMethod: "reader-leader-demo", role }).onDuplicateKeyUpdate({ set: { name, role } });
    const [user] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    if (!user) throw new Error("Could not create a demo account.");
    return user;
  };

  const [existingClass] = await db.select().from(readerClasses).where(and(eq(readerClasses.teacherUserId, adminUserId), eq(readerClasses.joinCode, "DEMO-READ"))).limit(1);
  const readerClass = existingClass ?? (await (async () => {
    await db.insert(readerClasses).values({ teacherUserId: adminUserId, name: "Reader Leader Demo Class", joinCode: "DEMO-READ" });
    const [created] = await db.select().from(readerClasses).where(and(eq(readerClasses.teacherUserId, adminUserId), eq(readerClasses.joinCode, "DEMO-READ"))).limit(1);
    if (!created) throw new Error("Could not create the demo class.");
    return created;
  })());

  const aminaUser = await ensureUser("reader-leader-demo-amina", "Amina Roe (Demo)", "child");
  const leoUser = await ensureUser("reader-leader-demo-leo", "Leo Davies (Demo)", "child");
  const parentUser = await ensureUser("reader-leader-demo-parent", "Amina’s Parent (Demo)", "parent");

  const ensureProfile = async (userId: number, displayName: string, bookBand: string, familyCode: string) => {
    await db.insert(childProfiles).values({ userId, displayName, bookBand, familyCode }).onDuplicateKeyUpdate({ set: { displayName, bookBand, familyCode } });
    const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.userId, userId)).limit(1);
    if (!profile) throw new Error("Could not create a demo reading profile.");
    return profile;
  };
  const amina = await ensureProfile(aminaUser.id, "Amina Roe", "Level 3 · Sky Blue", "FAMILY-AMINA");
  const leo = await ensureProfile(leoUser.id, "Leo Davies", "Level 4 · Gold", "FAMILY-LEO");
  await db.insert(classEnrollments).values([{ classId: readerClass.id, childProfileId: amina.id }, { classId: readerClass.id, childProfileId: leo.id }]).onDuplicateKeyUpdate({ set: { classId: readerClass.id } });
  await db.insert(familyLinks).values({ parentUserId: parentUser.id, childProfileId: amina.id }).onDuplicateKeyUpdate({ set: { parentUserId: parentUser.id } });

  const [existingSession] = await db.select({ id: readingSessions.id }).from(readingSessions).where(eq(readingSessions.childProfileId, amina.id)).limit(1);
  if (!existingSession) {
    await db.insert(readingSessions).values([
      { childProfileId: amina.id, storyTitle: "The Moonlight Kite", transcript: "Mina found a bright kite caught in the tall grass.", accuracy: 91, wordsCorrectPerMinute: 108, durationSeconds: 92, completed: 1, practiceWords: ["glimmered", "gentle"], interventions: [{ word: "glimmered", action: "teacher_review", note: "Possible pronunciation variation — the coach stayed silent for teacher review." }], wordStates: [] },
      { childProfileId: leo.id, storyTitle: "Rainy-Day Robot", transcript: "Rain tapped on Zuri's window all afternoon.", accuracy: 95, wordsCorrectPerMinute: 116, durationSeconds: 84, completed: 1, practiceWords: ["afternoon"], interventions: [], wordStates: [] },
    ]);
  }
  return { readerClass, childProfiles: [amina, leo], demoParentOpenId: parentUser.openId };
}

/** Provisions the three explicitly labelled local demo identities on first sign-in. */
export async function provisionLocalDemoCohort() {
  const db = await requireDb();
  const ensureUser = async (openId: string, name: string, role: "child" | "teacher" | "parent") => {
    await db.insert(users).values({ openId, name, loginMethod: "local-demo", role }).onDuplicateKeyUpdate({ set: { name, role, loginMethod: "local-demo" } });
    const [user] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    if (!user) throw new Error("Could not prepare the local demo account.");
    return user;
  };
  const teacher = await ensureUser("reader-leader-local-teacher2", "Ms Kelly", "teacher");
  const child = await ensureUser("reader-leader-local-child1", "Amina Roe", "child");
  const parent = await ensureUser("reader-leader-local-parent3", "Amina’s Parent", "parent");
  await db.insert(childProfiles).values({ userId: child.id, displayName: "Amina Roe", bookBand: "Level 3 · Sky Blue", familyCode: "FAMILY-AMINA" }).onDuplicateKeyUpdate({ set: { displayName: "Amina Roe", bookBand: "Level 3 · Sky Blue" } });
  const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.userId, child.id)).limit(1);
  if (!profile) throw new Error("Could not prepare the child demo profile.");
  await db.insert(readerClasses).values({ teacherUserId: teacher.id, name: "Ms Kelly’s Reading Class", joinCode: "CLASS-READ" }).onDuplicateKeyUpdate({ set: { name: "Ms Kelly’s Reading Class" } });
  const [readerClass] = await db.select().from(readerClasses).where(eq(readerClasses.teacherUserId, teacher.id)).limit(1);
  if (!readerClass) throw new Error("Could not prepare the teacher demo class.");
  await db.insert(classEnrollments).values({ classId: readerClass.id, childProfileId: profile.id }).onDuplicateKeyUpdate({ set: { classId: readerClass.id } });
  await db.insert(familyLinks).values({ parentUserId: parent.id, childProfileId: profile.id }).onDuplicateKeyUpdate({ set: { parentUserId: parent.id } });
  // Keep the local demo child on Irish English support so live reads use the existing accent handling.
  await db.insert(learnerReadingSettings).values({ childProfileId: profile.id, defaultReadingMode: "ASSISTED_PRACTICE", targetWcpm: 112, languageSupport: "IRISH_ENGLISH_SUPPORT" }).onDuplicateKeyUpdate({ set: { languageSupport: "IRISH_ENGLISH_SUPPORT" } });
  const [existingMaterial] = await db.select().from(readingMaterials).where(and(eq(readingMaterials.teacherUserId, teacher.id), eq(readingMaterials.title, "The Lantern in the Garden"))).limit(1);
  const material = existingMaterial ?? (await (async () => {
    await db.insert(readingMaterials).values({ teacherUserId: teacher.id, title: "The Lantern in the Garden", readingLevel: "Level 3 · Sky Blue", sourceText: "Amina carried a little lantern into the garden at dusk. The light made golden circles on the path. Near the tall gate, she saw a hedgehog sniffing beside the flowers. Amina stood very still, then watched it hurry safely under the hedge.", status: "assigned" });
    const [created] = await db.select().from(readingMaterials).where(and(eq(readingMaterials.teacherUserId, teacher.id), eq(readingMaterials.title, "The Lantern in the Garden"))).limit(1);
    if (!created) throw new Error("Could not prepare the assigned demo passage.");
    return created;
  })());
  const exerciseSet: ExerciseSet = { vocabulary: [{ word: "lantern", childFriendlyMeaning: "a small lamp you can carry" }, { word: "dusk", childFriendlyMeaning: "the time when daylight is fading" }, { word: "hedgehog", childFriendlyMeaning: "a small animal with tiny spines" }], questions: [{ prompt: "What did Amina carry into the garden?", options: ["A lantern", "A kite", "A basket"], answer: "A lantern", explanation: "The story says Amina carried a little lantern." }, { prompt: "What animal did Amina see?", options: ["A hedgehog", "A fox", "A rabbit"], answer: "A hedgehog", explanation: "A hedgehog was sniffing beside the flowers." }, { prompt: "How did Amina help the animal?", options: ["She stood still", "She chased it", "She picked it up"], answer: "She stood still", explanation: "Amina stood very still and watched it safely." }], activity: "Draw the golden circles the lantern made, then tell someone which detail you remember." };
  await db.insert(readingExercises).values({ materialId: material.id, exerciseSet, modelName: "teacher-demo", approvedAt: new Date() }).onDuplicateKeyUpdate({ set: { exerciseSet, approvedAt: new Date() } });
  await db.update(readingMaterials).set({ status: "assigned" }).where(eq(readingMaterials.id, material.id));
  await db.insert(materialAssignments).values({ classId: readerClass.id, materialId: material.id }).onDuplicateKeyUpdate({ set: { materialId: material.id } });
  const [existingSession] = await db.select({ id: readingSessions.id }).from(readingSessions).where(eq(readingSessions.childProfileId, profile.id)).limit(1);
  if (!existingSession) await db.insert(readingSessions).values({ childProfileId: profile.id, materialId: material.id, storyTitle: "The Lantern in the Garden", transcript: "Amina carried a little lantern into the garden at dusk.", accuracy: 91, wordsCorrectPerMinute: 108, durationSeconds: 72, completed: 1, practiceWords: ["lantern", "hedgehog"], interventions: [{ word: "hedgehog", action: "teacher_review", note: "Possible pronunciation variation — the coach stayed silent for teacher review." }], wordStates: [] });
  const accentShowcaseTitle = "Accent Showcase — The Thin Path";
  const [accentShowcaseSeed] = await db.select({ id: readingSessions.id }).from(readingSessions).where(and(eq(readingSessions.childProfileId, profile.id), eq(readingSessions.storyTitle, accentShowcaseTitle))).limit(1);
  if (!accentShowcaseSeed) {
    const expectedText = "The thin path was caught";
    const transcript = "The tin pat was cot";
    const durationSeconds = 30;
    const analysis = analyseReadingText(expectedText, transcript, durationSeconds, "ASSISTED_PRACTICE", undefined, "IRISH_ENGLISH_SUPPORT");
    const interventions = analysis.events.filter(event => event.eventType !== "correct").slice(0, 5).map(event => ({ word: event.expectedWord, eventType: event.eventType, heardWord: event.recognisedWord ?? undefined, provisionalIrishEnglish: event.provisionalIrishEnglish, action: event.action === "teacher_review" ? "teacher_review" as const : event.action === "stay_silent" ? "stay_silent" as const : "prompt" as const, note: event.eventType === "dialect_variation" ? "Irish English variation provisionally accepted — please confirm this reading moment from the saved audio." : event.action === "teacher_review" ? "Possible pronunciation variation — flagged for teacher review. The coach stayed silent." : "Try that word again when you are ready." }));
    await db.insert(readingSessions).values({ childProfileId: profile.id, storyTitle: accentShowcaseTitle, transcript: analysis.transcript, accuracy: analysis.accuracy, wordsCorrectPerMinute: analysis.pace, durationSeconds: analysis.durationSeconds, completed: 1, assessmentMode: analysis.mode, languageSupport: "IRISH_ENGLISH_SUPPORT", practiceWords: analysis.practiceWords, interventions, wordStates: analysis.wordStates });
  }
  const [historicalTrendSeed] = await db.select({ id: readingSessions.id }).from(readingSessions).where(and(eq(readingSessions.childProfileId, profile.id), eq(readingSessions.storyTitle, "Garden Walk · June"))).limit(1);
  if (!historicalTrendSeed) await db.insert(readingSessions).values([
    { childProfileId: profile.id, materialId: material.id, storyTitle: "Garden Walk · June", transcript: "Amina followed the path through the garden.", accuracy: 82, wordsCorrectPerMinute: 88, durationSeconds: 95, completed: 1, assessmentMode: "MONTHLY_ASSESSMENT", practiceWords: ["followed"], interventions: [], wordStates: [], wordTimings: [], createdAt: new Date("2026-06-03T10:00:00Z") },
    { childProfileId: profile.id, materialId: material.id, storyTitle: "Garden Walk · July", transcript: "Amina followed the path through the quiet garden.", accuracy: 87, wordsCorrectPerMinute: 96, durationSeconds: 91, completed: 1, assessmentMode: "MONTHLY_ASSESSMENT", practiceWords: ["quiet"], interventions: [], wordStates: [], wordTimings: [], createdAt: new Date("2026-07-03T10:00:00Z") },
    { childProfileId: profile.id, materialId: material.id, storyTitle: "Garden Walk · August", transcript: "Amina followed the bright garden path with confidence.", accuracy: 92, wordsCorrectPerMinute: 104, durationSeconds: 85, completed: 1, assessmentMode: "MONTHLY_ASSESSMENT", practiceWords: ["confidence"], interventions: [], wordStates: [], wordTimings: [], createdAt: new Date("2026-08-03T10:00:00Z") },
  ]);
  const [playbackFixture] = await db.select({ id: readingSessions.id }).from(readingSessions).where(and(eq(readingSessions.childProfileId, profile.id), eq(readingSessions.storyTitle, "Word-linked playback technical check"))).limit(1);
  if (!playbackFixture) {
    const audio = await storagePut("demo-playback/word-timing-check.wav", createDemoPlaybackTone(), "audio/wav");
    await db.insert(readingSessions).values({ childProfileId: profile.id, materialId: material.id, storyTitle: "Word-linked playback technical check", transcript: "Amina reads steadily", accuracy: 100, wordsCorrectPerMinute: 100, durationSeconds: 3, audioStorageKey: audio.key, completed: 1, assessmentMode: "ASSISTED_PRACTICE", practiceWords: [], interventions: [], wordStates: [], wordTimings: [{ id: "spoken-0", text: "Amina", startMs: 0, endMs: 1000 }, { id: "spoken-1", text: "reads", startMs: 1000, endMs: 2000 }, { id: "spoken-2", text: "steadily", startMs: 2000, endMs: 3000 }] });
  }
  const [existingQuizAttempt] = await db.select({ id: quizAttempts.id }).from(quizAttempts).where(and(eq(quizAttempts.childProfileId, profile.id), eq(quizAttempts.materialId, material.id))).limit(1);
  if (!existingQuizAttempt) await db.insert(quizAttempts).values({ childProfileId: profile.id, materialId: material.id, score: 2, totalQuestions: 3, answers: [{ questionIndex: 0, selectedAnswer: "A lantern", correct: true }, { questionIndex: 1, selectedAnswer: "A rabbit", correct: false }, { questionIndex: 2, selectedAnswer: "She stood still", correct: true }] });
  return { child, teacher, parent, profile, readerClass };
}
