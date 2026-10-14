import type { AppSettings } from "./types";
import { isOfficialOpenAI } from "./text-helper";

export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const TRANSCRIPTION_ENDPOINT =
  "https://api.openai.com/v1/audio/transcriptions";
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/** Never forward a compatible service's credential to OpenAI. */
export function voiceApiKey(settings: AppSettings): string {
  const helper = settings.textHelper;
  if (
    helper.provider === "openai" &&
    isOfficialOpenAI(helper.baseUrl || "https://api.openai.com/v1") &&
    helper.apiKey.trim()
  ) {
    return helper.apiKey.trim();
  }
  if (
    isOfficialOpenAI(settings.openai.endpoint) &&
    settings.openai.apiKey.trim()
  ) {
    return settings.openai.apiKey.trim();
  }
  throw new Error(
    "Add an OpenAI key in Settings under the text helper or OpenAI Decisions to use voice tasks.",
  );
}

export async function transcribeAudio(
  audio: Blob,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey.trim())
    throw new Error("An OpenAI API key is required for voice tasks.");
  if (!audio.size)
    throw new Error("No audio was recorded. Try recording again.");
  if (audio.size > MAX_AUDIO_BYTES)
    throw new Error("The recording is too large. Try a shorter voice task.");
  const form = new FormData();
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("response_format", "json");
  form.append(
    "file",
    audio,
    audio.type.includes("mp4") ? "voice-task.mp4" : "voice-task.webm",
  );
  const response = await fetch(TRANSCRIPTION_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    body: form,
    signal,
  });
  if (!response.ok) {
    // Do not expose a server's arbitrary body or the recording in UI diagnostics.
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "OpenAI rejected the key. Check the OpenAI key in Settings.",
      );
    if (response.status === 429)
      throw new Error(
        "OpenAI is rate limiting transcription or your API quota is exhausted. Try again later.",
      );
    throw new Error(
      `Voice transcription failed (HTTP ${response.status}). You can retry the recording.`,
    );
  }
  const json = await response.json();
  if (typeof json?.text !== "string" || !json.text.trim())
    throw new Error("No speech was recognized. Try recording again.");
  const text = json.text.trim();
  if (text.length > 12000)
    throw new Error(
      "The transcript is too long for a voice task. Try a shorter recording.",
    );
  return text;
}
