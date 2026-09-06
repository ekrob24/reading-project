import { z } from "zod";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { systemRouter } from "./_core/systemRouter";
import { transcribeAudio } from "./_core/voiceTranscription";
import { publicProcedure, router } from "./_core/trpc";
import { analyseReadingText } from "./reader";
import { readerLeaderRouter } from "./routers/readerLeader";
import { verifyDemoCredentials } from "./demoAuth";
import { provisionLocalDemoCohort } from "./readerDb";
import { storageGetSignedUrl, storagePut } from "./storage";

const MAX_AUDIO_BYTES = 4_500_000;

function safeAudioMimeType(mimeType?: string): string {
  if (mimeType?.startsWith("audio/webm")) return "audio/webm";
  if (mimeType?.startsWith("audio/ogg")) return "audio/ogg";
  if (mimeType?.startsWith("audio/wav")) return "audio/wav";
  return "audio/webm";
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      ctx.res.clearCookie(COOKIE_NAME, getSessionCookieOptions(ctx.req));
      return { success: true } as const;
    }),
  }),
  demoAccess: router({
    verify: publicProcedure.input(z.object({ username: z.string().min(1).max(32), password: z.string().min(1).max(128) })).query(({ input }) => {
      const account = verifyDemoCredentials(input.username, input.password);
      if (!account) throw new TRPCError({ code: "UNAUTHORIZED", message: "That demo username or password does not match." });
      return { username: account.username, role: account.role, name: account.name };
    }),
    login: publicProcedure.input(z.object({ username: z.string().min(1).max(32), password: z.string().min(1).max(128) })).mutation(async ({ ctx, input }) => {
      const account = verifyDemoCredentials(input.username, input.password);
      if (!account) throw new TRPCError({ code: "UNAUTHORIZED", message: "That demo username or password does not match." });
      await provisionLocalDemoCohort();
      const sessionToken = await sdk.createSessionToken(account.openId, { name: account.name, expiresInMs: ONE_YEAR_MS });
      ctx.res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(ctx.req), maxAge: ONE_YEAR_MS });
      return { success: true, role: account.role, name: account.name };
    }),
  }),
  reading: router({
    /** Public, clearly labelled guided-demo route; authenticated sessions use readerLeader.sessions.save. */
    processRecording: publicProcedure.input(z.object({
      audioBase64: z.string().min(1).max(6_000_000),
      audioMime: z.string().optional(),
      expectedText: z.string().min(20).max(8_000),
      durationSeconds: z.number().min(1).max(600),
    })).mutation(async ({ input }) => {
      const bytes = Buffer.from(input.audioBase64, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("Keep this practice recording under 4.5 MB and try again.");
      const mimeType = safeAudioMimeType(input.audioMime);
      const extension = mimeType.split("/")[1] ?? "webm";
      const { key } = await storagePut(`reader-leader/recordings/demo-${Date.now()}.${extension}`, bytes, mimeType);
      const transcription = await (await import("../whisperTranscription")).transcribeAudio({ audio: bytes, mimeType, language: "en", prompt: transcriptionPrompt });
      if ("error" in transcription) throw new Error(transcription.error);
      return { ...analyseReadingText(input.expectedText, transcription.text, input.durationSeconds), transcriptionStatus: "transcribed" as const };
    }),
  }),
  readerLeader: readerLeaderRouter,
});

export type AppRouter = typeof appRouter;
