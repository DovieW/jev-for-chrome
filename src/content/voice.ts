import type { VoiceAction, VoiceState } from "../voice/types";

declare global {
  interface Window {
    __jevVoiceCleanup?: () => void;
  }
}
// Clear the old panel and its Escape listener after an extension reload.
window.__jevVoiceCleanup?.();

let host: HTMLDivElement | undefined;
let root: ShadowRoot | undefined;
let lastFocus: HTMLElement | null = null;
const closeIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const micIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';

function action(value: VoiceAction) {
  void chrome.runtime
    .sendMessage({ type: "VOICE_ACTION", action: value })
    .catch(() => undefined);
}
function onEscape(event: KeyboardEvent) {
  if (event.key === "Escape" && host) {
    event.preventDefault();
    event.stopImmediatePropagation();
    action("cancel");
  }
}
export function updateVoicePanel(state: VoiceState): void {
  if (state.status === "closed") {
    const restoreFocus = document.activeElement === host;
    window.__jevVoiceCleanup?.();
    window.__jevVoiceCleanup = undefined;
    host = undefined;
    root = undefined;
    if (restoreFocus && lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
    return;
  }
  if (!host?.isConnected) {
    document.querySelector("#__jev_voice")?.remove();
    lastFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    host = document.createElement("div");
    host.id = "__jev_voice";
    host.style.cssText =
      "all:initial!important;position:fixed!important;bottom:24px!important;left:50%!important;transform:translateX(-50%)!important;width:min(480px,calc(100vw - 32px))!important;z-index:2147483647!important;";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host{color-scheme:dark}*{box-sizing:border-box}section{font:14px/1.5 system-ui,-apple-system,sans-serif;color:#e8ebf0;background:#14171c;border:1px solid #333b47;border-radius:18px;padding:18px 20px;box-shadow:0 16px 48px #0006}header{display:flex;align-items:center;gap:10px}.mic{width:32px;height:32px;display:grid;place-items:center;border-radius:9px;background:#3c526f}.mic svg{width:18px;height:18px}strong{font-size:14px;font-weight:500}time{margin-left:auto;font:12px ui-monospace,monospace;color:#a0a8b5}button{font:inherit;cursor:pointer;border:1px solid #333b47;color:#e8ebf0;background:#252c36;border-radius:8px;padding:7px 12px;display:inline-flex;align-items:center;justify-content:center;gap:8px}button:hover{background:#333b47}button:focus-visible{outline:2px solid #a0b5d1;outline-offset:3px}.close{border:0;background:transparent;padding:6px;color:#a0a8b5}.close svg{width:16px;height:16px}canvas{display:block;width:100%;height:44px;margin:12px 0}footer{display:flex;align-items:center;justify-content:space-between;gap:12px}p{font-size:12px;color:#a0a8b5;margin:0;overflow-wrap:anywhere}.primary{background:#3c526f;border-color:#3c526f;white-space:nowrap}.primary:hover{background:#48617f}.text{margin:14px 0;color:#e8ebf0;font-size:13px}.error{color:#f0a4a4}.hidden{display:none} @media(prefers-reduced-motion:no-preference){section{animation:enter .16s ease-out}@keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}}
    </style><section role="dialog" aria-label="Jev voice task"><header><span class="mic">${micIcon}</span><strong role="status" aria-live="polite"></strong><time></time><button class="close" aria-label="Cancel voice task">${closeIcon}</button></header><canvas width="880" height="88" aria-hidden="true"></canvas><p class="text hidden"></p><footer><p class="hint">Esc to cancel</p><button class="primary">Send task</button></footer></section>`;
    root
      .querySelector(".close")!
      .addEventListener("click", () => action("cancel"));
    document.documentElement.append(host);
    (root.querySelector(".close") as HTMLButtonElement).focus({ preventScroll: true });
    document.addEventListener("keydown", onEscape, true);
    const mountedHost = host;
    const escapeListener = onEscape;
    window.__jevVoiceCleanup = () => {
      mountedHost.remove();
      document.removeEventListener("keydown", escapeListener, true);
    };
  }
  const titles: Record<string, string> = {
    initializing: "Preparing microphone…",
    permission: "Microphone access needed",
    recording: "Listening",
    transcribing: "Transcribing…",
    starting: "Starting your task",
    error: "Could not start voice task",
  };
  const title = root!.querySelector("strong")!;
  if (title.textContent !== titles[state.status])
    title.textContent = titles[state.status];
  root!.querySelector("time")!.textContent =
    state.status === "recording"
      ? `${Math.floor((state.elapsedMs || 0) / 60000)}:${String(Math.floor((state.elapsedMs || 0) / 1000) % 60).padStart(2, "0")}`
      : "";
  const text = root!.querySelector(".text")!;
  text.textContent = state.error || state.text || "";
  text.classList.toggle("hidden", !text.textContent);
  text.classList.toggle("error", state.status === "error");
  const button = root!.querySelector(".primary") as HTMLButtonElement;
  button.classList.toggle(
    "hidden",
    ["initializing", "transcribing", "starting"].includes(state.status),
  );
  button.textContent =
    state.status === "permission"
      ? "Enable microphone"
      : state.status === "error"
        ? state.retryable
          ? "Retry"
          : "Open Settings"
        : "Send task";
  button.onclick = () =>
    action(
      state.status === "permission"
        ? "permission"
        : state.status === "error"
          ? state.retryable
            ? "retry"
            : "settings"
          : "send",
    );
  root!.querySelector(".hint")!.textContent =
    state.status === "recording"
      ? "Press the shortcut again to send · Esc to cancel"
      : state.status === "transcribing"
        ? "Sending audio to OpenAI · Esc to cancel"
        : "Esc to close";
  const canvas = root!.querySelector("canvas")!;
  canvas.classList.toggle("hidden", state.status !== "recording");
  if (state.status === "recording") {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#a9bdd6";
    const waveform = state.waveform || Array(48).fill(0);
    waveform.forEach((value, i) => {
      const h = Math.max(4, Math.min(1, value) * 76);
      ctx.beginPath();
      ctx.roundRect(
        (i * canvas.width) / waveform.length + 3,
        (88 - h) / 2,
        9,
        h,
        4,
      );
      ctx.fill();
    });
  }
}
