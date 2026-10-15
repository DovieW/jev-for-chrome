/** Inspect exported runs in the actual extension, with no network or model requests. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

fs.mkdirSync(".e2e-out", { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jev-history-"));
const dist = path.resolve("dist");
const manifest = JSON.parse(
  fs.readFileSync(path.join(dist, "manifest.json"), "utf8"),
);
let extension = createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (digit) =>
    String.fromCharCode(97 + parseInt(digit, 16)),
  );
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.CHROMIUM_PATH ? undefined : "chromium",
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1560, height: 1100 },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--no-sandbox",
      ...(process.env.CHROMIUM_PATH
        ? ["--enable-unsafe-extension-debugging"]
        : []),
    ],
  });
  if (process.env.CHROMIUM_PATH) {
    const cdp = await context.browser().newBrowserCDPSession();
    extension = (
      await cdp.send("Extensions.loadUnpacked", {
        path: dist,
        enableInIncognito: false,
      })
    ).id;
    await cdp.detach();
  }
  await context.route("**/*", (route) =>
    route.request().url().startsWith("chrome-extension:")
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${extension}/history.html`);
  await page
    .getByRole("heading", { name: "No runs yet", exact: true })
    .waitFor();
  const disk = () =>
    page.evaluate(
      async () =>
        (await chrome.storage.local.get("jev_run_history_v1"))
          .jev_run_history_v1,
    );
  const before = await disk();
  await page
    .getByLabel("Open run export", { exact: true })
    .setInputFiles("tests/fixtures/diagnostic-run.json");
  await page.getByText("Viewing an exported run.", { exact: false }).waitFor();
  assert.equal(await page.locator(".exchange-card").count(), 2);
  assert.match(
    await page.locator(".run-explanation").innerText(),
    /44% confidence/,
  );
  assert.match(
    await page.locator(".run-explanation").innerText(),
    /Search files/,
  );
  assert.match(
    await page.locator(".run-explanation").innerText(),
    /before any browser action/,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Delete this run", exact: true })
      .count(),
    0,
  );

  const first = page.locator(".exchange-card").first();
  const helper = page.locator(".exchange-card").nth(1);
  assert.match(await first.innerText(), /58 sent · 1 typing field/);
  assert.match(
    await first.locator(".answer-scores").first().innerText(),
    /44% confidence.*52% choice probability/s,
  );
  assert.match(await first.locator(".token-usage").innerText(), /0 output/);
  assert.match(
    await first.locator(".extension-followup").innerText(),
    /no model call/,
  );
  assert.equal(await first.locator(".tab-context > div").count(), 27);
  assert.match(
    await first.locator(".controls-table tbody tr").first().innerText(),
    /#41.*Search files/s,
  );
  await first
    .getByRole("button", { name: "Typing fields", exact: true })
    .click();
  assert.equal(await first.locator(".controls-table tbody tr").count(), 1);
  await first
    .getByRole("button", { name: "All controls", exact: true })
    .click();
  await first
    .getByLabel("Filter sent controls", { exact: true })
    .fill("Search files");
  assert.equal(await first.locator(".controls-table tbody tr").count(), 1);
  await first.getByLabel("Filter sent controls", { exact: true }).fill("");
  await first
    .getByLabel("Filter sent tabs", { exact: true })
    .fill("Example tab 27");
  assert.equal(await first.locator(".tab-context > div").count(), 1);
  await first.getByLabel("Filter sent tabs", { exact: true }).fill("");
  await page.screenshot({
    path: ".e2e-out/history-model-calls.png",
    fullPage: true,
  });
  await first.screenshot({ path: ".e2e-out/history-call-decision.png" });

  await first
    .getByRole("tab", { name: "Questions & instructions", exact: true })
    .click();
  assert.equal(
    await first.locator(".sent-questions > section").count(),
    3,
    "Only questions actually sent",
  );
  assert.doesNotMatch(
    await first.locator(".sent-questions").innerText(),
    /Type text target/,
  );
  await first.screenshot({ path: ".e2e-out/history-call-instructions.png" });
  await first.getByRole("tab", { name: "Raw JSON", exact: true }).click();
  const wire = JSON.parse(
    await first.locator(".raw-exchange pre").first().innerText(),
  );
  assert.equal(typeof wire.input, "string");
  assert.equal(JSON.parse(wire.input).elements.length, 58);
  await first.getByRole("tab", { name: "Readable", exact: true }).click();
  assert.equal(
    await helper.locator(".assistant-reply").innerText(),
    '{"text":null}',
  );
  assert.match(
    await helper.locator(".exchange-timing").innerText(),
    /HTTP 200/,
  );
  assert.match(
    await helper.locator(".followup-error").innerText(),
    /API returned successfully/,
  );
  await helper.screenshot({ path: ".e2e-out/history-call-helper.png" });
  await helper
    .getByRole("tab", { name: "Questions & instructions", exact: true })
    .click();
  assert.match(
    await helper.locator(".sent-column").innerText(),
    /Message 1 · system/,
  );
  await helper.getByRole("tab", { name: "Parameters", exact: true }).click();
  assert.match(await helper.locator(".sent-column").innerText(), /priority/);

  await page
    .getByLabel("Select model call", { exact: true })
    .selectOption({ index: 2 });
  assert.equal(await page.locator(".exchange-card").count(), 1);
  await page
    .getByRole("button", { name: "Show all calls", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Inspector fits narrow viewport",
  );
  await page.screenshot({
    path: ".e2e-out/history-calls-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1560, height: 1100 });
  await page.getByRole("tab", { name: "Execution trace", exact: true }).click();
  await page
    .getByRole("switch", { name: "Issues only", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Model calls", exact: true }).click();
  assert.deepEqual(
    await disk(),
    before,
    "Import never changes saved run history",
  );
  await page
    .getByLabel("Open run export", { exact: true })
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"version":2}'),
    });
  await page
    .getByText("This file is not a supported Jev run export.", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".exchange-card").count(),
    2,
    "A rejected import preserves the current view",
  );
  console.log(
    "PASS actual extension model-call inspector, exact bodies, local selections, filters, import isolation, narrow layout, and invalid exports",
  );

  if (process.env.JEV_TRACE_FILE) {
    await page
      .getByLabel("Open run export", { exact: true })
      .setInputFiles(path.resolve(process.env.JEV_TRACE_FILE));
    await page.waitForFunction(
      () =>
        !document.body.textContent.includes(
          "This file is not a supported Jev run export.",
        ),
    );
    await page.locator(".exchange-card").first().waitFor();
    assert.ok((await page.locator(".exchange-card").count()) > 0);
    await page
      .locator(".exchange-card")
      .first()
      .screenshot({ path: ".e2e-out/history-private-export.png" });
    assert.deepEqual(await disk(), before);
    console.log(
      "PASS supplied export opens locally without changing saved history",
    );
  }
  assert.deepEqual(errors, [], "No browser render errors");
} finally {
  await context?.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
