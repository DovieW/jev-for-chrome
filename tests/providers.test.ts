import { buildJevRequest } from '../src/shared/action-space';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callCloudflare } from '../src/shared/providers/cloudflare';
import { callJevProvider } from '../src/shared/providers/index';
import { callOpenRouter } from '../src/shared/providers/openrouter';
import { callTypeSafe, compactTypeSafeRequest } from '../src/shared/providers/typesafe';
import { AppSettings, DEFAULT_SETTINGS, JevRequest } from '../src/shared/types';

const dummyRequest: JevRequest = {
    model: 'jev-latest',
    state: {
      task: 'Test',
      page: {
        url: 'https://example.com',
        title: 'Example Domain',
        text: 'This domain is for use in illustrative examples.',
      },
      elements: [
        { index: '1', label: 'More info link', operations: ['CLICK'] },
      ],
      recent_actions: [],
    },
    questions: {
      operation: {
        type: 'choice',
        instructions: 'Choose next operation',
        criteria: {
          CLICK: 'Click more info',
          DONE: 'Done',
        },
      },
    },
};

describe('Jev Provider Adapters', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('callTypeSafe sends request to TypeSafe official endpoint with correct Bearer header', async () => {
    const mockResponse = {
      model: 'jev-1.13.0',
      answers: {
        operation: {
          choice: 'CLICK',
          confidence: 0.96,
          probabilities: { CLICK: 0.96, DONE: 0.04 },
        },
      },
      usage: { input_tokens: 110, output_tokens: 0 },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const config = {
      apiKey: 'test-typesafe-key',
      model: 'jev-latest',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
    };

    const res = await callTypeSafe(config, dummyRequest);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (global.fetch as any).mock.calls[0];

    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer test-typesafe-key');
    expect(options.headers['Content-Type']).toBe('application/json');

    const sentBody = JSON.parse(options.body);
    expect(sentBody.model).toBe('jev-latest');
    expect(sentBody.state.page.url).toBe('https://example.com');
    expect(sentBody.questions.operation.type).toBe('choice');

    expect(res.answers.operation.choice).toBe('CLICK');
  });

  it('callOpenRouter sends request to OpenRouter alpha decisions endpoint', async () => {
    const mockResponse = {
      model: 'typesafe/jev-1.13',
      answers: {
        operation: {
          choice: 'CLICK',
          confidence: 0.92,
          probabilities: { CLICK: 0.92, DONE: 0.08 },
        },
      },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const config = {
      apiKey: 'test-openrouter-key',
      model: 'typesafe/jev-1.13',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
    };

    const res = await callOpenRouter(config, dummyRequest);

    const [url, options] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(options.headers['Authorization']).toBe('Bearer test-openrouter-key');
    expect(options.headers['HTTP-Referer']).toBeDefined();

    expect(res.answers.operation.choice).toBe('CLICK');
  });

  it('callOpenRouter automatically normalizes typesafe/jev-latest to typesafe/jev-1.13', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ model: 'typesafe/jev-1.13', answers: {} }),
    });

    const config = {
      apiKey: 'test-openrouter-key',
      model: 'typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
    };

    await callOpenRouter(config, dummyRequest);

    const [, options] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.model).toBe('typesafe/jev-1.13');
  });

  it('callCloudflare wraps payload into input and handles result envelope', async () => {
    const mockResponse = {
      success: true,
      result: {
        model: 'typesafe/jev',
        answers: {
          operation: {
            choice: 'CLICK',
            confidence: 0.89,
            probabilities: { CLICK: 0.89, DONE: 0.11 },
          },
        },
      },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const config = {
      accountId: 'cf-acc-12345',
      apiToken: 'cf-token-abcde',
      model: 'typesafe/jev',
    };

    const res = await callCloudflare(config, dummyRequest);

    const [url, options] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/cf-acc-12345/ai/run');
    expect(options.headers['Authorization']).toBe('Bearer cf-token-abcde');

    const body = JSON.parse(options.body);
    expect(body.model).toBe('typesafe/jev');
    expect(body.input.state.page.url).toBe('https://example.com');
    expect(body.input.questions.operation).toBeDefined();

    expect(res.answers.operation.choice).toBe('CLICK');
  });

  it('callJevProvider routes to configured activeProvider', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ model: 'typesafe/jev-1.13', answers: {} }),
    });

    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'openrouter',
      openrouter: {
        apiKey: 'sk-or-key',
        model: 'typesafe/jev-1.13',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
      },
    };

    await callJevProvider(settings, dummyRequest);

    const [url] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
  });
});

describe('postJson retry policy', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries transient statuses with backoff and then succeeds', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'slow down' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ model: 'm', answers: {} }) });

    const pending = callTypeSafe(
      { apiKey: 'k', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/systemone' },
      dummyRequest
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    expect(res.model).toBe('m');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient errors and reports the status', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad request' });
    await expect(
      callOpenRouter({ apiKey: 'k', model: '', endpoint: '' }, dummyRequest)
    ).rejects.toThrow(/HTTP 400.*bad request/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a thrown fetch error with backoff and then succeeds', async () => {
    (global.fetch as any)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ model: 'm', answers: {} }) });

    const pending = callTypeSafe(
      { apiKey: 'k', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/systemone' },
      dummyRequest
    );
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;
    expect(res.model).toBe('m');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects after retries + 1 attempts when fetch always throws, keeping the original message', async () => {
    (global.fetch as any).mockRejectedValue(new TypeError('Failed to fetch'));

    const pending = callTypeSafe(
      { apiKey: 'k', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/systemone' },
      dummyRequest
    );
    const assertion = expect(pending).rejects.toThrow(/Failed to fetch/);
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});

describe('OpenRouter unknown-model error', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.restoreAllMocks());

  it('explains how to fix an obsolete model id', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false, status: 400,
      text: async () => '{"error":{"message":"Model typesafe/jev-latest does not exist","code":400}}',
    });
    await expect(
      callOpenRouter({ apiKey: 'k', model: 'typesafe/jev-latest', endpoint: '' }, dummyRequest)
    ).rejects.toThrow(/set it to "typesafe\/jev-1.13"/);
  });
});


describe('TypeSafe context limits', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.restoreAllMocks());
  const config = { apiKey: 'dummy', model: 'jev-latest', endpoint: 'https://example.com' };
  const denseRequest = () => buildJevRequest('jev-latest', {
    url: 'https://example.com/inbox', title: 'Inbox', text: 'message '.repeat(750),
    w: 1200, h: 900, omitted_actions: 0, scroll: { y: 0, height: 900 },
    actions: Array.from({ length: 250 }, (_, i) => ({
      id: `e${i}`, node: i, kind: 'click' as const,
      label: `Message ${i} ` + 'long email preview '.repeat(30),
      href: `/message/${i}`, checked: 'false',
    })),
  }, 'Start a draft email', []).request;
  const limitError = () => ({ ok: false, status: 400,
    text: async () => JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }),
  });

  it('removes repeated target metadata without changing ids, safety rules, or the source request', () => {
    const request = denseRequest();
    const original = structuredClone(request);
    const compact = compactTypeSafeRequest(request);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(request).length * 0.65);
    expect(compact.state).toEqual(request.state);
    expect(compact.questions.operation).toEqual(request.questions.operation);
    expect(compact.questions.goal_done).toEqual(request.questions.goal_done);
    expect(compact.questions.stuck).toEqual(request.questions.stuck);
    expect((compact.questions.click_target.criteria as Record<string, unknown>)['250']).toEqual({ element_index: '250' });
    expect(request).toEqual(original);
  });

  it('retries only the decision with progressively smaller context and preserves every target', async () => {
    const request = denseRequest();
    const original = structuredClone(request);
    const answer = { model: 'jev-latest', answers: { operation: { choice: 'CLICK' } } };
    vi.mocked(fetch).mockResolvedValueOnce(limitError() as Response)
      .mockResolvedValueOnce(limitError() as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => answer } as Response);
    expect(await callTypeSafe(config, request)).toEqual(answer);
    const bodies = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[1]).length).toBeLessThan(JSON.stringify(bodies[0]).length);
    expect(JSON.stringify(bodies[2]).length).toBeLessThan(JSON.stringify(bodies[1]).length);
    for (const body of bodies) {
      expect(body.state.task).toBe(request.state.task);
      expect(body.state.elements.map((e: any) => e.index)).toEqual(request.state.elements.map(e => e.index));
      expect(body.state.elements.every((e: any) => e.checked === 'false')).toBe(true);
      expect(Object.keys(body.questions.click_target.criteria)).toEqual(Object.keys(request.questions.click_target.criteria!));
    }
    expect(request).toEqual(original);
  });

  it('retains dropdown option ids and does not rewrite custom target schemas', () => {
    const request = denseRequest();
    request.questions.select_target = { type: 'choice', criteria: { '1:1': { value: 'a' }, '1:2': { value: 'b' } },
      instructions: structuredClone(request.questions.click_target.instructions) };
    request.questions.custom_target = { type: 'choice', criteria: { custom: 'My rule' }, instructions: 'Choose wisely' };
    const compact = compactTypeSafeRequest(request, 2);
    expect((compact.questions.select_target.criteria as Record<string, unknown>)['1:2']).toEqual({ element_index: '1', option_index: '1:2' });
    expect(compact.questions.custom_target).toEqual(request.questions.custom_target);
  });

  it('stops after three context-limit responses with an actionable error', async () => {
    vi.mocked(fetch).mockResolvedValue(limitError() as Response);
    await expect(callTypeSafe(config, denseRequest())).rejects.toThrow(/simpler page or choose another decision provider/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([401, 400])('does not compact-retry unrelated HTTP %s errors', async (status) => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status, text: async () => 'Invalid request' } as Response);
    await expect(callTypeSafe(config, denseRequest())).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
