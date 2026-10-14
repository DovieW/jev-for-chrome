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
