import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner } from '../src/background/agent';
import { callJevProvider } from '../src/shared/providers';
import { generateFieldText, generateStartingUrl, parseFieldText } from '../src/shared/text-helper';
import { ActResult, ChoiceQuestion, DEFAULT_SETTINGS, PageAction, PageSnapshot } from '../src/shared/types';

vi.mock('../src/shared/providers', () => ({
  callJevProvider: vi.fn(),
  activeJevModel: () => 'test-model',
}));
vi.mock('../src/shared/text-helper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shared/text-helper')>()),
  generateFieldText: vi.fn(),
  generateStartingUrl: vi.fn(),
}));

const jev = vi.mocked(callJevProvider);
const textHelper = vi.mocked(generateFieldText);
const startingUrl = vi.mocked(generateStartingUrl);

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  const actions: PageAction[] = [
    { id: 'e1', node: 1, kind: 'click', role: 'button', label: 'Search' },
    { id: 'e2', node: 2, kind: 'fill', role: 'textbox', label: 'Where from?', value: '' },
    { id: 'e3', node: 2, kind: 'click', role: 'textbox', label: 'Open Where from?', value: '' },
    { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
  ];
  return {
    url: 'https://example.com/',
    title: 'Example',
    w: 1000,
    h: 800,
    text: 'Example page',
    scroll: { y: 0, height: 800 },
    actions,
    omitted_actions: 0,
    ...overrides,
  };
}

const answer = (choice: string, extra: Record<string, any> = {}) => ({
  model: 'test-model',
  answers: {
    operation: {
      choice,
      confidence: 0.9,
      probabilities: choice === 'DONE' ? { DONE: 0.9, WAIT: 0.1 } : { [choice]: 0.9, DONE: 0.1 },
    },
    ...extra,
  },
});
const startupAnswer = (choice: string, extra: Record<string, any> = {}) => answer(choice, {
  operation: { choice, confidence: 1, probabilities: { [choice]: 1 } }, ...extra,
});
const clickTarget = (index: string) => ({
  click_target: { choice: index, confidence: 0.8, probabilities: { [index]: 1 } },
});

interface Page {
  snapshot: PageSnapshot;
  act: (action: PageAction, text?: string) => ActResult;
  sent: Array<{ type: string; [k: string]: any }>;
}

const created: Array<(tab: any) => void> = [];
const removed: Array<(tabId: number) => void> = [];

function installChrome(page: Page) {
  created.length = 0;
  removed.length = 0;
  const chromeMock = {
    tabs: {
      get: vi.fn(async (_tabId?: number) => ({ id: 7, url: 'https://example.com/', status: 'complete' })),
      sendMessage: vi.fn(async (_tabId: number, msg: any) => {
        page.sent.push(msg);
        switch (msg.type) {
          case 'PING':
            return { pong: true };
          case 'CONTENT_OBSERVE':
            return { success: true, snapshot: page.snapshot };
          case 'CONTENT_ACT':
            return page.act(msg.action, msg.text);
          default:
            return { ok: true, via: 'synthetic' };
        }
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn((fn: any) => { created.push(fn); }) },
      onRemoved: { addListener: vi.fn((fn: any) => { removed.push(fn); }) },
      update: vi.fn(async (_id: number, _changes: chrome.tabs.UpdateProperties) => ({})),
      create: vi.fn(async (_properties: chrome.tabs.CreateProperties) => ({ id: 8, url: 'https://example.com/' })),
      query: vi.fn(),
    },
    scripting: { executeScript: vi.fn() },
    runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
  };
  vi.stubGlobal('chrome', chromeMock);
  return chromeMock;
}

function runner(): AgentRunner {
  const r = new AgentRunner();
  r.setSettings({ ...DEFAULT_SETTINGS, stepDelayMs: 0, maxSteps: 5 });
  return r;
}

describe('AgentRunner', () => {
  let page: Page;

  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
    page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finishes with DONE without executing anything', async () => {
    jev.mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Do nothing', 7);

    const progress = r.getProgress();
    expect(progress.status).toBe('done');
    expect(progress.currentStep).toBe(0);
    expect(progress.logs[0].operation).toBe('DONE');
    expect(page.sent.filter((m) => m.type === 'CONTENT_ACT')).toHaveLength(0);
  });

  it('executes the chosen target, records it, and reports page_changed on the next decision', async () => {
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    page.act = () => {
      page.snapshot = snapshot({ text: 'Results loaded', url: 'https://example.com/results' });
      return { ok: true, via: 'synthetic' };
    };
    const r = runner();
    await r.start('Search', 7);

    const acts = page.sent.filter((m) => m.type === 'CONTENT_ACT');
    expect(acts).toHaveLength(1);
    expect(acts[0].action.id).toBe('e1');
    expect(r.getProgress().status).toBe('done');
    expect(r.getProgress().currentStep).toBe(1);
    expect(jev.mock.calls[1][1].state.recent_actions).toEqual([
      { step: 1, action: 'CLICK Search', kind: 'click', text: undefined, outcome: 'navigated to https://example.com/results', url: 'https://example.com/results', page_changed: true },
    ]);
  });

  it('discards a stale decision, re-observes, and gives up after repeated staleness', async () => {
    // Always take the first offered click target; withheld targets change what is offered.
    jev.mockImplementation(async (_s, request) =>
      answer('CLICK', clickTarget(Object.keys((request.questions.click_target as ChoiceQuestion).criteria)[0]))
    );
    page.act = () => ({ ok: false, code: 'covered', message: 'Page changed' });
    const r = runner();
    await r.start('Search', 7);

    expect(r.getProgress().status).toBe('error');
    expect(r.getProgress().lastError).toMatch(/kept changing/);
    expect(r.getProgress().currentStep).toBe(0);
    expect(jev).toHaveBeenCalledTimes(4);
    expect(jev.mock.calls[3][1].state.recent_actions).toEqual([]);
    expect(page.sent.filter((m) => m.type === 'CONTENT_ACT').map((m) => m.action.id)).toEqual(['e1', 'e1', 'e3', 'e3']);
  });

  it('blocks after three consecutive non-wait actions that change nothing', async () => {
    // Always click the first offered target; suppression removes a target after two ineffective uses.
    jev.mockImplementation(async (_settings, request) =>
      answer('CLICK', clickTarget(Object.keys((request.questions.click_target as ChoiceQuestion).criteria)[0]))
    );
    const r = runner();
    await r.start('Search', 7);

    expect(r.getProgress().status).toBe('blocked');
    expect(r.getProgress().lastError).toMatch(/no change/);
    const acts = page.sent.filter((m) => m.type === 'CONTENT_ACT');
    expect(acts.map((m) => m.action.id)).toEqual(['e1', 'e1', 'e3']); // e1 suppressed after two misses
    const secondRequest = jev.mock.calls[1][1];
    expect((secondRequest.questions.operation.instructions as any).ineffective_action_alert).toMatch(/NO visible change/);
  });

  it('asks the text helper once and reuses its value when the first attempt was stale', async () => {
    const typeText = {
      type_text_target: { choice: '2', confidence: 0.8, probabilities: { '2': 1 } },
    };
    jev.mockResolvedValueOnce(answer('TYPE_TEXT', typeText))
      .mockResolvedValueOnce(answer('TYPE_TEXT', typeText))
      .mockResolvedValueOnce(answer('DONE'));
    textHelper.mockResolvedValue('Zurich');
    let attempts = 0;
    page.act = (_action, text) => {
      attempts++;
      if (attempts === 1) return { ok: false, code: 'stale', message: 'Page changed' };
      page.snapshot = snapshot({ text: `typed ${text}` });
      return { ok: true, via: 'synthetic' };
    };
    const r = runner();
    await r.start('Fly from Zurich', 7);

    expect(textHelper).toHaveBeenCalledTimes(1);
    expect(textHelper.mock.calls[0][1].field.label).toBe('Where from?');
    const acts = page.sent.filter((m) => m.type === 'CONTENT_ACT');
    expect(acts.map((m) => m.text)).toEqual(['Zurich', 'Zurich']);
    expect(r.getProgress().logs[1]).toMatchObject({ operation: 'TYPE_TEXT', targetValue: 'Zurich' });
  });

  it('asks once more after an invalid answer, and stops with an error if it repeats', async () => {
    const invalid = { model: 'm', answers: { operation: { choice: 'CLICK', probabilities: { CLICK: 0.2, DONE: 0.8 } } } };
    jev.mockResolvedValueOnce(invalid).mockResolvedValueOnce(invalid);
    const r = runner();
    await r.start('Search', 7);

    expect(r.getProgress().status).toBe('error');
    expect(r.getProgress().lastError).toMatch(/Invalid operation choice/);
    expect(jev).toHaveBeenCalledTimes(2);
    expect(page.sent.filter((m) => m.type === 'CONTENT_ACT')).toHaveLength(0);
  });

  it('recovers when the model answers consistently on the second try', async () => {
    const invalid = { model: 'm', answers: { operation: { choice: 'CLICK', probabilities: { CLICK: 0.2, DONE: 0.8 } } } };
    jev.mockResolvedValueOnce(invalid).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Search', 7);
    expect(r.getProgress().status).toBe('done');
  });

  it('single-steps: pauses after one action, continues on the same goal, restarts on a new goal', async () => {
    jev.mockResolvedValue(answer('CLICK', clickTarget('1')));
    page.act = () => {
      page.snapshot = snapshot({ text: `step ${Date.now()}${Math.random()}` });
      return { ok: true, via: 'synthetic' };
    };
    const r = runner();
    await r.step('Goal A', 7);
    expect(r.getProgress()).toMatchObject({ status: 'paused', goal: 'Goal A', currentStep: 1 });

    await r.step('Goal A', 7);
    expect(r.getProgress()).toMatchObject({ status: 'paused', currentStep: 2 });
    expect(jev.mock.calls[1][1].state.recent_actions).toHaveLength(1);

    await r.step('Goal B', 7);
    expect(r.getProgress()).toMatchObject({ status: 'paused', goal: 'Goal B', currentStep: 1 });
    expect(jev.mock.calls[2][1].state.recent_actions).toEqual([]);

    r.stop();
    expect(r.getProgress().status).toBe('idle');
  });

  it('stops at the step budget', async () => {
    jev.mockImplementation(async (_s, request) =>
      answer('CLICK', clickTarget(Object.keys((request.questions.click_target as ChoiceQuestion).criteria)[0]))
    );
    let n = 0;
    page.act = () => {
      n++;
      page.snapshot = snapshot({
        text: `page ${n}`,
        actions: [{ id: 'e1', node: 10 + n, kind: 'click', role: 'link', label: `Result ${n}` }, { id: 'wait', kind: 'wait', label: 'Wait' }],
      });
      return { ok: true, via: 'synthetic' };
    };
    const r = runner();
    await r.start('Loop forever', 7);
    expect(r.getProgress().status).toBe('blocked');
    expect(r.getProgress().currentStep).toBe(5);
  });

  it('does not observe an internal page when choosing a starting URL fails', async () => {
    const chromeMock = installChrome(page);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'chrome://extensions', status: 'complete' } as any);
    const r = runner();
    startingUrl.mockRejectedValueOnce(new Error('No API key for starting URL'));
    jev.mockResolvedValueOnce(startupAnswer('OPEN_TAB'));
    await r.start('Anything', 7);
    expect(r.getProgress().status).toBe('error');
    expect(r.getProgress().lastError).toMatch(/No API key/);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(jev).toHaveBeenCalledOnce();
  });
});

describe('isNavigationError', () => {
  it('recognises every wording Chrome uses when the page navigated mid-message', async () => {
    const { isNavigationError } = await import('../src/background/agent');
    for (const m of [
      'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
      'The message port closed before a response was received.',
      'Could not establish connection. Receiving end does not exist.',
      'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.',
      'Frame was removed.',
      'Extension context invalidated.',
    ]) expect(isNavigationError(m), m).toBe(true);
    expect(isNavigationError('Target element is not a <select> element')).toBe(false);
  });
});

describe('covered targets', () => {
  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('tells the model about a covered target and withholds it after two misses', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: false, code: 'covered', message: 'Target is covered by another element. Observe again.' }), sent: [] };
    installChrome(page);
    jev.mockImplementation(async (_s, request) => {
      const keys = Object.keys((request.questions.click_target as ChoiceQuestion).criteria);
      return answer('CLICK', clickTarget(keys[0]));
    });
    const r = runner();
    await r.start('Search', 7);

    const second = jev.mock.calls[1][1];
    expect((second.questions.operation.instructions as any).ineffective_action_alert).toMatch(/could not be acted on/);
    // e1 (target "1") is withheld from the third decision, so the model is offered e3 instead.
    const third = jev.mock.calls[2][1];
    expect(Object.keys((third.questions.click_target as ChoiceQuestion).criteria)).toEqual(['2']);
    expect(r.getProgress().status).toBe('error');
    expect(r.getProgress().currentStep).toBe(0);
  });
});

describe('text helper refusal', () => {
  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('continues with a notice instead of ending the run when the helper finds no value', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    const typeText = { type_text_target: { choice: '2', confidence: 0.8, probabilities: { '2': 1 } } };
    jev.mockResolvedValueOnce(answer('TYPE_TEXT', typeText)).mockResolvedValueOnce(answer('DONE'));
    textHelper.mockImplementationOnce(async () => parseFieldText('{"text":null}'));
    const r = runner();
    await r.start('Reach the Eiffel Tower article using only links', 7);

    expect(r.getProgress().status).toBe('done');
    expect(page.sent.filter((m) => m.type === 'CONTENT_ACT')).toHaveLength(0);
    expect((jev.mock.calls[1][1].questions.operation.instructions as any).ineffective_action_alert).toMatch(/No value for the field/);
    expect((jev.mock.calls[1][1].questions.operation as ChoiceQuestion).criteria).not.toHaveProperty('TYPE_TEXT');
    expect(jev.mock.calls[1][1].questions).not.toHaveProperty('type_text_target');
  });

  it('recovers through another control and allows typing again after the page changes', async () => {
    const page: Page = { snapshot: snapshot(), act: () => {
      page.snapshot = snapshot({ text: 'Chat composer opened' });
      return { ok: true, via: 'synthetic' };
    }, sent: [] };
    installChrome(page);
    const typeText = { type_text_target: { choice: '2', confidence: 0.8, probabilities: { '2': 1 } } };
    jev.mockResolvedValueOnce(answer('TYPE_TEXT', typeText))
      .mockResolvedValueOnce(answer('CLICK', clickTarget('1')))
      .mockResolvedValueOnce(answer('TYPE_TEXT', typeText))
      .mockResolvedValueOnce(answer('DONE'));
    textHelper.mockImplementationOnce(async () => parseFieldText('{"text":null}'))
      .mockResolvedValueOnce('Tell me a joke');
    const r = runner();
    await r.start('Ask for a joke.', 7);
    expect(r.getProgress().status).toBe('done');
    expect(r.getProgress().currentStep).toBe(2);
    expect(jev.mock.calls[1][1].questions).not.toHaveProperty('type_text_target');
    expect(jev.mock.calls[2][1].questions).toHaveProperty('type_text_target');
    const acts = page.sent.filter(m => m.type === 'CONTENT_ACT');
    expect(acts.map(m => m.action.kind)).toEqual(['click', 'fill']);
    expect(acts[1].text).toBe('Tell me a joke');
    expect(textHelper).toHaveBeenCalledTimes(2);
  });

  it('pauses Step after rejection, retaining the excluded field and feedback for the next Step', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    jev.mockResolvedValueOnce(answer('TYPE_TEXT', { type_text_target: { choice: '2', confidence: 1, probabilities: { '2': 1 } } }))
      .mockResolvedValueOnce(answer('CLICK', clickTarget('1')));
    textHelper.mockImplementationOnce(async () => parseFieldText('{"text":null}'));
    const r = runner();
    await r.step('Ask for a joke.', 7);
    expect(r.getProgress().status).toBe('paused');
    expect(r.getProgress().currentStep).toBe(0);
    expect(page.sent.filter(m => m.type === 'CONTENT_ACT')).toHaveLength(0);
    await r.step('Ask for a joke.', 7);
    expect(r.getProgress().status).toBe('paused');
    expect(r.getProgress().currentStep).toBe(1);
    expect(jev.mock.calls[1][1].questions).not.toHaveProperty('type_text_target');
    expect(textHelper).toHaveBeenCalledTimes(1);
  });

  it('includes the field rejection even when a previous browser action also made no progress', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1')))
      .mockResolvedValueOnce(answer('TYPE_TEXT', { type_text_target: { choice: '2', confidence: 1, probabilities: { '2': 1 } } }))
      .mockResolvedValueOnce(answer('DONE'));
    textHelper.mockImplementationOnce(async () => parseFieldText('{"text":null}'));
    const r = runner();
    await r.start('Ask for a joke.', 7);
    const feedback = (jev.mock.calls[2][1].questions.operation.instructions as any).ineffective_action_alert;
    expect(feedback).toMatch(/NO visible change/);
    expect(feedback).toMatch(/No value for the field/);
    expect(jev.mock.calls[2][1].questions).not.toHaveProperty('type_text_target');
    expect(r.getProgress().status).toBe('done');
  });

  it('stops after four consecutive rejected fields without typing or consuming action steps', async () => {
    const page: Page = { snapshot: snapshot({ actions: Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, node: i, kind: 'fill', label: `Field ${i}` })) }), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    jev.mockImplementation(async (_settings, request) => {
      const key = Object.keys((request.questions.type_text_target as ChoiceQuestion).criteria)[0];
      return answer('TYPE_TEXT', { type_text_target: { choice: key, confidence: 1, probabilities: { [key]: 1 } } });
    });
    textHelper.mockImplementation(async () => parseFieldText('{"text":null}'));
    const r = runner();
    await r.start('Ask for a joke.', 7);
    expect(r.getProgress().status).toBe('blocked');
    expect(r.getProgress().lastError).toMatch(/several selected fields/);
    expect(jev).toHaveBeenCalledTimes(4);
    expect(textHelper.mock.calls.map(([, context]) => context.field.label)).toEqual(['Field 0', 'Field 1', 'Field 2', 'Field 3']);
    expect(r.getProgress().currentStep).toBe(0);
    expect(page.sent.filter(m => m.type === 'CONTENT_ACT')).toHaveLength(0);
  });

  it('keeps malformed helper replies fatal even when their error says nothing written', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    jev.mockResolvedValueOnce(answer('TYPE_TEXT', { type_text_target: { choice: '2', confidence: 1, probabilities: { '2': 1 } } }));
    textHelper.mockImplementationOnce(async () => parseFieldText('{"text":""}'));
    const r = runner();
    await r.start('Ask for a joke.', 7);
    expect(r.getProgress().status).toBe('error');
    expect(r.getProgress().lastError).toMatch(/invalid value/);
    expect(jev).toHaveBeenCalledTimes(1);
    expect(page.sent.filter(m => m.type === 'CONTENT_ACT')).toHaveLength(0);
  });

  it('still stops on a real helper failure such as a bad API key', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    jev.mockResolvedValue(answer('TYPE_TEXT', { type_text_target: { choice: '2', confidence: 0.8, probabilities: { '2': 1 } } }));
    textHelper.mockRejectedValue(new Error('Text helper error (HTTP 401): bad key'));
    const r = runner();
    await r.start('Type something', 7);
    expect(r.getProgress().status).toBe('error');
    expect(jev).toHaveBeenCalledTimes(1);
  });
});

describe('hesitant verdicts', () => {
  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const hesitant = (choice: string) => ({
    model: 'm',
    answers: { operation: { choice, confidence: 0.3, probabilities: { [choice]: 0.4, CLICK: 0.35, WAIT: 0.25 } } },
  });

  it('takes a second look before accepting a low-confidence BLOCKED, and continues if the model changes its mind', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    jev.mockResolvedValueOnce(hesitant('BLOCKED')).mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Search', 7);
    expect(r.getProgress().status).toBe('done');
    expect(page.sent.filter((m) => m.type === 'CONTENT_ACT')).toHaveLength(1);
    expect(jev).toHaveBeenCalledTimes(3);
  });

  it('ends the run when the low-confidence verdict repeats', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    jev.mockResolvedValue(hesitant('BLOCKED'));
    const r = runner();
    await r.start('Search', 7);
    expect(r.getProgress().status).toBe('blocked');
    expect(jev).toHaveBeenCalledTimes(2);
  });
});

describe('repeated toggles', () => {
  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('warns after the second repeat of a page-changing toggle and blocks after the third', async () => {
    // Every click on e1 changes the page (a menu opening and closing), so no-change detection never fires.
    let flips = 0;
    const page: Page = {
      snapshot: snapshot(),
      act: () => { page.snapshot = snapshot({ text: `menu state ${++flips % 2}` }); return { ok: true, via: 'synthetic' }; },
      sent: [],
    };
    installChrome(page);
    jev.mockImplementation(async (_s, request) => {
      const keys = Object.keys((request.questions.click_target as ChoiceQuestion).criteria);
      return answer('CLICK', clickTarget(keys[0]));
    });
    const r = runner();
    await r.start('Find flights', 7);

    const acts = page.sent.filter((m) => m.type === 'CONTENT_ACT').map((m) => m.action.id);
    expect(acts.slice(0, 2)).toEqual(['e1', 'e1']);
    expect((jev.mock.calls[2][1].questions.operation.instructions as any).ineffective_action_alert).toMatch(/executed 2 times/);
    // After the warning e1 is withheld, so the model gets e3 and no longer repeats e1.
    expect(Object.keys((jev.mock.calls[2][1].questions.click_target as ChoiceQuestion).criteria)).toEqual(['2']);
  });

  it('blocks when the same control keeps being chosen despite the warning', async () => {
    let flips = 0;
    const page: Page = {
      snapshot: snapshot({ actions: [{ id: 'e1', node: 1, kind: 'click', role: 'button', label: 'Google apps' }, { id: 'wait', kind: 'wait', label: 'Wait' }] }),
      act: () => { page.snapshot = snapshot({ text: `apps ${++flips % 2}`, actions: [{ id: 'e1', node: 1, kind: 'click', role: 'button', label: 'Google apps' }, { id: 'wait', kind: 'wait', label: 'Wait' }] }); return { ok: true, via: 'synthetic' }; },
      sent: [],
    };
    installChrome(page);
    jev.mockResolvedValue(answer('CLICK', clickTarget('1')));
    const r = runner();
    await r.start('Find flights', 7);
    expect(r.getProgress().status).toBe('blocked');
    expect(r.getProgress().lastError).toMatch(/repeated 3 times/);
    expect(page.sent.filter((m) => m.type === 'CONTENT_ACT')).toHaveLength(3);
  });
});

describe('cross-checks and outcomes', () => {
  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const withChecks = (base: any, goalDone: number, stuck: number) => ({
    ...base,
    answers: { ...base.answers, goal_done: { type: 'noul', noul: goalDone }, stuck: { type: 'noul', noul: stuck } },
  });

  it('vetoes DONE when the goal check disagrees, withholds DONE once, and tells the model why', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    jev
      .mockResolvedValueOnce(withChecks(answer('DONE'), 0.1, 0.05))
      .mockResolvedValueOnce(withChecks({ model: 'm', answers: { operation: { choice: 'CLICK', confidence: 0.9, probabilities: { CLICK: 0.9, WAIT: 0.1 } }, ...clickTarget('1') } }, 0.2, 0.05))
      .mockResolvedValueOnce(withChecks(answer('DONE'), 0.9, 0.05));
    const r = runner();
    await r.start('Search and open results', 7);

    const second = jev.mock.calls[1][1];
    expect(Object.keys((second.questions.operation as ChoiceQuestion).criteria)).not.toContain('DONE');
    expect((second.questions.operation.instructions as any).ineffective_action_alert).toMatch(/not achieved yet \(probability 0.10\)/);
    expect(Object.keys((jev.mock.calls[2][1].questions.operation as ChoiceQuestion).criteria)).toContain('DONE');
    expect(r.getProgress().status).toBe('done');
    expect(r.getProgress().logs.map((l) => l.operation)).toEqual(['DONE', 'CLICK', 'DONE (vetoed)']);
  });

  it('bounds alternating DONE/BLOCKED contradictions instead of spending the model-call budget', async () => {
    const page: Page = { snapshot: snapshot(), act: vi.fn(), sent: [] };
    installChrome(page);
    jev.mockImplementation(async (_settings, request) => {
      const choices = (request.questions.operation as ChoiceQuestion).criteria;
      const choice = choices.BLOCKED ? 'BLOCKED' : 'DONE';
      return withChecks(startupAnswer(choice), 0.07, 0);
    });
    const r = runner();
    r.setSettings({ ...DEFAULT_SETTINGS, stepDelayMs: 0, maxSteps: 30 });
    await r.start('Example', 7);
    expect(jev).toHaveBeenCalledTimes(2);
    expect(r.getProgress()).toMatchObject({ status: 'blocked', currentStep: 0 });
    expect(r.getProgress().lastError).toContain('one reconsideration');
    expect(page.act).not.toHaveBeenCalled();
    expect(textHelper).not.toHaveBeenCalled();
  });

  it('bounds alternating low-confidence verdicts even when cross-checks are absent', async () => {
    const page: Page = { snapshot: snapshot(), act: vi.fn(), sent: [] };
    installChrome(page);
    jev.mockResolvedValueOnce({ ...startupAnswer('DONE'), answers: { operation: { choice: 'DONE', confidence: 0.2, probabilities: { DONE: 1 } } } })
      .mockResolvedValueOnce({ ...startupAnswer('BLOCKED'), answers: { operation: { choice: 'BLOCKED', confidence: 0.2, probabilities: { BLOCKED: 1 } } } });
    const r = runner();
    await r.start('Example', 7);
    expect(jev).toHaveBeenCalledTimes(2);
    expect(r.getProgress().status).toBe('blocked');
    expect(page.act).not.toHaveBeenCalled();
  });

  it('describes outcomes in words and sends run progress in the state', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installChrome(page);
    let n = 0;
    page.act = () => {
      n++;
      page.snapshot = n === 1 ? snapshot({ text: snapshot().text + ' menu opened with many more words than before it was' }) : snapshot({ url: 'https://example.com/results', title: 'Results' });
      return { ok: true, via: 'synthetic' };
    };
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Search', 7);

    const third = jev.mock.calls[2][1].state;
    expect(third.recent_actions.map((a: any) => a.outcome)).toEqual([
      'page content changed (something opened, closed or loaded; same URL)',
      'navigated to https://example.com/results',
    ]);
    expect(third.run).toEqual({ start_url: 'https://example.com/', steps_taken: 2, visited_urls: ['https://example.com/', 'https://example.com/results'] });
  });
});

describe('navigation started by an action', () => {
  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('waits for the tab to finish loading before observing again', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const chromeMock = installChrome(page);
    let loading = false;
    let listener: ((tabId: number, info: { status?: string }) => void) | null = null;
    chromeMock.tabs.get.mockImplementation(async () => ({ id: 7, url: 'https://example.com/', status: loading ? 'loading' : 'complete' }));
    chromeMock.tabs.onUpdated.addListener.mockImplementation((fn: any) => {
      listener = fn;
      // The page finishes loading shortly after the agent starts waiting.
      setTimeout(() => { loading = false; page.snapshot = snapshot({ url: 'https://example.com/sorted', text: 'sorted results' }); fn(7, { status: 'complete' }); }, 30);
    });
    page.act = () => { loading = true; return { ok: true, via: 'synthetic' }; };
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Sort by rating', 7);

    expect(listener).not.toBeNull();
    expect(jev.mock.calls[1][1].state.page.url).toBe('https://example.com/sorted');
    expect(jev.mock.calls[1][1].state.recent_actions[0].outcome).toBe('navigated to https://example.com/sorted');
  });
});

describe('links that open a new tab', () => {
  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('follows a tab opened by the click, observes there, and returns when it closes', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const chromeMock = installChrome(page);
    const observedTabs: number[] = [];
    chromeMock.tabs.sendMessage.mockImplementation(async (tabId: number, msg: any) => {
      page.sent.push(msg);
      if (msg.type === 'CONTENT_OBSERVE') {
        observedTabs.push(tabId);
        return { success: true, snapshot: tabId === 8 ? snapshot({ url: 'https://example.com/docs', title: 'Docs' }) : page.snapshot };
      }
      if (msg.type === 'CONTENT_ACT') {
        // The click opens a new tab; Chrome reports it with the opener id.
        created.forEach((fn) => fn({ id: 8, openerTabId: 7 }));
        return { ok: true, via: 'synthetic' };
      }
      return { pong: true };
    });
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Open the documentation', 7);

    expect(observedTabs).toEqual([7, 8]);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(8, { active: true });
    const second = jev.mock.calls[1][1].state;
    expect(second.page.url).toBe('https://example.com/docs');
    expect(second.recent_actions[0].outcome).toBe('opened a new tab and switched to it: https://example.com/docs');
    expect(r.getProgress().status).toBe('done');
  });

  it('ignores history and user-opened tabs while the model is deciding', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const browser = installChrome(page);
    jev.mockImplementationOnce(async () => {
      created.forEach(fn => fn({ id: 8, openerTabId: 7, url: 'chrome-extension://test/history.html' }));
      created.forEach(fn => fn({ id: 9, openerTabId: 7, url: 'https://example.com/other' }));
      return answer('CLICK', clickTarget('1'));
    }).mockResolvedValueOnce(answer('DONE'));
    // Extension UI must also be ignored if opened during an action.
    page.act = () => {
      created.forEach(fn => fn({ id: 10, openerTabId: 7, pendingUrl: 'chrome-extension://test/history.html' }));
      return { ok: true, via: 'synthetic' };
    };
    await runner().start('Search', 7);
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage.mock.calls.filter(([, msg]) => msg.type === 'CONTENT_OBSERVE').map(([id]) => id)).toEqual([7, 7]);
  });

  it('ignores tabs opened by other tabs or outside a run', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const chromeMock = installChrome(page);
    const observedTabs: number[] = [];
    chromeMock.tabs.sendMessage.mockImplementation(async (tabId: number, msg: any) => {
      page.sent.push(msg);
      if (msg.type === 'CONTENT_OBSERVE') { observedTabs.push(tabId); return { success: true, snapshot: page.snapshot }; }
      if (msg.type === 'CONTENT_ACT') { created.forEach((fn) => fn({ id: 9, openerTabId: 99 })); return { ok: true, via: 'synthetic' }; }
      return { pong: true };
    });
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Stay here', 7);
    expect(observedTabs).toEqual([7, 7]);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });
});

describe('trusted input (chrome.debugger)', () => {
  function installDebugger(page: Page, opts: { prepare?: (msg: any) => any; sendCommand?: (method: string, params: any) => any } = {}) {
    const chromeMock = installChrome(page);
    const commands: Array<{ method: string; params: any }> = [];
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId: number, msg: any) => {
      page.sent.push(msg);
      switch (msg.type) {
        case 'PING': return { pong: true };
        case 'CONTENT_OBSERVE': return { success: true, snapshot: page.snapshot };
        case 'CONTENT_PREPARE': return opts.prepare ? opts.prepare(msg) : { ok: true, done: false, x: 40, y: 50 };
        case 'CONTENT_DISPATCH': return { ok: true, via: 'synthetic' };
        case 'CONTENT_ACT': return page.act(msg.action, msg.text);
        default: return { ok: true };
      }
    });
    const debuggerMock = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_t: any, method: string, params: any) => {
        commands.push({ method, params });
        return opts.sendCommand ? opts.sendCommand(method, params) : {};
      }),
      onDetach: { addListener: vi.fn() },
    };
    vi.stubGlobal('chrome', { ...chromeMock, debugger: debuggerMock });
    return { chromeMock, debuggerMock, commands };
  }

  beforeEach(() => {
    jev.mockReset();
    textHelper.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('prepares in the page, clicks through the debugger at the returned point, settles, then detaches when done', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const { debuggerMock, commands } = installDebugger(page);
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Search', 7);

    expect(debuggerMock.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(page.sent.map((m) => m.type).filter((t) => t !== 'CONTENT_STATUS')).toEqual(['PING', 'CONTENT_OBSERVE', 'CONTENT_PREPARE', 'CONTENT_SETTLE', 'PING', 'CONTENT_OBSERVE']);
    expect(page.sent.filter((m) => m.type === 'CONTENT_ACT')).toHaveLength(0);
    expect(commands.map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(commands[1].params).toMatchObject({ x: 40, y: 50 });
    expect(r.getProgress().status).toBe('done');
    expect(r.getProgress().inputNote).toBeUndefined();
    expect(debuggerMock.detach).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('does not attach while observing or deciding, and releases before the next model call', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const { debuggerMock } = installDebugger(page);
    jev.mockImplementationOnce(async () => {
      expect(debuggerMock.attach).not.toHaveBeenCalled();
      return answer('CLICK', clickTarget('1'));
    }).mockImplementationOnce(async () => {
      expect(debuggerMock.detach).toHaveBeenCalledWith({ tabId: 7 });
      return answer('DONE');
    });
    await runner().start('Search', 7);
    expect(debuggerMock.attach).toHaveBeenCalledTimes(1);
  });

  it('never attaches for a task that only observes and finishes', async () => {
    const page: Page = { snapshot: snapshot(), act: vi.fn(), sent: [] };
    const { debuggerMock } = installDebugger(page);
    jev.mockResolvedValue(answer('DONE'));
    await runner().start('Example', 7);
    expect(debuggerMock.attach).not.toHaveBeenCalled();
  });

  it('releases failed preparation and does not keep a debugger session during reconsideration', async () => {
    const page: Page = { snapshot: snapshot(), act: vi.fn(), sent: [] };
    const { debuggerMock } = installDebugger(page, { prepare: () => ({ ok: false, code: 'covered', message: 'Covered' }) });
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockImplementationOnce(async () => {
      expect(debuggerMock.detach).toHaveBeenCalledWith({ tabId: 7 });
      return answer('BLOCKED');
    });
    await runner().start('Search', 7);
    expect(debuggerMock.sendCommand).not.toHaveBeenCalled();
  });

  it('stopping during attachment releases the late session and sends no input', async () => {
    const page: Page = { snapshot: snapshot(), act: vi.fn(), sent: [] };
    const { debuggerMock } = installDebugger(page);
    const r = runner();
    debuggerMock.attach.mockImplementation(async () => { r.stop(); });
    jev.mockResolvedValue(answer('CLICK', clickTarget('1')));
    await r.start('Search', 7);
    expect(debuggerMock.detach).toHaveBeenCalledWith({ tabId: 7 });
    expect(debuggerMock.sendCommand).not.toHaveBeenCalled();
    expect(page.sent.some(m => ['CONTENT_ACT', 'CONTENT_PREPARE', 'CONTENT_DISPATCH'].includes(m.type))).toBe(false);
    expect(r.getProgress().status).toBe('idle');
  });

  it('types by clicking the field and inserting the helper text as one trusted input', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const { commands } = installDebugger(page);
    textHelper.mockResolvedValue('Paris');
    jev
      .mockResolvedValueOnce(answer('TYPE_TEXT', { type_text_target: { choice: '2', confidence: 0.8, probabilities: { '2': 1 } } }))
      .mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Fly from Paris', 7);

    const prepare = page.sent.find((m) => m.type === 'CONTENT_PREPARE');
    expect(prepare).toMatchObject({ action: { id: 'e2' }, text: 'Paris' });
    expect(commands.map((c) => c.method)).toEqual([
      'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.insertText',
    ]);
    expect(commands[3].params).toEqual({ text: 'Paris' });
  });

  it('treats a covered target reported by prepare as a miss and looks again', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    let calls = 0;
    const { commands } = installDebugger(page, {
      prepare: () => (++calls === 1 ? { ok: false, code: 'covered', message: 'Target is covered by another element (div.modal).' } : { ok: true, done: false, x: 1, y: 2 }),
    });
    jev
      .mockResolvedValueOnce(answer('CLICK', clickTarget('1')))
      .mockResolvedValueOnce(answer('CLICK', clickTarget('1')))
      .mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Search', 7);

    expect(commands).toHaveLength(3); // only the second attempt reached the debugger
    const notice = jev.mock.calls[1][1].state.recent_actions ?? [];
    expect(JSON.stringify(jev.mock.calls[1][1])).toContain('div.modal');
    expect(notice.length).toBe(0); // nothing was executed on the first attempt
    expect(r.getProgress().status).toBe('done');
  });

  it('falls back to synthetic dispatch on the prepared target when the debugger command throws', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    installDebugger(page, { sendCommand: () => { throw new Error('Debugger is not attached to the tab with id: 7.'); } });
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Search', 7);

    expect(page.sent.map((m) => m.type)).toContain('CONTENT_DISPATCH');
    expect(r.getProgress().status).toBe('done');
  });

  it('uses the in-page path and says why when the debugger refuses to attach', async () => {
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const { chromeMock, debuggerMock } = installDebugger(page);
    debuggerMock.attach.mockRejectedValue(new Error('Another debugger is already attached to the tab with id: 7.'));
    vi.stubGlobal('chrome', { ...chromeMock, debugger: debuggerMock });
    jev.mockResolvedValueOnce(answer('CLICK', clickTarget('1'))).mockResolvedValueOnce(answer('DONE'));
    const r = runner();
    await r.start('Search', 7);

    expect(page.sent.filter((m) => m.type === 'CONTENT_ACT')).toHaveLength(1);
    expect(r.getProgress().inputNote).toMatch(/Could not attach/);
  });
});

describe('new-tab startup', () => {
  let page: Page;
  let browser: ReturnType<typeof installChrome>;
  let url: string;
  beforeEach(() => {
    jev.mockReset();
    startingUrl.mockReset();
    page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    browser = installChrome(page);
    url = 'chrome://newtab/';
    browser.tabs.get.mockImplementation(async (id = 7) => ({ id, url: id === 8 ? 'https://example.com/' : url, status: 'complete', windowId: 3 }));
    browser.tabs.update.mockImplementation(async (_id: number, changes: any) => { url = changes.url; return {} as any; });
    startingUrl.mockResolvedValue('https://example.com/');
    jev.mockResolvedValue(startupAnswer('OPEN_TAB'));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Run decides to open a page before requesting a URL and continues with decisions', async () => {
    jev.mockResolvedValueOnce(startupAnswer('OPEN_TAB')).mockResolvedValue(answer('DONE', { goal_done: { probability: 1 } }));
    const r = runner();
    await r.start('Find flights', 7);
    expect(startingUrl).toHaveBeenCalledOnce();
    expect(jev.mock.invocationCallOrder[0]).toBeLessThan(startingUrl.mock.invocationCallOrder[0]);
    expect(jev.mock.calls[0][1].state.elements).toEqual([]);
    expect(jev.mock.calls[0][1].state.browser).toEqual({ active_tab_id: 7, open_tabs: [] });
    expect(browser.tabs.update).toHaveBeenCalledWith(7, { url: 'https://example.com/' });
    expect(r.getProgress().status).toBe('done');
    expect(r.getProgress().currentStep).toBe(1);
    expect(r.getProgress().logs.at(-1)).toMatchObject({ operation: 'NAVIGATE', targetValue: 'https://example.com/' });
    expect(jev.mock.calls[1][1].state.recent_actions[0]).toMatchObject({ kind: 'navigate', page_changed: true });
  });

  it('does not fall back to the helper when the decision provider fails', async () => {
    jev.mockRejectedValueOnce(new Error('Decision API unavailable'));
    const r = runner();
    await r.start('Find WhatsApp', 7);
    expect(r.getProgress().status).toBe('error');
    expect(r.getProgress().lastError).toContain('Decision API unavailable');
    expect(startingUrl).not.toHaveBeenCalled();
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it.each(['BLOCKED', 'CLICK', 'DONE'])('never invokes the helper for startup choice %s', async choice => {
    jev.mockResolvedValue(startupAnswer(choice));
    const r = runner();
    await r.start('Find WhatsApp', 7);
    expect(r.getProgress().status).toBe(choice === 'BLOCKED' ? 'blocked' : 'error');
    expect(startingUrl).not.toHaveBeenCalled();
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(jev.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it.each(['stop', 'manual navigation'] as const)('does not call the helper after %s while the decision is pending', async action => {
    let complete!: (value: ReturnType<typeof answer>) => void;
    jev.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const r = runner();
    const run = r.start('Find WhatsApp', 7);
    await vi.waitFor(() => expect(jev).toHaveBeenCalledOnce());
    expect(startingUrl).not.toHaveBeenCalled();
    if (action === 'stop') r.stop();
    else url = 'https://another.example/';
    complete(startupAnswer('OPEN_TAB'));
    await run;
    expect(startingUrl).not.toHaveBeenCalled();
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(r.getProgress().status).toBe(action === 'stop' ? 'idle' : 'error');
  });

  it.each(['chrome://newtab/', 'chrome://new-tab-page/', 'about:blank'])('Step bootstraps %s, then resumes normally', async (startingPage) => {
    url = startingPage;
    const r = runner();
    await r.step('Find flights', 7);
    expect(r.getProgress().status).toBe('paused');
    expect(r.getProgress().currentStep).toBe(1);
    expect(jev).toHaveBeenCalledOnce();
    jev.mockResolvedValue(answer('DONE'));
    await r.step('Find flights', 7);
    expect(r.getProgress().status).toBe('done');
    expect(startingUrl).toHaveBeenCalledOnce();
  });

  it('does not bootstrap an ordinary page', async () => {
    url = 'https://example.com/';
    jev.mockResolvedValue(answer('DONE'));
    await runner().start('Find flights', 7);
    expect(startingUrl).not.toHaveBeenCalled();
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it.each(['chrome://settings/', 'chrome://extensions/?id=extension', 'chrome-extension://other/options.html', 'devtools://devtools/', 'view-source:https://example.com/'])('opens a web tab from %s without touching the original page', async (internal) => {
    url = internal;
    const r = runner();
    await r.step('Find flights', 7);
    expect(r.getProgress().status).toBe('paused');
    expect(r.getProgress().currentStep).toBe(1);
    expect(r.getProgress().inputNote).toBeUndefined();
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/', active: true, windowId: 3 });
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage.mock.calls.every(([id]) => id === 8)).toBe(true);
    expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    expect(url).toBe(internal);
    expect(jev).toHaveBeenCalledOnce();
    // A detached popup still targets the source id; it must resume in the task tab.
    jev.mockResolvedValue(answer('DONE'));
    await r.step('Find flights', 7);
    expect(r.getProgress().status).toBe('done');
    expect(startingUrl).toHaveBeenCalledOnce();
    expect(browser.tabs.create).toHaveBeenCalledOnce();
    expect(browser.tabs.sendMessage.mock.calls.filter(([, msg]) => msg.type === 'CONTENT_OBSERVE')[0][0]).toBe(8);
  });

  it('Run continues in the newly created task tab', async () => {
    url = 'chrome://extensions/';
    jev.mockResolvedValueOnce(startupAnswer('OPEN_TAB')).mockResolvedValue(answer('DONE'));
    const r = runner();
    await r.start('Find flights', 7);
    expect(r.getProgress().status).toBe('done');
    expect(r.getProgress().currentStep).toBe(1);
    expect(browser.tabs.create).toHaveBeenCalledOnce();
    expect(browser.tabs.sendMessage.mock.calls.filter(([, msg]) => msg.type === 'CONTENT_OBSERVE')[0][0]).toBe(8);
  });

  it('reports a failure to create a task tab without acting on the internal page', async () => {
    url = 'chrome://extensions/';
    browser.tabs.create.mockRejectedValueOnce(new Error('Could not create tab'));
    const r = runner();
    await r.start('Find flights', 7);
    expect(r.getProgress().status).toBe('error');
    expect(r.getProgress().lastError).toContain('Could not create tab');
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(jev).toHaveBeenCalledOnce();
  });

  it('stops before opening a task tab when Stop is pressed during URL selection', async () => {
    url = 'chrome://extensions/';
    let complete!: (value: string) => void;
    startingUrl.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const r = runner();
    const run = r.start('Find flights', 7);
    await vi.waitFor(() => expect(startingUrl).toHaveBeenCalledOnce());
    r.stop();
    complete('https://example.com/');
    await run;
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(r.getProgress().status).toBe('idle');
  });

  it.each(['No API key', 'Starting URL helper returned invalid JSON'])('leaves the tab unchanged on helper failure: %s', async (message) => {
    startingUrl.mockRejectedValueOnce(new Error(message));
    const r = runner();
    await r.start('Find flights', 7);
    expect(r.getProgress().lastError).toContain(message);
    expect(r.getProgress().status).toBe('error');
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(jev).toHaveBeenCalledOnce();
  });

  it('reports a navigation failure without attaching input after the startup decision', async () => {
    browser.tabs.update.mockRejectedValueOnce(new Error('Tab closed'));
    const r = runner();
    await r.start('Find flights', 7);
    expect(r.getProgress().status).toBe('error');
    expect(r.getProgress().lastError).toContain('Tab closed');
    expect(r.getProgress().inputNote).toBeUndefined();
    expect(jev).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'manual navigation'] as const)('does not navigate after %s while the helper is pending', async (action) => {
    let complete!: (value: string) => void;
    startingUrl.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const r = runner();
    const run = r.start('Find flights', 7);
    await vi.waitFor(() => expect(startingUrl).toHaveBeenCalledOnce());
    if (action === 'stop') r.stop();
    else url = 'https://another.example/';
    complete('https://example.com/');
    await run;
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(jev).toHaveBeenCalledOnce();
    expect(r.getProgress().status).toBe(action === 'stop' ? 'idle' : 'error');
  });

  it('does not let a stopped bootstrap error change the stopped status', async () => {
    let fail!: (error: Error) => void;
    startingUrl.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const r = runner();
    const run = r.start('Find flights', 7);
    await vi.waitFor(() => expect(startingUrl).toHaveBeenCalledOnce());
    r.stop();
    fail(new Error('Delayed request failure'));
    await run;
    expect(r.getProgress().status).toBe('idle');
    expect(r.getProgress().lastError).toBeUndefined();
  });

  it('does not request a starting URL when stopped during the initial tab lookup', async () => {
    let complete!: (value: any) => void;
    browser.tabs.get.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const r = runner();
    const run = r.start('Find flights', 7);
    await vi.waitFor(() => expect(browser.tabs.get).toHaveBeenCalled());
    r.stop();
    complete({ id: 7, url, status: 'complete' });
    await run;
    expect(startingUrl).not.toHaveBeenCalled();
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(r.getProgress().status).toBe('idle');
  });

  it('counts bootstrap navigation against the step budget', async () => {
    const r = runner();
    r.setSettings({ ...DEFAULT_SETTINGS, maxSteps: 1, stepDelayMs: 0 });
    await r.start('Find flights', 7);
    expect(r.getProgress().status).toBe('blocked');
    expect(r.getProgress().currentStep).toBe(1);
    expect(jev).toHaveBeenCalledOnce();
  });
});

describe('Browser tab operations', () => {
  let page: Page;
  let browser: ReturnType<typeof installChrome>;
  beforeEach(() => {
    jev.mockReset(); startingUrl.mockReset();
    page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    browser = installChrome(page);
    browser.tabs.query.mockResolvedValue([
      { id: 7, windowId: 1, url: 'https://example.com/', title: 'Source' },
      { id: 9, windowId: 1, url: 'https://www.youtube.com/', title: 'YouTube' },
      { id: 10, windowId: 1, url: 'chrome://settings/', title: 'Settings' },
      { id: 11, windowId: 1, incognito: true, url: 'https://private.example/', title: 'Private' },
    ]);
    browser.tabs.get.mockImplementation(async (id = 7) => ({ id, windowId: 1, status: 'complete', url: id === 9 ? 'https://www.youtube.com/' : 'https://example.com/' }));
    browser.tabs.update.mockImplementation(async (id: number) => ({ id, windowId: 1 } as any));
    startingUrl.mockResolvedValue('https://www.youtube.com/');
  });
  afterEach(() => vi.unstubAllGlobals());
  it('switches to an offered open tab, counts one step, and resumes from the source popup', async () => {
    jev.mockResolvedValueOnce(answer('SWITCH_TAB', { switch_tab_target: { choice: '9', confidence: 1, probabilities: { '9': 1 } } }));
    const r = runner(); await r.step('Find YouTube OLED videos', 7);
    expect(r.getProgress()).toMatchObject({ status: 'paused', currentStep: 1 });
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { active: true });
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect((jev.mock.calls[0][1].state.browser as any).open_tabs.map((tab: any) => tab.id)).toEqual([7, 9]);
    jev.mockResolvedValue(answer('DONE'));
    await r.step('Find YouTube OLED videos', 7);
    expect(r.getProgress().status).toBe('done');
  });
  it('opens a new task tab from an unrelated regular page without navigating the source', async () => {
    jev.mockResolvedValueOnce(answer('OPEN_TAB'));
    browser.tabs.create.mockResolvedValue({ id: 8, windowId: 1 } as any);
    const r = runner(); await r.step('Find YouTube OLED videos', 7);
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: 'https://www.youtube.com/', active: true, windowId: 1 });
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(r.getProgress().logs[0].operation).toBe('OPEN_TAB');
  });
  it('never switches to a tab id not offered to the model', async () => {
    jev.mockResolvedValueOnce(answer('SWITCH_TAB', { switch_tab_target: { choice: '11', confidence: 1, probabilities: { '11': 1 } } }));
    const r = runner(); await r.step('Go to YouTube', 7);
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(r.getProgress().status).toBe('error');
  });
  it('does not switch when the selected tab changed after observation', async () => {
    jev.mockImplementationOnce(async () => {
      browser.tabs.get.mockResolvedValue({ id: 9, url: 'https://other.example/', windowId: 1 } as any);
      return answer('SWITCH_TAB', { switch_tab_target: { choice: '9', confidence: 1, probabilities: { '9': 1 } } });
    });
    const r = runner(); await r.step('Go to YouTube', 7);
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(r.getProgress().currentStep).toBe(0);
  });
  it('does not open a tab when stopped while the helper chooses its URL', async () => {
    const r = runner(); jev.mockResolvedValueOnce(answer('OPEN_TAB'));
    startingUrl.mockImplementationOnce(async () => { r.stop(); return 'https://www.youtube.com/'; });
    await r.step('Find YouTube OLED videos', 7);
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
});

describe('Existing tab bootstrap', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([false, true])('follows the startup decision to reuse a tab or request a new destination (new=%s)', async (forceNew) => {
    jev.mockReset(); startingUrl.mockReset(); startingUrl.mockResolvedValue('https://www.youtube.com/');
    const page: Page = { snapshot: snapshot(), act: () => ({ ok: true, via: 'synthetic' }), sent: [] };
    const browser = installChrome(page);
    let sourceUrl = 'chrome://newtab/';
    browser.tabs.get.mockImplementation(async (id = 7) => ({ id, windowId: 1, status: 'complete', url: id === 7 ? sourceUrl : 'https://www.youtube.com/' }));
    browser.tabs.update.mockImplementation(async (_id: number, changes: any) => { if (changes.url) sourceUrl = changes.url; return {} as any; });
    browser.tabs.query.mockResolvedValue([{ id: 9, windowId: 1, title: 'YouTube', url: 'https://www.youtube.com/' }]);
    jev.mockResolvedValueOnce(forceNew ? startupAnswer('OPEN_TAB') : startupAnswer('SWITCH_TAB', { switch_tab_target: { choice: '9', confidence: 1, probabilities: { '9': 1 } } }));
    const r = runner(); await r.step(forceNew ? 'Open a new tab for YouTube' : 'Find YouTube OLED tests', 7);
    expect(r.getProgress().status).toBe('paused');
    if (forceNew) expect(browser.tabs.update).toHaveBeenCalledWith(7, { url: 'https://www.youtube.com/' });
    else {
      expect(browser.tabs.update).toHaveBeenCalledWith(9, { active: true });
      expect(startingUrl).not.toHaveBeenCalled();
    }
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
});
