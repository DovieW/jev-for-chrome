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
let typeSafeAttempts = 0;
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
    } else if (req.url === '/typesafe') {
      typeSafeAttempts++;
      if (typeSafeAttempts <= 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }));
        return;
      }
      const operation = 'TYPE_TEXT';
      result = { model: 'jev-latest', answers: Object.fromEntries(
        Object.entries(body.questions).map(([name, q]) => {
          if (q.type === 'noul') return [name, { type: 'noul', noul: 0 }];
          const choice = name === 'operation' ? operation : Object.keys(q.criteria)[0];
          return [name, { choice, confidence: 1, probabilities: Object.fromEntries(
            Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])
          ) }];
        })
      ) };
    } else {
      const state = JSON.parse(body.input);
      const filled = state.elements.some((e) => e.value === 'blue widgets');
      let operation = state.task === 'Connection test' ? 'CLICK' : filled ? 'DONE' : 'TYPE_TEXT';
      if (state.task.startsWith('New tab regression') && !state.recent_actions.some(a=>a.action?.startsWith('OPEN_TAB'))) operation='OPEN_TAB';
      if (state.task.startsWith('Open tab regression') && !state.recent_actions.some(a=>a.action?.startsWith('SWITCH_TAB'))) operation='SWITCH_TAB';
      const selected = q => q.name === 'operation' ? operation : q.name === 'switch_tab_target'
        ? q.choices.find(c=>JSON.parse(c.description).title==='Target search')?.value || q.choices[0].value : q.choices[0].value;
      result = {
        model: 'gpt-6-luna',
        answers: body.questions.map((q) => q.type === 'predicate'
          ? { name: q.name, type: 'predicate', probability: q.name === 'goal_done' && filled ? 1 : 0 }
          : {
            name: q.name, type: 'choice', confidence: 1,
            choice: selected(q),
            probabilities: q.choices.map((c) => ({ value: c.value, probability: c.value === selected(q) ? 1 : 0 })),
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
  assert.equal(await labels.getAttribute('aria-checked'), 'false');
  await labels.click();
  assert.equal(await labels.getAttribute('aria-checked'), 'true');
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
  assert.equal(await step.page.locator('.__jev_badge').count(), 0, 'Page labels are off by default');
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

  // Regular-page navigation must be an offered decision, rather than a failed click head.
  await worker.evaluate(async () => {
    const {jev_settings:s}=await chrome.storage.local.get('jev_settings');
    s.openai.apiKey='dummy-openai'; s.textHelper.apiKey='dummy-openai';
    await chrome.storage.local.set({jev_settings:s});
  });
  const source = await context.newPage(); await source.goto(origin+'/search.html');
  const sourceId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,origin+'/search.html');
  const navigation=await context.newPage(); await navigation.goto(`chrome-extension://${extension}/popup.html?tabId=${sourceId}`);
  await navigation.locator('textarea').fill('New tab regression: enter blue widgets into Search');
  await navigation.getByRole('button',{name:'Step',exact:true}).click();
  state=await poll(progress,p=>p.status==='paused'||p.status==='error');
  assert.equal(state.status,'paused',state.lastError);
  assert.equal(state.logs[0].operation,'OPEN_TAB');
  const newTab=await poll(()=>Promise.resolve(context.pages().find(p=>p!==source&&p.url()===origin+'/search.html')),Boolean);
  assert.equal(source.url(),origin+'/search.html');
  await navigation.getByRole('button',{name:'Step',exact:true}).click();
  state=await poll(progress,p=>p.status==='paused'&&p.currentStep===2||p.status==='error');
  assert.equal(state.status,'paused',state.lastError);
  assert.equal(await newTab.inputValue('input[name=q]'),'blue widgets');
  await navigation.getByRole('button',{name:'Step',exact:true}).click();
  state=await poll(progress,p=>p.status==='done'||p.status==='error');
  assert.equal(state.status,'done',state.lastError);
  await newTab.close(); await navigation.close();

  const decoy=await context.newPage(); await decoy.goto(origin+'/search.html'); await decoy.evaluate(()=>document.title='Other search');
  const target=await context.newPage(); await target.goto(origin+'/search.html'); await target.evaluate(()=>document.title='Target search');
  const targetId=await worker.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.title==='Target search').id);
  const switcher=await context.newPage(); await switcher.goto(`chrome-extension://${extension}/popup.html?tabId=${sourceId}`);
  await switcher.locator('textarea').fill('Open tab regression: enter blue widgets in the existing Target search tab');
  const tabCount=(await worker.evaluate(()=>chrome.tabs.query({}))).length;
  await switcher.getByRole('button',{name:'Step',exact:true}).click();
  state=await poll(progress,p=>p.status==='paused'||p.status==='error');
  assert.equal(state.status,'paused',state.lastError);
  assert.equal(state.logs[0].operation,'SWITCH_TAB');
  assert.equal((await worker.evaluate(id=>chrome.tabs.get(id),targetId)).active,true);
  assert.equal((await worker.evaluate(()=>chrome.tabs.query({}))).length,tabCount);
  await switcher.getByRole('button',{name:'Step',exact:true}).click();
  state=await poll(progress,p=>p.status==='paused'&&p.currentStep===2||p.status==='error');
  assert.equal(state.status,'paused',state.lastError);
  assert.equal(await target.inputValue('input[name=q]'),'blue widgets');
  await switcher.getByRole('button',{name:'Step',exact:true}).click();
  state=await poll(progress,p=>p.status==='done'||p.status==='error');
  assert.equal(state.status,'done',state.lastError);
  await switcher.locator('.popup-shell').screenshot({path:'.e2e-out/open-tab-switch.png'});
  await source.close(); await target.close(); await decoy.close(); await switcher.close();
  console.log('PASS regular-page OPEN_TAB and existing SWITCH_TAB, stable source popup, and no duplicate target tab');

  // A dense inbox-like page must recover without dropping or renumbering controls.
  await worker.evaluate(async (endpoint) => {
    const { jev_settings } = await chrome.storage.local.get('jev_settings');
    jev_settings.activeProvider = 'typesafe';
    jev_settings.typesafe = { apiKey: 'dummy-typesafe', model: 'jev-latest', endpoint };
    jev_settings.textHelper.apiKey = 'dummy-text';
    await chrome.storage.local.set({ jev_settings });
  }, origin + '/typesafe');
  const dense = await context.newPage();
  await dense.goto(origin + '/search.html');
  await dense.evaluate(() => {
    const list = document.createElement('div');
    list.style.cssText = 'display:grid;grid-template-columns:repeat(10,1fr);gap:1px';
    for (let i = 0; i < 240; i++) {
      const button = document.createElement('button');
      button.style.cssText = 'display:block;width:100%;height:20px;padding:0;overflow:hidden';
      button.textContent = `Message ${i} ` + 'long email preview '.repeat(25);
      list.append(button);
    }
    document.body.append(list);
  });
  const denseTabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find(t => t.url === url).id, origin + '/search.html');
  const densePopup = await context.newPage();
  await densePopup.goto(`chrome-extension://${extension}/popup.html?tabId=${denseTabId}`);
  await densePopup.locator('textarea').fill('Enter blue widgets into the Search field');
  await densePopup.getByRole('button', { name: 'Step', exact: true }).click();
  state = await poll(progress, p => p.status === 'paused' || p.status === 'error');
  assert.equal(state.status, 'paused', state.lastError);
  assert.equal(state.currentStep, 1, 'Retries produce exactly one browser action');
  assert.equal(await dense.inputValue('input[name=q]'), 'blue widgets');
  const retries = requests.filter(r => r.path === '/typesafe').map(r => r.body);
  assert.equal(retries.length, 3);
  assert.ok(retries[0].state.elements.length > 200);
  assert.ok(JSON.stringify(retries[2]).length < JSON.stringify(retries[1]).length);
  assert.ok(JSON.stringify(retries[1]).length < JSON.stringify(retries[0]).length);
  for (const body of retries) {
    assert.deepEqual(Object.keys(body.questions.click_target.criteria), Object.keys(retries[0].questions.click_target.criteria));
    assert.deepEqual(body.state.elements.map(e => e.index), retries[0].state.elements.map(e => e.index));
  }
  await densePopup.locator('.popup-shell').screenshot({ path: '.e2e-out/typesafe-context-recovery.png' });
  console.log('PASS TypeSafe context-limit recovery on a dense page, stable target ids, and one trusted action');

  // Inspect traces produced by real extension execution, not hand-authored UI fixtures.
  const historyEvent = context.waitForEvent('page');
  await options.getByRole('link', { name: 'Run history', exact: true }).click();
  const historyPage = await historyEvent;
  await historyPage.waitForLoadState();
  await historyPage.getByRole('heading', { name: 'Run history', exact: true }).waitFor();
  await poll(() => historyPage.locator('.run-list-item').count(), n => n === 5);
  const readHistory = () => historyPage.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_RUN_HISTORY' }));
  let saved = (await readHistory()).runs;
  assert.equal(saved.length, 5);
  assert.equal(saved[0].status, 'paused');
  const denseTrace = saved[0];
  assert.equal(denseTrace.steps, 1);
  assert.equal(denseTrace.nodes.filter(n => n.kind === 'cycle').length, 1);
  assert.equal(denseTrace.nodes.filter(n => n.kind === 'request' && n.status === 'error').length, 2);
  assert.ok(denseTrace.nodes.some(n => n.label === 'Wait for page to settle' && n.durationMs >= 0));
  assert.ok(!JSON.stringify(saved).includes('dummy-'), 'Credentials never reach saved traces');
  assert.equal(saved.filter(r => r.goal.startsWith('Open tab regression')).length, 1, 'Stepping keeps one trace');
  const switched = saved.find(r => r.goal.startsWith('Open tab regression'));
  const switchCycle = switched.nodes.find(n => n.kind === 'decision' && n.output?.answers?.operation?.choice === 'SWITCH_TAB');
  assert.equal(switched.nodes.filter(n => n.parentId === switchCycle.id && n.kind === 'request').length, 2);
  await historyPage.locator('.exchange-card').first().waitFor();
  assert.match(await historyPage.locator('.exchange-card').first().innerText(), /HTTP 400/);
  assert.match(await historyPage.locator('.exchange-card').first().innerText(), /max_tokens_exceeded/);
  await historyPage.getByRole('tab', { name: 'Execution trace', exact: true }).click();
  await historyPage.getByRole('switch', { name: 'Issues only' }).click();
  await historyPage.getByText('Context limit reached', { exact: true }).first().waitFor();
  await historyPage.screenshot({ path: '.e2e-out/history-retries.png', fullPage: true });
  await historyPage.getByRole('switch', { name: 'Issues only' }).click();
  await historyPage.locator('.run-list-item').filter({ hasText: 'Open tab regression' }).click();
  await historyPage.getByRole('tab', { name: 'Execution trace', exact: true }).click();
  await historyPage.getByText('Target for Switch tab', { exact: true }).waitFor();
  const requestNode = historyPage.locator('.trace-request').first();
  await requestNode.locator(':scope > summary').click();
  await requestNode.getByText('Request body', { exact: true }).click();
  assert.match(await requestNode.locator('pre').innerText(), /operation/);
  await historyPage.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await poll(() => historyPage.locator('.trace-cycle[open]').count(), count => count === 0);
  await historyPage.screenshot({ path: '.e2e-out/history-overview.png' });
  await historyPage.getByRole('button', { name: 'Expand all', exact: true }).click();
  await poll(() => historyPage.locator('.trace-cycle[open]').count(), count => count === 3);
  await historyPage.screenshot({ path: '.e2e-out/history-decisions.png', fullPage: true });
  const downloadEvent = historyPage.waitForEvent('download');
  await historyPage.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadEvent;
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.equal(exported.id, switched.id);
  assert.ok(exported.nodes.some(n => n.kind === 'decision'));
  await historyPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await historyPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'History fits a narrow viewport');
  await historyPage.screenshot({ path: '.e2e-out/history-mobile.png', fullPage: true });
  await historyPage.setViewportSize({ width: 1280, height: 900 });
  await historyPage.reload();
  await historyPage.getByRole('tab', { name: 'Execution trace', exact: true }).click();
  await historyPage.getByText('Target for Switch tab', { exact: true }).waitFor();
  assert.equal((await readHistory()).runs.length, 5);

  // Restart the MV3 worker, then inspect persisted data with a fresh RunHistoryStore.
  const historyCdp = await context.newCDPSession(historyPage);
  let versionId;
  historyCdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    const version = versions.find(v => v.scriptURL === `chrome-extension://${extension}/background.js` && v.runningStatus === 'running');
    if (version) versionId = version.versionId;
  });
  await historyCdp.send('ServiceWorker.enable');
  await poll(() => Promise.resolve(versionId), Boolean);
  await historyCdp.send('ServiceWorker.stopWorker', { versionId });
  await historyPage.reload();
  await historyPage.locator('.run-list-item').first().waitFor();
  saved = (await readHistory()).runs;
  assert.equal(saved[0].status, 'interrupted', 'Paused tasks cannot silently resume after a worker restart');
  assert.equal(saved.find(r => r.id === switched.id).status, 'done');
  assert.equal(saved.find(r => r.id === switched.id).nodes.length, switched.nodes.length);
  await historyCdp.detach();
  await historyPage.getByRole('button', { name: 'Delete this run' }).click();
  await historyPage.getByRole('button', { name: 'Delete run', exact: true }).click();
  await poll(() => historyPage.locator('.run-list-item').count(), n => n === 4);
  await historyPage.getByRole('button', { name: 'Clear history', exact: true }).click();
  await historyPage.getByRole('button', { name: 'Delete all runs', exact: true }).click();
  await historyPage.getByRole('heading', { name: 'No runs yet' }).waitFor();
  await historyPage.screenshot({ path: '.e2e-out/history-empty.png' });
  await historyPage.reload();
  await historyPage.getByRole('heading', { name: 'No runs yet' }).waitFor();
  console.log('PASS five-run history, staged choices, retry timings, export, responsive UI, worker restart, and deletion');


} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
