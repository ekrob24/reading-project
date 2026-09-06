/**
 * Self-owned server-side transcription via the OpenAI Whisper API.
 *
 * Drop-in replacement for the Manus Forge transcription: same return shape
 * (Whisper verbose_json), so alignment, word timings and the running record
 * downstream are unchanged. Takes audio bytes directly, so it needs no managed
 * storage to transcribe. Requires one env var: OPENAI_API_KEY.
 */
import type { TranscriptionResponse, TranscriptionError } from "./_core/voiceTranscription";

export type TranscribeBytesOptions = {
  audio: Uint8Array;
  mimeType: string;
  language?: string;
  prompt?: string;
};

const extensionFor = (mimeType: string) =>
  mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : mimeType.includes("mp3") || mimeType.includes("mpeg") ? "mp3" : "webm";

export async function transcribeAudio(options: TranscribeBytesOptions): Promise<TranscriptionResponse | TranscriptionError> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { error: "Transcription service is not configured", code: "SERVICE_ERROR", details: "OPENAI_API_KEY is not set" };
  }

  const sizeMB = options.audio.byteLength / (1024 * 1024);
  if (options.audio.byteLength === 0) return { error: "Empty audio", code: "INVALID_FORMAT", details: "No audio bytes supplied" };
  if (sizeMB > 25) return { error: "Audio file exceeds maximum size limit", code: "FILE_TOO_LARGE", details: `File is ${sizeMB.toFixed(2)}MB, max 25MB` };

  const form = new FormData();
  // Blob wants a concrete ArrayBuffer; a Uint8Array parameter is Uint8Array<ArrayBufferLike>, which fails strict typing.
  const filePart = options.audio.buffer.slice(options.audio.byteOffset, options.audio.byteOffset + options.audio.byteLength) as ArrayBuffer;
  form.append("file", new Blob([filePart], { type: options.mimeType }), `audio.${extensionFor(options.mimeType)}`);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  if (options.language) form.append("language", options.language);
  if (options.prompt) form.append("prompt", options.prompt);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { error: "Transcription request failed", code: "TRANSCRIPTION_FAILED", details: `HTTP ${response.status}: ${detail.slice(0, 300)}` };
    }
    return (await response.json()) as TranscriptionResponse;
  } catch (error) {
    return { error: "Transcription request failed", code: "SERVICE_ERROR", details: error instanceof Error ? error.message : "Unknown error" };
  }
}
