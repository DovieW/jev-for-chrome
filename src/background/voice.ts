import type { AppSettings } from "../shared/types";
import { voiceApiKey } from "../shared/transcription";
import type { AgentRunner } from "./agent";

let creating: Promise<void> | undefined;
async function ensureRecorder() {
  if (
    (
      await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      })
    ).length
  )
    return;
  if (!creating)
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification:
          "Record a user-initiated voice task and compute its live waveform.",
      })
      .finally(() => {
        creating = undefined;
      });
  await creating;
}
export async function toggleVoice(sourceTabId: number) {
  let tab = await chrome.tabs.get(sourceTabId);
  if (!/^https?:/.test(tab.pendingUrl || tab.url || "")) {
    tab = await chrome.tabs.create({
      url: "https://www.google.com/",
      windowId: tab.windowId,
      active: true,
    });
  }
  if (tab.id === undefined)
    throw new Error("No tab available for a voice task.");
  const tabId = tab.id;
  const deadline = Date.now() + 15000;
  while (tab.status === "loading" || !/^https?:/.test(tab.url || "")) {
    if (Date.now() > deadline)
      throw new Error(
        "The task tab is still loading. Try the shortcut again when it finishes.",
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
    tab = await chrome.tabs.get(tabId);
  }
  // Existing tabs might predate an extension reload. Leave a live listener intact.
  const ready = await chrome.tabs
    .sendMessage(tabId, { type: "PING" })
    .catch(() => undefined);
  if (!ready?.pong)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  await ensureRecorder();
  await chrome.runtime.sendMessage({
    target: "voice-recorder",
    type: "VOICE_TOGGLE",
    tabId,
  });
}
export function installVoice(
  runner: AgentRunner,
  getSettings: () => Promise<AppSettings>,
) {
  const sessions = new Map<number, { id: string; status: string }>();
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== "voice-task") return;
    void (async () => {
      const tabId =
        tab?.id ??
        (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (tabId !== undefined) await toggleVoice(tabId);
    })().catch(() => {
      void chrome.runtime.openOptionsPage();
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    sessions.delete(tabId);
    void chrome.runtime
      .sendMessage({
        target: "voice-recorder",
        type: "VOICE_TAB_CLOSED",
        tabId,
      })
      .catch(() => undefined);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading")
      void chrome.runtime
        .sendMessage({
          target: "voice-recorder",
          type: "VOICE_TAB_CLOSED",
          tabId,
        })
        .catch(() => undefined);
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const recorder =
      sender.url === chrome.runtime.getURL("offscreen.html") && !sender.tab;
    if (message.target === "voice-recorder") return false;
    if (
      ![
        "VOICE_STATE",
        "VOICE_GET_KEY",
        "VOICE_START_AGENT",
        "VOICE_ACTION",
        "VOICE_FOCUS",
        "VOICE_TOGGLE_REQUEST",
      ].includes(message.type)
    )
      return false;
    void (async () => {
      if (message.type === "VOICE_TOGGLE_REQUEST") {
        if (sender.url?.split("?")[0] !== chrome.runtime.getURL("popup.html"))
          throw new Error("Voice recording must be opened from Jev.");
        const tabId =
          message.tabId ??
          (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
            ?.id;
        if (tabId === undefined) throw new Error("No active tab found.");
        await toggleVoice(tabId);
      } else if (message.type === "VOICE_ACTION") {
        if (sender.tab?.id === undefined || sender.frameId !== 0)
          throw new Error("Voice actions require the source tab.");
        if (message.action === "permission") {
          const existing = (await chrome.tabs.query({})).find(
            (t) => t.url === chrome.runtime.getURL("microphone.html"),
          );
          if (existing?.id !== undefined)
            await chrome.tabs.update(existing.id, { active: true });
          else
            await chrome.windows.create({
              url: "microphone.html",
              type: "popup",
              width: 460,
              height: 360,
            });
        } else if (message.action === "settings") {
          await chrome.runtime.openOptionsPage();
        } else {
          await chrome.runtime.sendMessage({
            target: "voice-recorder",
            type: "VOICE_DO_ACTION",
            tabId: sender.tab.id,
            action: message.action,
          });
        }
      } else {
        if (!recorder)
          throw new Error(
            "Voice recorder messages require the extension recorder.",
          );
        if (message.type === "VOICE_GET_KEY") {
          sendResponse({
            success: true,
            apiKey: voiceApiKey(await getSettings()),
          });
          return;
        }
        if (message.type === "VOICE_STATE") {
          if (message.state.status === "closed") sessions.delete(message.tabId);
          else
            sessions.set(message.tabId, {
              id: message.sessionId,
              status: message.state.status,
            });
          // Await delivery: recording must stop when the visible panel disappears.
          await chrome.tabs.sendMessage(message.tabId, {
            type: "VOICE_STATE",
            state: message.state,
          });
        }
        if (message.type === "VOICE_FOCUS") {
          const tab = await chrome.tabs.update(message.tabId, { active: true });
          if (tab) await chrome.windows.update(tab.windowId, { focused: true });
        }
        if (message.type === "VOICE_START_AGENT") {
          const goal =
            typeof message.goal === "string" ? message.goal.trim() : "";
          if (!goal || goal.length > 12000)
            throw new Error("No valid voice transcript was received.");
          if (runner.getProgress().status === "running")
            throw new Error(
              "Jev is already running a task. Stop it before sending another.",
            );
          await chrome.tabs.get(message.tabId);
          const settings = await getSettings();
          const session = sessions.get(message.tabId);
          if (
            !session ||
            session.id !== message.sessionId ||
            session.status !== "transcribing"
          )
            throw new Error("The voice task was cancelled.");
          if (runner.getProgress().status === "running")
            throw new Error("Jev is already running a task. Stop it before sending another.");
          runner.setSettings(settings);
          void runner.start(goal, message.tabId);
        }
      }
      sendResponse({ success: true });
    })().catch((error) =>
      sendResponse({ success: false, error: error.message }),
    );
    return true;
  });
}
