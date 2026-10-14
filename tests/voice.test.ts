import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVoice } from "../src/background/voice";
import type { AgentRunner } from "../src/background/agent";
import { DEFAULT_SETTINGS } from "../src/shared/types";

let onCommand: (command: string, tab?: { id: number }) => void;
let onMessage: (
  message: any,
  sender: any,
  reply: (response: any) => void,
) => boolean;
let chromeMock: any;
let runner: any;
let getSettings: any;
const url = (file: string) => `chrome-extension://test/${file}`;
const recorder = { id: "test", url: url("offscreen.html") };
function message(data: any, sender: any = recorder): Promise<any> {
  return new Promise((resolve) => {
    if (!onMessage(data, sender, resolve)) resolve(undefined);
  });
}
beforeEach(() => {
  chromeMock = {
    commands: {
      onCommand: {
        addListener: vi.fn((fn) => {
          onCommand = fn;
        }),
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => ({
        id,
        url: "https://example.com",
        windowId: 1,
      })),
      create: vi.fn(async () => ({ id: 8, windowId: 1 })),
      query: vi.fn(async () => [{ id: 7 }]),
      sendMessage: vi.fn(async () => ({ success: true })),
      update: vi.fn(),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    windows: { create: vi.fn(), update: vi.fn() },
    scripting: { executeScript: vi.fn(async () => []) },
    offscreen: {
      createDocument: vi.fn(async () => undefined),
      Reason: { USER_MEDIA: "USER_MEDIA" },
    },
    runtime: {
      id: "test",
      getURL: url,
      getContexts: vi.fn(async () => []),
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      sendMessage: vi.fn(async () => ({ success: true })),
      openOptionsPage: vi.fn(),
      onMessage: {
        addListener: vi.fn((fn) => {
          onMessage = fn;
        }),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  runner = {
    getProgress: vi.fn(() => ({ status: "idle" })),
    start: vi.fn(),
    setSettings: vi.fn(),
  };
  getSettings = vi.fn(async () => structuredClone(DEFAULT_SETTINGS));
  installVoice(runner as AgentRunner, getSettings);
});
afterEach(() => vi.unstubAllGlobals());
describe("Voice shortcut and source tab", () => {
  it("handles the registered command by injecting the panel script and toggling the recorder on the command tab", async () => {
    onCommand("voice-task", { id: 7 });
    await vi.waitFor(() =>
      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
        target: "voice-recorder",
        type: "VOICE_TOGGLE",
        tabId: 7,
      }),
    );
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["content.js"],
    });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(runner.start).not.toHaveBeenCalled();
  });
  it("preserves an internal source tab by opening a web task tab", async () => {
    chromeMock.tabs.get
      .mockResolvedValueOnce({
        id: 7,
        url: "chrome://extensions/",
        windowId: 3,
      })
      .mockResolvedValue({
        id: 8,
        url: "https://www.google.com/",
        windowId: 3,
        status: "complete",
      });
    onCommand("voice-task", { id: 7 });
    await vi.waitFor(() =>
      expect(chromeMock.runtime.sendMessage).toHaveBeenCalled(),
    );
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "https://www.google.com/",
      windowId: 3,
      active: true,
    });
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 8 },
      files: ["content.js"],
    });
  });
  it("binds panel actions to the sender tab instead of an untrusted supplied id", async () => {
    const response = await message(
      { type: "VOICE_ACTION", action: "cancel", tabId: 99 },
      { tab: { id: 7 }, frameId: 0 },
    );
    expect(response.success).toBe(true);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      target: "voice-recorder",
      type: "VOICE_DO_ACTION",
      tabId: 7,
      action: "cancel",
    });
  });
});
describe("Voice task handoff", () => {
  it("rejects credential and task requests from content scripts", async () => {
    const sender = { tab: { id: 7 }, frameId: 0, url: "https://example.com" };
    expect((await message({ type: "VOICE_GET_KEY" }, sender)).success).toBe(
      false,
    );
    expect(
      (
        await message(
          { type: "VOICE_START_AGENT", tabId: 7, goal: "Click something" },
          sender,
        )
      ).success,
    ).toBe(false);
    expect(runner.start).not.toHaveBeenCalled();
  });
  it("starts the complete transcript only for the current recording session", async () => {
    await message({
      type: "VOICE_STATE",
      tabId: 7,
      sessionId: "recording-a",
      state: { status: "transcribing" },
    });
    expect(
      (
        await message({
          type: "VOICE_START_AGENT",
          tabId: 7,
          sessionId: "recording-a",
          goal: "Start a draft email",
        })
      ).success,
    ).toBe(true);
    expect(runner.start).toHaveBeenCalledWith("Start a draft email", 7);
  });
  it("cancellation during async settings reload prevents the transcript from starting a task", async () => {
    await message({
      type: "VOICE_STATE",
      tabId: 7,
      sessionId: "recording-a",
      state: { status: "transcribing" },
    });
    let resolveSettings!: (value: typeof DEFAULT_SETTINGS) => void;
    getSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const pending = message({
      type: "VOICE_START_AGENT",
      tabId: 7,
      sessionId: "recording-a",
      goal: "Start a draft email",
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalled());
    await message({
      type: "VOICE_STATE",
      tabId: 7,
      sessionId: "recording-a",
      state: { status: "closed" },
    });
    resolveSettings(structuredClone(DEFAULT_SETTINGS));
    expect((await pending).error).toMatch(/cancelled/);
    expect(runner.start).not.toHaveBeenCalled();
  });
});
