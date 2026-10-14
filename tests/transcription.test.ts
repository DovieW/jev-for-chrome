import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AUDIO_BYTES,
  transcribeAudio,
  voiceApiKey,
} from "../src/shared/transcription";
import { DEFAULT_SETTINGS } from "../src/shared/types";

const settings = () => structuredClone(DEFAULT_SETTINGS);
afterEach(() => vi.unstubAllGlobals());
describe("Voice transcription credentials", () => {
  it("reuses the official OpenAI helper key, then the Decisions key", () => {
    const config = settings();
    config.openai.apiKey = "dummy-decisions";
    config.textHelper = {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6-luna",
      apiKey: "dummy-helper",
    };
    expect(voiceApiKey(config)).toBe("dummy-helper");
    config.textHelper.apiKey = "";
    expect(voiceApiKey(config)).toBe("dummy-decisions");
  });
  it("does not forward a third-party or lookalike-host key to OpenAI", () => {
    const config = settings();
    config.textHelper.apiKey = "dummy-router";
    expect(() => voiceApiKey(config)).toThrow(/Add an OpenAI key/);
    config.textHelper.provider = "openai";
    config.textHelper.baseUrl = "https://api.openai.com.evil.example/v1";
    config.openai.apiKey = "dummy-compatible";
    config.openai.endpoint = "https://compatible.example/decisions";
    expect(() => voiceApiKey(config)).toThrow(/Add an OpenAI key/);
  });
});
describe("Voice transcription upload", () => {
  it("sends recorded bytes with the requested model, filename, and JSON response format", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ text: "  Open my inbox  " }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const audio = new Blob(["recorded audio"], {
      type: "audio/webm;codecs=opus",
    });
    const controller = new AbortController();
    expect(
      await transcribeAudio(audio, "dummy-openai", controller.signal),
    ).toBe("Open my inbox");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.headers).toEqual({ Authorization: "Bearer dummy-openai" });
    expect(init.signal).toBe(controller.signal);
    expect(init.body.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(init.body.get("response_format")).toBe("json");
    expect(init.body.get("file").name).toBe("voice-task.webm");
    expect(await init.body.get("file").text()).toBe("recorded audio");
  });
  it.each(["", "   ", undefined, 42])(
    "rejects an empty or malformed transcript (%s)",
    async (text) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text }) }),
      );
      await expect(
        transcribeAudio(new Blob(["audio"]), "dummy"),
      ).rejects.toThrow(/No speech/);
    },
  );
  it("rejects empty and oversized audio before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(new Blob(), "dummy")).rejects.toThrow(
      /No audio/,
    );
    await expect(
      transcribeAudio(new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)]), "dummy"),
    ).rejects.toThrow(/too large/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reports provider errors without exposing response bodies or retrying uploads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(new Blob(["audio"]), "dummy")).rejects.toThrow(
      /OpenAI rejected the key/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
