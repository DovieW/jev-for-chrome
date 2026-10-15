import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeJevModel, callJevProvider } from '../src/shared/providers';
import { callOpenAI } from '../src/shared/providers/openai';
import { DEFAULT_SETTINGS, JevRequest } from '../src/shared/types';

const request: JevRequest = {
  model: 'ignored',
  state: { task: 'Find flights', page: { url: 'https://example.com/', title: 'Example', text: '' }, elements: [], recent_actions: [] },
  questions: {
    operation: { type: 'choice', instructions: { rules: 'Choose an action' }, criteria: { CLICK: { label: 'Click' }, DONE: 'Done' } },
    click_target: { type: 'choice', instructions: 'Which target?', criteria: { '1': { element: 'Search' } } },
    goal_done: { type: 'noul', instructions: 'Achieved?' },
    stuck: { type: 'noul', instructions: 'Stuck?' },
  },
};
const choice = () => ({ name: 'operation', type: 'choice', choice: 'CLICK', confidence: 0.75, probabilities: [{ value: 'CLICK', probability: 0.9 }, { value: 'DONE', probability: 0.1 }] });
const response = () => ({ model: 'gpt-6-luna', answers: [choice(), { name: 'goal_done', type: 'predicate', probability: 0.1 }, { name: 'stuck', type: 'predicate', probability: 0.2 }], usage: { input_tokens: 100, output_tokens: 0 } });
const mockResponse = (json: unknown) => vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => json } as Response);
const config = { ...DEFAULT_SETTINGS.openai, apiKey: 'test-openai' };

describe('OpenAI Decisions adapter', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('translates requests and answers, preserving confidence and local singleton targets', async () => {
    mockResponse(response());
    const settings = { ...DEFAULT_SETTINGS, activeProvider: 'openai' as const, openai: config };
    expect(activeJevModel(settings)).toBe('gpt-6-luna');
    const result = await callJevProvider(settings, request);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/decisions');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-openai' });
    const body = JSON.parse(options!.body as string);
    expect(body.model).toBe('gpt-6-luna');
    expect(JSON.parse(body.input)).toEqual(request.state);
    expect(body).not.toHaveProperty('state');
    expect(body.questions).toEqual([
      { name: 'operation', type: 'choice', instructions: '{"rules":"Choose an action"}', choices: [{ value: 'CLICK', description: '{"label":"Click"}' }, { value: 'DONE', description: 'Done' }] },
      { name: 'goal_done', type: 'predicate', instructions: 'Achieved?' },
      { name: 'stuck', type: 'predicate', instructions: 'Stuck?' },
    ]);
    expect(result.answers.operation).toEqual({ choice: 'CLICK', confidence: 0.75, probabilities: { CLICK: 0.9, DONE: 0.1 } });
    expect(result.answers.click_target).toEqual({ choice: '1', confidence: 1, probabilities: { '1': 1 } });
    expect(result.answers.goal_done).toEqual({ type: 'noul', probability: 0.1 });
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 0 });
  });

  it('supports non-singleton target questions', async () => {
    const multi = { ...request, questions: { click_target: { type: 'choice' as const, instructions: 'Target?', criteria: { '1': 'First', '2': 'Second' } } } };
    mockResponse({ answers: [{ ...choice(), name: 'click_target', choice: '2', probabilities: [{ value: '1', probability: 0.1 }, { value: '2', probability: 0.9 }] }] });
    expect((await callOpenAI(config, multi)).answers.click_target.choice).toBe('2');
  });

  it.each([
    ['refusal', () => ({ answers: [{ name: 'operation', type: 'refusal' }] })],
    ['missing answers', () => ({ answers: [choice()] })],
    ['duplicate names', () => ({ answers: [choice(), choice()] })],
    ['unknown name', () => ({ answers: [{ ...choice(), name: 'unknown' }] })],
    ['wrong type', () => ({ answers: [{ name: 'operation', type: 'predicate', probability: 0.5 }] })],
    ['unknown choice', () => ({ answers: [{ ...choice(), choice: 'OTHER' }] })],
    ['duplicate values', () => ({ answers: [{ ...choice(), probabilities: [{ value: 'CLICK', probability: 0.5 }, { value: 'CLICK', probability: 0.5 }] }] })],
    ['invalid sum', () => ({ answers: [{ ...choice(), probabilities: [{ value: 'CLICK', probability: 0.1 }] }] })],
    ['choice mismatch', () => ({ answers: [{ ...choice(), choice: 'DONE' }] })],
    ['invalid predicate', () => ({ answers: [choice(), { name: 'goal_done', type: 'predicate', probability: 2 }] })],
  ] as const)('rejects %s before execution', async (_name, make) => {
    mockResponse(make());
    await expect(callOpenAI(config, request)).rejects.toThrow();
  });

  it('rejects missing credentials, unsupported questions, and oversized candidate sets without a request', async () => {
    await expect(callOpenAI(DEFAULT_SETTINGS.openai, request)).rejects.toThrow(/API Key/);
    await expect(callOpenAI(config, { ...request, questions: { score: { type: 'score', instructions: 'Rate' } } })).rejects.toThrow(/Unsupported/);
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), 'Target']));
    await expect(callOpenAI(config, { ...request, questions: { target: { type: 'choice', instructions: 'Pick', criteria } } })).rejects.toThrow(/candidates/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Operation-dependent OpenAI targets', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  const multi = (): JevRequest => ({ ...request, questions: {
    ...request.questions,
    operation: { type: 'choice', instructions: 'Choose operation', criteria: { CLICK: 'Click', OPEN_TAB: 'Open a tab' } },
    click_target: { type: 'choice', instructions: 'Click target', criteria: { '1': 'Unrelated link', '2': 'Unrelated button' } },
  } });
  const first = (op: string) => ({ ...response(), answers: [
    { ...choice(), choice: op, confidence: 1, probabilities: [{ value: 'CLICK', probability: op === 'CLICK' ? 1 : 0 }, { value: 'OPEN_TAB', probability: op === 'OPEN_TAB' ? 1 : 0 }] },
    ...response().answers.slice(1),
  ] });
  it('does not ask for irrelevant click targets when opening a tab', async () => {
    mockResponse(first('OPEN_TAB'));
    const result = await callOpenAI(config, multi());
    expect(result.answers.operation.choice).toBe('OPEN_TAB');
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.questions.map((q: any) => q.name)).toEqual(['operation', 'goal_done', 'stuck']);
  });
  it('asks only the chosen target in a second request and combines usage', async () => {
    mockResponse(first('CLICK'));
    mockResponse({ usage: { input_tokens: 60, output_tokens: 0 }, answers: [{ name: 'click_target', type: 'choice', choice: '2', confidence: 1, probabilities: [{ value: '1', probability: 0 }, { value: '2', probability: 1 }] }] });
    const result = await callOpenAI(config, multi());
    expect(result.answers.click_target.choice).toBe('2');
    expect(result.usage?.input_tokens).toBe(160);
    const second = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(second.questions.map((q: any) => q.name)).toEqual(['click_target']);
  });
  it('still refuses execution when the selected target is refused', async () => {
    mockResponse(first('CLICK'));
    mockResponse({ answers: [{ name: 'click_target', type: 'refusal' }] });
    await expect(callOpenAI(config, multi())).rejects.toThrow(/refused question "click_target"/);
  });
});

describe('Large open-tab target sets', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  it('selects from all offered tabs without truncating the last tab', async () => {
    const criteria = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(i), `Tab ${i}`]));
    mockResponse({ answers: [{ name: 'candidate_group', type: 'choice', choice: '1', confidence: 1, probabilities: [{ value: '0', probability: 0 }, { value: '1', probability: 1 }] }] });
    mockResponse({ answers: [{ name: 'switch_tab_target', type: 'choice', choice: '299', confidence: 1, probabilities: Array.from({ length: 45 }, (_, i) => ({ value: String(i + 255), probability: i === 44 ? 1 : 0 })) }] });
    const result = await callOpenAI(config, { ...request, questions: { switch_tab_target: { type: 'choice', instructions: 'Find the matching tab', criteria } } });
    expect(result.answers.switch_tab_target.choice).toBe('299');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
