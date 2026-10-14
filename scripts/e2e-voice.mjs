/** Real extension, MediaRecorder, waveform, and trusted input; only model responses are mocked. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
const records = [];
let transcriptionMode = "success";
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      '<!doctype html><title>Voice task fixture</title><h1>Widget search</h1><label>Search <input name="q"></label>',
    );
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  records.push({ path: req.url, raw });
  let result;
  if (req.url === "/transcribe") {
    assert.ok(raw.includes(Buffer.from("gpt-4o-mini-transcribe")));
    assert.ok(raw.includes(Buffer.from("voice-task.webm")));
    assert.ok(raw.length > 1000, "Actual recorded audio is uploaded");
    if (transcriptionMode === "failure") {
      res.writeHead(503);
      res.end();
      return;
    }
    if (transcriptionMode === "delayed")
      await new Promise((r) => setTimeout(r, 1000));
    result = { text: "Enter blue widgets in the Search field" };
  } else if (req.url === "/chat") {
    result = {
      choices: [
        { message: { content: JSON.stringify({ text: "blue widgets" }) } },
      ],
    };
  } else {
    const body = JSON.parse(raw);
    const filled = body.state.elements.some((e) => e.value === "blue widgets");
    result = {
      model: "jev-latest",
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([name, q]) => {
          if (q.type === "noul")
            return [
              name,
              { type: "noul", noul: name === "goal_done" && filled ? 1 : 0 },
            ];
          const choice =
            name === "operation"
              ? filled
                ? "DONE"
                : "TYPE_TEXT"
              : Object.keys(q.criteria)[0];
          return [
            name,
            {
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
              ),
            },
          ];
        }),
      ),
    };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
});
async function poll(read, check) {
  const end = Date.now() + 15000;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out: " + JSON.stringify(value));
}
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const dist = path.resolve("dist");
const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json")));
const extension = createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jev-voice-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--no-sandbox",
      "--silent-debugger-extension-api",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const response = await route.fetch({ url: origin + "/transcribe" });
      return route.fulfill({ response });
    }
    if (url.startsWith(origin) || url.startsWith("chrome-extension:"))
      return route.continue();
    return route.abort();
  });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extension}/options.html`);
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async (origin) => {
    const { jev_settings = {} } =
      await chrome.storage.local.get("jev_settings");
    await chrome.storage.local.set({
      jev_settings: {
        ...jev_settings,
        activeProvider: "typesafe",
        stepDelayMs: 0,
        typesafe: {
          apiKey: "dummy-jev",
          model: "jev-latest",
          endpoint: origin + "/decisions",
        },
        textHelper: {
          provider: "openai",
          apiKey: "dummy-openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-6-luna",
        },
      },
    });
    globalThis.voiceStates = [];
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "VOICE_STATE")
        globalThis.voiceStates.push(message.state);
    });
    const original = fetch.bind(globalThis);
    globalThis.fetch = (input, init) =>
      String(input) === "https://api.openai.com/v1/chat/completions"
        ? original(origin + "/chat", init)
        : String(input).startsWith(origin)
          ? original(input, init)
          : Promise.reject(new Error("Unexpected external request"));
  }, origin);
  // Offscreen targets are not routed by Playwright's page network interception.
  // Install a fail-closed mock transport directly in that document before recording.
  await worker.evaluate(() =>
    chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Isolated voice regression test",
    }),
  );
  const cdp = await context.browser().newBrowserCDPSession();
  const target = await poll(
    async () =>
      (await cdp.send("Target.getTargets")).targetInfos.find(
        (t) => t.url === `chrome-extension://${extension}/offscreen.html`,
      ),
    Boolean,
  );
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  });
  const evaluation = new Promise((resolve, reject) => {
    const handler = (event) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== 1) return;
      cdp.off("Target.receivedMessageFromTarget", handler);
      if (message.error || message.result?.exceptionDetails)
        reject(new Error("Could not install recorder mock"));
      else resolve();
    };
    cdp.on("Target.receivedMessageFromTarget", handler);
  });
  await cdp.send("Target.sendMessageToTarget", {
    sessionId,
    message: JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: `(() => {
   const original=globalThis.fetch.bind(globalThis);
   globalThis.fetch=(input,init) => String(input)==='https://api.openai.com/v1/audio/transcriptions'
     ? original(${JSON.stringify(origin + "/transcribe")},init)
     : Promise.reject(new Error('Unexpected external recorder request'));
 })()`,
      },
    }),
  });
  await evaluation;
  await cdp.send("Target.detachFromTarget", { sessionId });
  await cdp.detach();
  async function recorderEval(expression) {
    const cdp = await context.browser().newBrowserCDPSession();
    const target = (await cdp.send("Target.getTargets")).targetInfos.find(
      (t) => t.url === `chrome-extension://${extension}/offscreen.html`,
    );
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    const answer = new Promise((resolve, reject) => {
      const handler = (event) => {
        if (event.sessionId !== sessionId) return;
        const result = JSON.parse(event.message);
        if (result.id !== 1) return;
        cdp.off("Target.receivedMessageFromTarget", handler);
        if (result.error || result.result?.exceptionDetails)
          reject(new Error("Recorder evaluation failed"));
        else resolve(result.result?.result?.value);
      };
      cdp.on("Target.receivedMessageFromTarget", handler);
    });
    await cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }),
    });
    const value = await answer;
    await cdp.send("Target.detachFromTarget", { sessionId });
    await cdp.detach();
    return value;
  }
  async function clickPanelButton(text) {
    const session = await context.newCDPSession(page);
    try {
      const { root } = await session.send("DOM.getDocument", {
        depth: -1,
        pierce: true,
      });
      const content = (node) =>
        (node.nodeValue || "") + (node.children || []).map(content).join("");
      const find = (node) =>
        node.nodeName === "BUTTON" && content(node) === text
          ? node
          : [...(node.children || []), ...(node.shadowRoots || [])]
              .map(find)
              .find(Boolean);
      const button = find(root);
      assert.ok(button, `Panel button ${text} exists`);
      const { model } = await session.send("DOM.getBoxModel", {
        nodeId: button.nodeId,
      });
      await page.mouse.click(
        (model.border[0] + model.border[4]) / 2,
        (model.border[1] + model.border[5]) / 2,
      );
    } finally {
      await session.detach();
    }
  }
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  assert.ok(
    commands.find((c) => c.name === "voice-task")?.shortcut,
    "Voice shortcut is assigned",
  );
  const page = await context.newPage();
  await page.goto(origin + "/fixture");
  await page.bringToFront();
  const sourceTab = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id,
    origin + "/fixture",
  );
  // Headless Chromium does not dispatch browser accelerator shortcuts from CDP key events.
  // Exercise the same toggle through the real popup button; unit tests cover command dispatch.
  const shortcut = async () => {
    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${extension}/popup.html?tabId=${sourceTab}`,
    );
    await popup
      .getByRole("button", { name: "Record a voice task", exact: true })
      .click();
    await page.bringToFront();
    if (!popup.isClosed()) await popup.close();
  };
  const voiceState = () =>
    options.evaluate(async () => {
      const result = await chrome.runtime.sendMessage({ type: "GET_PROGRESS" });
      return result.progress;
    });
  await shortcut();
  await page.locator("#__jev_voice").waitFor();
  // Shadow root stays closed to the host site; screenshots still capture its rendered UI.
  await poll(
    () => worker.evaluate(() => globalThis.voiceStates.at(-1)),
    (s) => s?.status === "recording",
  );
  await new Promise((r) => setTimeout(r, 1100));
  const waveforms = await worker.evaluate(() =>
    globalThis.voiceStates
      .filter((s) => s.status === "recording")
      .map((s) => s.waveform),
  );
  assert.ok(
    waveforms.some((w) => w.some((v) => v > 0)),
    "Waveform reflects actual microphone samples",
  );
  fs.mkdirSync(".e2e-out", { recursive: true });
  await page.screenshot({ path: ".e2e-out/voice-recording.png" });
  await shortcut();
  const progress = await poll(
    voiceState,
    (p) => p.status === "done" || p.status === "error",
  ).catch(async (error) => {
    console.error(
      "Last voice state",
      await worker.evaluate(() => globalThis.voiceStates.at(-1)),
    );
    console.error(
      "Mock request sizes",
      records.map((r) => ({ path: r.path, bytes: r.raw.length })),
    );
    await page.screenshot({ path: ".e2e-out/voice-debug.png" });
    throw error;
  });
  assert.equal(progress.status, "done", progress.lastError);
  assert.equal(progress.goal, "Enter blue widgets in the Search field");
  assert.equal(await page.inputValue("input[name=q]"), "blue widgets");
  assert.equal(records.filter((r) => r.path === "/transcribe").length, 1);
  await page.screenshot({ path: ".e2e-out/voice-task-started.png" });
  await poll(
    () => page.locator("#__jev_voice").count(),
    (n) => n === 0,
  );
  console.log(
    "PASS voice toggle, microphone capture, waveform panel, multipart transcription, and trusted Jev task",
  );

  const beforeCancel = records.length;
  await shortcut();
  await page.locator("#__jev_voice").waitFor();
  await new Promise((r) => setTimeout(r, 400));
  await page.keyboard.press("Escape");
  await poll(
    () => page.locator("#__jev_voice").count(),
    (n) => n === 0,
  );
  assert.equal(
    records.length,
    beforeCancel,
    "Cancel discards the recording without uploading it",
  );
  console.log("PASS Escape cancels recording without an upload");

  transcriptionMode = "failure";
  await shortcut();
  await page.locator("#__jev_voice").waitFor();
  await new Promise((r) => setTimeout(r, 700));
  await shortcut();
  await poll(
    () =>
      Promise.resolve(records.filter((r) => r.path === "/transcribe").length),
    (n) => n === 2,
  );
  await poll(
    () => worker.evaluate(() => globalThis.voiceStates.at(-1)),
    (s) => s?.status === "error",
  );
  await page.screenshot({ path: ".e2e-out/voice-error.png" });
  assert.equal(
    (await voiceState()).status,
    "done",
    "A transcription failure does not start another task",
  );
  transcriptionMode = "success";
  await page.locator("input[name=q]").fill("");
  await clickPanelButton("Retry");
  await poll(
    () =>
      Promise.resolve(records.filter((r) => r.path === "/transcribe").length),
    (n) => n === 3,
  );
  await poll(
    () => page.inputValue("input[name=q]"),
    (value) => value === "blue widgets",
  );
  await poll(
    () => page.locator("#__jev_voice").count(),
    (n) => n === 0,
  );
  console.log(
    "PASS transcription failure does not run Jev; Retry uploads the retained recording and starts the task",
  );

  transcriptionMode = "delayed";
  await page.locator("input[name=q]").fill("");
  const beforeDelayedDecisions = records.filter(
    (r) => r.path === "/decisions",
  ).length;
  await shortcut();
  await poll(
    () => worker.evaluate(() => globalThis.voiceStates.at(-1)),
    (s) => s?.status === "recording",
  );
  await new Promise((r) => setTimeout(r, 700));
  await clickPanelButton("Send task");
  await poll(
    () =>
      Promise.resolve(records.filter((r) => r.path === "/transcribe").length),
    (n) => n === 4,
  );
  await page.keyboard.press("Escape");
  await poll(
    () => page.locator("#__jev_voice").count(),
    (n) => n === 0,
  );
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(
    records.filter((r) => r.path === "/decisions").length,
    beforeDelayedDecisions,
  );
  assert.equal(await page.inputValue("input[name=q]"), "");
  console.log(
    "PASS cancel during transcription prevents the returned transcript from running",
  );

  await recorderEval(`(() => {
   const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   let first=true;
   navigator.mediaDevices.getUserMedia=(constraints)=>{
     if(first){first=false;return Promise.reject(new DOMException('Permission needed','NotAllowedError'));}
     return original(constraints);
   };
 })()`);
  await shortcut();
  await poll(
    () => worker.evaluate(() => globalThis.voiceStates.at(-1)),
    (s) => s?.status === "permission",
  );
  await page.screenshot({ path: ".e2e-out/voice-permission.png" });
  await clickPanelButton("Enable microphone");
  const permission = await poll(
    () =>
      Promise.resolve(
        context
          .pages()
          .find(
            (p) =>
              p.url() === `chrome-extension://${extension}/microphone.html`,
          ),
      ),
    Boolean,
  );
  await permission.getByRole("button", { name: "Allow microphone" }).click();
  await poll(
    () => worker.evaluate(() => globalThis.voiceStates.at(-1)),
    (s) => s?.status === "recording",
  );
  await page.bringToFront();
  await page.keyboard.press("Escape");
  await poll(
    () => page.locator("#__jev_voice").count(),
    (n) => n === 0,
  );
  console.log(
    "PASS denied microphone shows setup UI, Allow microphone resumes recording in the original tab",
  );
} finally {
  await context?.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(profile, { recursive: true, force: true });
}
