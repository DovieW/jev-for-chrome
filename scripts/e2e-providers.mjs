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
  await context.route('**/*', (route) => {
    const url = route.request().url();
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

  await options.getByRole('button', { name: 'OpenAI Decisions (GPT-6 Luna)', exact: true }).click();
  // Configuration field labels are siblings rather than associated <label for> elements.
  const model = options.locator('label:text-is("Model") + input');
  assert.equal(await model.inputValue(), 'gpt-6-luna');
  const endpoint = options.locator('label:text-is("Endpoint") + input');
  assert.equal(await endpoint.inputValue(), 'https://api.openai.com/v1/decisions');
  await endpoint.fill(origin + '/decisions');
  await options.locator('label:text-is("API Key") + input').first().fill('dummy-openai-key');
  await options.getByRole('button', { name: 'Test OpenAI Decisions', exact: true }).click();
  await options.getByText(/Success in/).waitFor();
  await options.locator('select').first().selectOption('openai');
  assert.equal(await options.locator('label:text-is("Model Name") + input').inputValue(), 'gpt-6-luna');
  const tier = options.locator('label:text-is("OpenAI Text Processing Tier") + select');
  assert.equal(await tier.inputValue(), 'default');
  await tier.selectOption('priority');
  await options.getByRole('button', { name: 'Save All Settings', exact: true }).click();
  await poll(() => worker.evaluate(async () => (await chrome.storage.local.get('jev_settings')).jev_settings), (s) => s?.activeProvider === 'openai' && s?.textHelper.serviceTier === 'priority');
  await options.reload();
  assert.equal(await tier.inputValue(), 'priority');
  await options.screenshot({ path: '.e2e-out/openai-options.png', fullPage: true });
  console.log('PASS OpenAI provider selection, connection test, Luna preset, tier persistence');

  async function newTabPopup() {
    const tab = await worker.evaluate(() => chrome.tabs.create({ url: 'chrome://newtab/' }));
    const page = context.pages().find((p) => p.url().startsWith('chrome://newtab')) || await context.waitForEvent('page');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extension}/popup.html?tabId=${tab.id}`);
    await popup.locator('textarea').fill('Enter blue widgets into the Search field');
    assert.match(await popup.locator('body').innerText(), /OpenAI Decisions \(Luna\)/);
    return { popup, page };
  }
  const progress = () => options.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' })).progress);
  const step = await newTabPopup();
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
  await step.popup.screenshot({ path: '.e2e-out/openai-step.png', fullPage: true });
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
  await run.popup.screenshot({ path: '.e2e-out/openai-run.png', fullPage: true });
  console.log('PASS new-tab Run navigates and completes with trusted input');

  const texts = requests.filter((r) => r.path === '/chat');
  assert.equal(texts.length, 4);
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
