/** Built-extension regression checks. All model answers and web pages are local fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

fs.mkdirSync('.e2e-out', { recursive: true });
const requests = [];
let origin;
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    requests.push({ path: req.url, body });
    let result;
    if (req.url === '/chat') {
      const startup = body.messages[0].content.includes('starting URL');
      result = { choices: [{ message: { content: JSON.stringify(startup ? { url: origin + '/search.html' } : { text: 'blue widgets' }) } }] };
    } else {
      const state = JSON.parse(body.input);
      const filled = state.elements.some((e) => e.value === 'blue widgets');
      const operation = state.task === 'Connection test' ? 'CLICK' : filled ? 'DONE' : 'TYPE_TEXT';
      result = {
        model: 'gpt-6-luna',
        answers: body.questions.map((q) => q.type === 'predicate'
          ? { name: q.name, type: 'predicate', probability: q.name === 'goal_done' && filled ? 1 : 0 }
          : {
            name: q.name, type: 'choice', confidence: 1,
            choice: q.name === 'operation' ? operation : q.choices[0].value,
            probabilities: q.choices.map((c) => ({ value: c.value, probability: c.value === (q.name === 'operation' ? operation : q.choices[0].value) ? 1 : 0 })),
          }),
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  const file = path.resolve('scripts/e2e-fixtures', path.basename(req.url || ''));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(file));
});

async function poll(read, predicate) {
  const deadline = Date.now() + 15000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + JSON.stringify(value));
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-providers-'));
const dist = path.resolve('dist');
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
let extension = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox', '--silent-debugger-extension-api', ...(process.env.CHROMIUM_PATH ? ['--enable-unsafe-extension-debugging'] : [])],
  });
  if (process.env.CHROMIUM_PATH) {
    // Branded Chrome no longer supports --load-extension. Use its testing-only CDP API
    // in this isolated temporary profile when an explicit browser path is supplied.
    const cdp = await context.browser().newBrowserCDPSession();
    extension = (await cdp.send('Extensions.loadUnpacked', { path: dist, enableInIncognito: false })).id;
    await cdp.detach();
  }
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === 'https://api.openai.com/v1/chat/completions') {
      const response = await route.fetch({ url: origin + '/chat' });
      return route.fulfill({ response });
    }
    return url.startsWith(origin + '/') || url.startsWith('chrome-extension:') ? route.continue() : route.abort();
  });
  // Opening Options wakes a lazily started MV3 worker before we install the mock transport.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extension}/options.html`);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  // Replace the official text endpoint only inside the worker. Unknown requests fail closed.
  await worker.evaluate((origin) => {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/chat/completions') return original(origin + '/chat', init);
      if (url.startsWith(origin + '/')) return original(input, init);
      throw new Error('Unexpected external model request');
    };
  }, origin);

  async function choose(id, label) {
    await options.locator('#' + id).click();
    await options.getByRole('option', { name: label, exact: true }).click();
  }
  await options.waitForFunction(() => !document.querySelector('fieldset')?.disabled);
  await options.locator('#decision-provider').focus();
  await options.keyboard.press('Space');
  await options.getByRole('option', { name: 'OpenRouter', exact: true }).waitFor();
  await poll(() => options.evaluate(() => document.activeElement?.textContent), (text) => text === 'OpenRouter');
  await options.keyboard.press('End');
  await poll(() => options.evaluate(() => document.activeElement?.textContent), (text) => text === 'OpenAI Decisions');
  await options.keyboard.press('Enter');
  assert.match(await options.locator('#decision-provider').innerText(), /OpenAI Decisions/);
  const model = options.getByLabel('Model', { exact: true }).first();
  assert.equal(await model.inputValue(), 'gpt-6-luna');
  await options.locator('details').first().locator('summary').click();
  const endpoint = options.getByLabel('Endpoint', { exact: true });
  assert.equal(await endpoint.inputValue(), 'https://api.openai.com/v1/decisions');
  await endpoint.fill(origin + '/decisions');
  await options.getByLabel('API key', { exact: true }).first().fill('dummy-openai-key');
  await options.getByRole('button', { name: 'Test connection', exact: true }).first().click();
  await options.getByText(/Connected in/).first().waitFor();
  await choose('text-provider', 'OpenAI / Compatible API');
  assert.equal(await options.getByLabel('Model', { exact: true }).nth(1).inputValue(), 'gpt-6-luna');
  const tier = options.getByRole('combobox', { name: 'Processing', exact: true });
  assert.match(await tier.innerText(), /Standard/);
  await choose('text-tier', 'Fast / Priority');
  await options.getByRole('button', { name: 'Test connection', exact: true }).nth(1).click();
  await options.getByText(/Connected in/).nth(1).waitFor();
  await options.getByRole('tab', { name: 'Behavior', exact: true }).click();
  await options.getByLabel('Delay between steps (ms)', { exact: true }).fill('0');
  const labels = options.getByRole('switch', { name: 'Page labels', exact: true });
  await labels.click();
  assert.equal(await labels.getAttribute('aria-checked'), 'false');
  await labels.click();
  await options.getByRole('button', { name: 'Save changes', exact: true }).click();
  await poll(() => worker.evaluate(async () => (await chrome.storage.local.get('jev_settings')).jev_settings), (s) => s?.activeProvider === 'openai' && s?.textHelper.serviceTier === 'priority' && s?.stepDelayMs === 0);
  await options.getByRole('button', { name: 'Save changes', exact: true }).isDisabled().then((disabled) => assert.ok(disabled));
  await options.screenshot({ path: '.e2e-out/shadcn-behavior.png', fullPage: true });
  await options.reload();
  assert.match(await tier.innerText(), /Fast \/ Priority/);
  await options.screenshot({ path: '.e2e-out/shadcn-settings.png', fullPage: true });
  await options.getByRole('tab', { name: 'Behavior', exact: true }).click();
  assert.equal(await options.getByLabel('Delay between steps (ms)', { exact: true }).inputValue(), '0');
  await options.getByRole('tab', { name: 'Models', exact: true }).click();
  await options.getByLabel('Model', { exact: true }).first().fill('draft-model');
  await options.getByRole('button', { name: 'Discard', exact: true }).click();
  assert.equal(await model.inputValue(), 'gpt-6-luna');
  const stored = await worker.evaluate(async () => (await chrome.storage.local.get('jev_settings')).jev_settings);
  await options.getByRole('button', { name: 'Reset defaults', exact: true }).click();
  assert.equal(await options.getByLabel('API key', { exact: true }).first().inputValue(), 'dummy-openai-key');
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('jev_settings')).jev_settings), stored);
  await options.getByRole('button', { name: 'Discard', exact: true }).click();
  await options.setViewportSize({ width: 520, height: 900 });
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await options.screenshot({ path: '.e2e-out/shadcn-settings-mobile.png', fullPage: true });
  await options.setViewportSize({ width: 1280, height: 900 });
  console.log('PASS keyboard provider selects, connection tests, saved tier, zero delay, switches, discard/reset, and responsive layout');

  async function newTabPopup(sourceUrl = 'chrome://newtab/') {
    const tab = await worker.evaluate((url) => chrome.tabs.create({ url }), sourceUrl);
    const page = context.pages().find((p) => p.url().startsWith(sourceUrl)) || await context.waitForEvent('page');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extension}/popup.html?tabId=${tab.id}`);
    await popup.locator('textarea').fill('Enter blue widgets into the Search field');
    assert.match(await popup.locator('body').innerText(), /OpenAI Decisions/);
    assert.match(await popup.locator('body').innerText(), /gpt-6-luna/);
    return { popup, page, tabId: tab.id };
  }
  const progress = () => options.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' })).progress);
  const step = await newTabPopup();
  await step.popup.locator('.popup-shell').screenshot({ path: '.e2e-out/shadcn-popup.png' });
  await step.popup.getByRole('button', { name: /Step/, exact: false }).click();
  let state = await poll(progress, (p) => p.status === 'paused' || p.status === 'error');
  assert.equal(state.status, 'paused', state.lastError);
  assert.equal(state.currentStep, 1);
  assert.equal(state.logs[0].operation, 'NAVIGATE');
  assert.equal(state.inputNote, undefined);
  await step.page.waitForURL(origin + '/search.html');
  await step.popup.getByRole('button', { name: /Step/ }).click();
  state = await poll(progress, (p) => p.status === 'paused' && p.currentStep === 2 || p.status === 'error');
  assert.equal(state.status, 'paused', state.lastError);
  assert.equal(await step.page.inputValue('input[name=q]'), 'blue widgets');
  await step.popup.getByRole('button', { name: /Step/ }).click();
  state = await poll(progress, (p) => p.status === 'done' || p.status === 'error');
  assert.equal(state.status, 'done', state.lastError);
  const shell = await step.popup.locator('.popup-shell').boundingBox();
  const footer = await step.popup.locator('footer').boundingBox();
  assert.ok(footer.y + footer.height <= shell.y + shell.height + 1, 'Footer stays visible in the 600px popup');
  await step.popup.locator('.popup-shell').screenshot({ path: '.e2e-out/shadcn-popup-complete.png' });
  console.log('PASS new-tab Step navigates, pauses, fills through OpenAI, and completes');

  // Close the first run's page so page discovery targets the next new tab reliably.
  await step.page.close();
  await step.popup.close();
  const run = await newTabPopup();
  await run.popup.getByRole('button', { name: /Run/ }).click();
  await run.page.waitForURL(origin + '/search.html');
  state = await poll(progress, (p) => p.status === 'done' || p.status === 'error');
  assert.equal(state.status, 'done', state.lastError);
  assert.equal(state.currentStep, 2);
  assert.equal(await run.page.inputValue('input[name=q]'), 'blue widgets');
  assert.equal(state.inputNote, undefined);
  await run.popup.locator('.popup-shell').screenshot({ path: '.e2e-out/shadcn-popup-run.png' });
  console.log('PASS new-tab Run navigates and completes with trusted input');

  await run.page.close();
  await run.popup.close();
  for (const mode of ['Step', 'Run task']) {
    const sourceUrl = `chrome://extensions/?id=${extension}`;
    const internal = await newTabPopup(sourceUrl);
    await internal.popup.getByRole('button', { name: mode, exact: true }).click();
    const taskPage = await poll(() => Promise.resolve(context.pages().find((page) => page.url() === origin + '/search.html')), (page) => !!page);
    const source = await worker.evaluate((id) => chrome.tabs.get(id), internal.tabId);
    assert.equal(source.url, sourceUrl, 'The Chrome extensions page is preserved');
    if (mode === 'Step') {
      state = await poll(progress, (p) => p.status === 'paused' || p.status === 'error');
      assert.equal(state.status, 'paused', state.lastError);
      assert.equal(state.currentStep, 1);
      assert.equal(state.logs[0].targetLabel, 'Opened a task tab');
      // This popup still passes the internal source id when stepping again.
      await internal.popup.getByRole('button', { name: 'Step', exact: true }).click();
      state = await poll(progress, (p) => p.status === 'paused' && p.currentStep === 2 || p.status === 'error');
      assert.equal(state.status, 'paused', state.lastError);
      await internal.popup.getByRole('button', { name: 'Step', exact: true }).click();
    }
    state = await poll(progress, (p) => p.status === 'done' || p.status === 'error');
    assert.equal(state.status, 'done', state.lastError);
    assert.equal(state.currentStep, 2);
    assert.equal(state.inputNote, undefined);
    assert.equal(await taskPage.inputValue('input[name=q]'), 'blue widgets');
    assert.equal((await worker.evaluate((id) => chrome.tabs.get(id), internal.tabId)).url, sourceUrl);
    await internal.popup.locator('.popup-shell').screenshot({ path: `.e2e-out/internal-${mode === 'Step' ? 'step' : 'run'}.png` });
    await taskPage.close();
    await internal.page.close();
    await internal.popup.close();
    console.log(`PASS ${mode} from Chrome extensions opens a task tab, preserves the original, and completes`);
  }

  await worker.evaluate(async () => {
    const { jev_settings } = await chrome.storage.local.get('jev_settings');
    jev_settings.openai.apiKey = '';
    jev_settings.textHelper.apiKey = '';
    await chrome.storage.local.set({ jev_settings });
  });
  const missingKey = await newTabPopup();
  await missingKey.popup.locator('textarea').press('Control+Enter');
  state = await poll(progress, (p) => p.status === 'error');
  assert.equal(state.inputNote, undefined);
  await missingKey.popup.getByRole('alert').getByText('Add an API key in Settings to start this task.', { exact: true }).waitFor();
  await missingKey.popup.getByRole('button', { name: 'Open Settings', exact: true }).waitFor();
  await missingKey.popup.locator('.popup-shell').screenshot({ path: '.e2e-out/shadcn-popup-error.png' });
  console.log('PASS keyboard run shortcut and actionable missing-key state');

  const texts = requests.filter((r) => r.path === '/chat');
  assert.equal(texts.length, 9);
  for (const { body } of texts) {
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.max_completion_tokens, 1024);
    assert.equal(body.service_tier, 'priority');
    assert.equal(body.reasoning_effort, 'none');
    assert.ok(!('max_tokens' in body));
  }
  assert.ok(requests.filter((r) => r.path === '/decisions').every(({ body }) => body.model === 'gpt-6-luna' && body.questions.every((q) => q.type !== 'choice' || q.choices.length >= 2)));
  console.log('PASS Luna request parameters, priority tier, and decision schema on actual worker requests');
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
