import { transcribeAudio } from "../shared/transcription";
import type { VoiceAction, VoiceState } from "./types";

let tabId: number | undefined;
let state: VoiceState = { status: "closed" };
let generation = 0;
let sessionId = "";
let stream: MediaStream | undefined;
let audioContext: AudioContext | undefined;
let recorder: MediaRecorder | undefined;
let recording: Promise<Blob> | undefined;
let audio: Blob | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let abort: AbortController | undefined;

async function publish(next: VoiceState) {
  state = next;
  if (tabId === undefined) return;
  const result = await chrome.runtime
    .sendMessage({ type: "VOICE_STATE", tabId, sessionId, state })
    .catch(() => undefined);
  // The source tab disappeared or navigated. Never keep recording without its visible panel.
  if (result?.success !== true && next.status !== "closed") cancel();
}
function releaseMicrophone() {
  clearInterval(timer);
  timer = undefined;
  if (recorder?.state === "recording") recorder.stop();
  recorder = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  void audioContext?.close().catch(() => undefined);
  audioContext = undefined;
}
function cancel() {
  generation++;
  abort?.abort();
  abort = undefined;
  releaseMicrophone();
  audio = undefined;
  recording = undefined;
  void publish({ status: "closed" });
  tabId = undefined;
}
async function getKey(): Promise<string> {
  const result = await chrome.runtime.sendMessage({ type: "VOICE_GET_KEY" });
  if (!result?.success)
    throw new Error(result?.error || "Could not load the OpenAI key.");
  return result.apiKey;
}
async function start(sourceTabId: number) {
  cancel();
  tabId = sourceTabId;
  sessionId = crypto.randomUUID();
  const token = generation;
  await publish({ status: "initializing" });
  try {
    await getKey();
  } catch (error) {
    if (token === generation)
      await publish({ status: "error", error: (error as Error).message });
    return;
  }
  if (token !== generation) return;
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (token !== generation) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = media;
    const context = new AudioContext();
    audioContext = context;
    await context.resume();
    if (token !== generation) return;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(media).connect(analyser);
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    const current = new MediaRecorder(
      media,
      mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined,
    );
    recorder = current;
    const chunks: Blob[] = [];
    recording = new Promise<Blob>((resolve, reject) => {
      current.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      current.onstop = () =>
        resolve(new Blob(chunks, { type: current.mimeType }));
      current.onerror = () =>
        reject(new Error("The microphone recording failed. Try again."));
    });
    // Attach rejection handling immediately, including when the user cancels before sending.
    void recording.catch((error) => {
      if (token !== generation) return;
      releaseMicrophone();
      recording = undefined;
      audio = undefined;
      void publish({ status: "error", error: error.message, retryable: true });
    });
    current.start(250);
    const startedAt = performance.now();
    const samples = new Uint8Array(analyser.fftSize);
    const update = () => {
      if (
        token !== generation ||
        state.status === "transcribing" ||
        state.status === "starting"
      )
        return;
      const elapsedMs = performance.now() - startedAt;
      analyser.getByteTimeDomainData(samples);
      const waveform = Array.from({ length: 48 }, (_, i) => {
        const offset = Math.floor((i * samples.length) / 48);
        const end = Math.floor(((i + 1) * samples.length) / 48);
        let square = 0;
        for (let j = offset; j < end; j++)
          square += ((samples[j] - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(square / (end - offset)) * 4);
      });
      void publish({ status: "recording", elapsedMs, waveform });
      if (elapsedMs >= 120000) void send();
    };
    update();
    timer = setInterval(update, 100);
    media.getAudioTracks()[0].addEventListener("ended", () => {
      if (token !== generation || state.status !== "recording") return;
      releaseMicrophone();
      recording = undefined;
      audio = undefined;
      void publish({
        status: "error",
        error: "Microphone disconnected. Try recording again.",
        retryable: true,
      });
    });
  } catch (error) {
    if (token !== generation) return;
    releaseMicrophone();
    const denied =
      error instanceof DOMException &&
      ["NotAllowedError", "SecurityError"].includes(error.name);
    await publish(
      denied
        ? { status: "permission" }
        : {
            status: "error",
            error:
              "Could not access a microphone. Check your input device and try again.",
            retryable: true,
          },
    );
  }
}
async function send() {
  if (state.status !== "recording" && state.status !== "error") return;
  if (!audio && !recording) {
    if (tabId !== undefined) await start(tabId);
    return;
  }
  const token = generation;
  const sourceTabId = tabId;
  await publish({ status: "transcribing" });
  if (token !== generation) return;
  releaseMicrophone();
  // The regular heartbeat also prevents an idle MV3 worker from losing run coordination.
  timer = setInterval(() => {
    void publish(state);
  }, 5000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!audio) audio = await recording;
    if (token !== generation || sourceTabId === undefined || !audio) return;
    const key = await getKey();
    if (token !== generation) return;
    const controller = new AbortController();
    abort = controller;
    timeout = setTimeout(() => controller.abort(), 90000);
    const text = await transcribeAudio(audio, key, controller.signal);
    if (token !== generation) return;
    // Task starts only after the complete transcript arrives, and only for the bound tab.
    const result = await chrome.runtime.sendMessage({
      type: "VOICE_START_AGENT",
      tabId: sourceTabId,
      sessionId,
      goal: text,
    });
    if (token !== generation) return;
    if (!result?.success)
      throw new Error(result?.error || "Could not start Jev.");
    audio = undefined;
    recording = undefined;
    await publish({ status: "starting", text });
    setTimeout(() => {
      if (token === generation) cancel();
    }, 1800);
  } catch (error) {
    if (token !== generation) return;
    await publish({
      status: "error",
      retryable: true,
      error:
        error instanceof DOMException && error.name === "AbortError"
          ? "Transcription timed out. Retry or cancel this recording."
          : (error as Error).message,
    });
  } finally {
    clearTimeout(timeout);
    if (token === generation) {
      clearInterval(timer);
      timer = undefined;
      abort = undefined;
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "voice-recorder") return false;
  const background =
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    (!sender.url || sender.url === chrome.runtime.getURL("background.js"));
  const permissionPage =
    sender.url === chrome.runtime.getURL("microphone.html");
  if (
    !background &&
    !(message.type === "VOICE_PERMISSION_GRANTED" && permissionPage)
  )
    return false;
  void (async () => {
    if (message.type === "VOICE_TOGGLE") {
      if (
        tabId !== undefined &&
        tabId !== message.tabId &&
        state.status !== "closed"
      ) {
        await chrome.runtime.sendMessage({ type: "VOICE_FOCUS", tabId });
      } else if (state.status === "recording") {
        await send();
      } else if (
        state.status === "initializing" ||
        state.status === "permission"
      ) {
        cancel();
      } else if (
        state.status !== "transcribing" &&
        state.status !== "starting"
      ) {
        await start(message.tabId);
      }
    } else if (message.type === "VOICE_DO_ACTION" && tabId === message.tabId) {
      const action = message.action as VoiceAction;
      if (action === "cancel") cancel();
      else if (action === "send" || action === "retry") await send();
    } else if (
      message.type === "VOICE_PERMISSION_GRANTED" &&
      state.status === "permission" &&
      tabId !== undefined
    ) {
      await start(tabId);
    } else if (message.type === "VOICE_TAB_CLOSED" && tabId === message.tabId) {
      cancel();
    }
    sendResponse({ success: true });
  })().catch((error) => sendResponse({ success: false, error: error.message }));
  return true;
});
