import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFieldContext, generateFieldText, generateStartingUrl, describeHelperKey, parseFieldText, NoFieldValueError } from '../src/shared/text-helper';
import { AppSettings, DEFAULT_SETTINGS, mergeSettings, PageAction, TEXT_HELPER_PRESETS } from '../src/shared/types';

const okResponse = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

describe('Text Helper (TYPE_TEXT value generator)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createFieldContext limits page text and keeps only action/text from history', () => {
    const action: PageAction = { id: 'e1', kind: 'fill', label: 'Where from?', role: 'textbox', value: '' };
    const ctx = createFieldContext(
      'Find flights from Zurich to London',
      action,
      { title: 'Google Flights', text: 'x'.repeat(7000) },
      [{ action: 'CLICK departure', kind: 'click', page_changed: true }]
    );

    expect(ctx.goal).toBe('Find flights from Zurich to London');
    expect(ctx.field).toEqual({ label: 'Where from?', role: 'textbox', value: '' });
    expect(ctx.page.text.length).toBe(6000);
    expect(ctx.recent_actions).toEqual([{ action: 'CLICK departure', text: undefined }]);
  });

  it('sends a JSON-mode chat request and returns the text value (DeepSeek direct)', async () => {
    (global.fetch as any).mockResolvedValueOnce(okResponse(JSON.stringify({ text: 'Zurich' })));

    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      textHelper: {
        provider: 'deepseek',
        apiKey: 'test-text-key',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
      },
    };

    const text = await generateFieldText(settings, {
      goal: 'Find flights from Zurich to London',
      field: { label: 'Where from?' },
      page: { title: 'Flights', text: 'Search' },
      recent_actions: [],
    });
    expect(text).toBe('Zurich');

    const [url, options] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(options.headers['Authorization']).toBe('Bearer test-text-key');
    const body = JSON.parse(options.body);
    expect(body.model).toBe('deepseek-chat'); // never rewritten
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('falls back to provider presets and the OpenRouter key when the helper config is empty', async () => {
    (global.fetch as any).mockResolvedValueOnce(okResponse('{"text": "London"}'));

    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'openrouter',
      openrouter: { apiKey: 'sk-or-shared-key', model: 'typesafe/jev-1.13', endpoint: '' },
      textHelper: { provider: 'openrouter', apiKey: '', baseUrl: '', model: '' },
    };

    const text = await generateFieldText(settings, {
      goal: 'Fly to London',
      field: { label: 'Where to?' },
      page: { title: 'Flights', text: 'Search' },
      recent_actions: [],
    });
    expect(text).toBe('London');

    const [url, options] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(options.headers['Authorization']).toBe('Bearer sk-or-shared-key');
    expect(JSON.parse(options.body).model).toBe('deepseek/deepseek-chat');
  });

  it('does not share the OpenRouter key with a non-OpenRouter helper', async () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      openrouter: { ...DEFAULT_SETTINGS.openrouter, apiKey: 'sk-or-shared-key' },
      textHelper: { provider: 'openai', apiKey: '', baseUrl: '', model: '' },
    };
    await expect(
      generateFieldText(settings, { goal: 'g', field: {}, page: { title: '', text: '' }, recent_actions: [] })
    ).rejects.toThrow(/API key/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses to type when the model reports a missing value', async () => {
    (global.fetch as any).mockResolvedValueOnce(okResponse('{"text": null}'));
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      textHelper: { provider: 'deepseek', apiKey: 'k', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    };
    await expect(
      generateFieldText(settings, { goal: 'g', field: {}, page: { title: '', text: '' }, recent_actions: [] })
    ).rejects.toBeInstanceOf(NoFieldValueError);
  });

  it('surfaces provider errors instead of silently switching models', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'bad key' });
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      textHelper: { provider: 'openrouter', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-x' },
    };
    await expect(
      generateFieldText(settings, { goal: 'g', field: {}, page: { title: '', text: '' }, recent_actions: [] })
    ).rejects.toThrow(/HTTP 401/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  describe('parseFieldText', () => {
    it.each(['{"text":null}', '```json\n{"text": null}\n```'])('classifies a null reply as recoverable: %s', raw => {
      expect(() => parseFieldText(raw)).toThrow(NoFieldValueError);
    });

    it.each(['not JSON', '{}', '{"text":""}', '{"text":42}'])('does not classify a malformed reply as a missing field value: %s', raw => {
      expect(() => parseFieldText(raw)).toThrow();
      expect(() => parseFieldText(raw)).not.toThrow(NoFieldValueError);
    });
    it('accepts a fenced JSON object', () => {
      expect(parseFieldText('```json\n{"text": "Zurich"}\n```')).toBe('Zurich');
    });

    it('rejects plain text, extra keys, empty strings, and oversized values', () => {
      expect(() => parseFieldText('Zurich')).toThrow(/JSON/);
      expect(() => parseFieldText('{"value": "Zurich"}')).toThrow(/"text"/);
      expect(() => parseFieldText('{"text": "   "}')).toThrow(/invalid/);
      expect(() => parseFieldText(`{"text": "${'a'.repeat(2001)}"}`)).toThrow(/invalid/);
      expect(() => parseFieldText('{"text": 42}')).toThrow(/invalid/);
    });
  });
});

describe('describeHelperKey', () => {
  it('explains where the key comes from, or exactly what is missing', async () => {
    const { describeHelperKey } = await import('../src/shared/text-helper');
    const base = { ...DEFAULT_SETTINGS, openrouter: { ...DEFAULT_SETTINGS.openrouter, apiKey: 'sk-or' } };
    expect(describeHelperKey(base).source).toBe('openrouter');
    expect(describeHelperKey({ ...base, textHelper: { ...base.textHelper, apiKey: 'own' } }).source).toBe('helper');
    const deepseek = describeHelperKey({ ...base, textHelper: { provider: 'deepseek', apiKey: '', baseUrl: '', model: '' } });
    expect(deepseek.source).toBeNull();
    expect(deepseek.message).toMatch(/set to "deepseek".*api\.deepseek\.com.*Enter a helper key/);
    const noKeys = describeHelperKey(DEFAULT_SETTINGS);
    expect(noKeys.source).toBeNull();
    expect(noKeys.message).toMatch(/Enter an OpenRouter key/);
  });

  it('puts the same explanation into the TYPE_TEXT error', async () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, textHelper: { provider: 'openai', apiKey: '', baseUrl: '', model: '' } };
    await expect(
      generateFieldText(settings, { goal: 'g', field: {}, page: { title: '', text: '' }, recent_actions: [] })
    ).rejects.toThrow(/set to "openai".*api\.openai\.com.*OpenAI Decisions key/);
  });
});

describe('OpenAI text helper and starting URL', () => {
  const context = { goal: 'Search for flights', field: {}, page: { title: '', text: '' }, recent_actions: [] };
  const settings = (tier: 'default' | 'priority' = 'default'): AppSettings => ({
    ...DEFAULT_SETTINGS,
    openai: { ...DEFAULT_SETTINGS.openai, apiKey: 'test-openai' },
    textHelper: { provider: 'openai', apiKey: '', baseUrl: '', model: '', serviceTier: tier },
  });
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it.each(['default', 'priority'] as const)('uses Luna and the %s tier without max_tokens', async (tier) => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse('{"text":"Miami"}') as Response);
    expect(await generateFieldText(settings(tier), context)).toBe('Miami');
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-openai' });
    const body = JSON.parse(options!.body as string);
    expect(body).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 1024, reasoning_effort: 'none', service_tier: tier });
    expect(body).not.toHaveProperty('max_tokens');
    expect(describeHelperKey(settings(tier)).source).toBe('openai');
  });

  it('prefers the helper key and never shares the OpenAI key with a custom host', async () => {
    const own = settings();
    own.textHelper.apiKey = 'own-key';
    expect(describeHelperKey(own).source).toBe('helper');
    for (const baseUrl of ['https://api.openai.com.evil.test/v1', 'http://api.openai.com/v1', 'https://gateway.test/v1', 'https://api.openai.com:8443/v1']) {
      const custom = settings();
      custom.textHelper.baseUrl = baseUrl;
      expect(describeHelperKey(custom).source).toBeNull();
      await expect(generateFieldText(custom, context)).rejects.toThrow(/key/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps legacy request parameters for a compatible endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse('{"text":"Miami"}') as Response);
    const custom = settings('priority');
    custom.textHelper.baseUrl = 'https://gateway.test/v1';
    custom.textHelper.apiKey = 'custom-key';
    await generateFieldText(custom, context);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.max_tokens).toBe(1024);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('service_tier');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('migrates older settings without replacing saved models or provider choices', () => {
    expect(TEXT_HELPER_PRESETS.openai.model).toBe('gpt-6-luna');
    const old = mergeSettings({ activeProvider: 'typesafe', textHelper: { provider: 'openai', apiKey: '', baseUrl: '', model: 'gpt-4o-mini' } });
    expect(old.activeProvider).toBe('typesafe');
    expect(old.textHelper.model).toBe('gpt-4o-mini');
    expect(old.textHelper.serviceTier).toBe('default');
    expect(old.openai).toEqual(DEFAULT_SETTINGS.openai);
    expect(mergeSettings({ textHelper: { provider: 'openai', apiKey: '', baseUrl: '', model: '' } }).textHelper.model).toBe('gpt-6-luna');
  });

  it('chooses an absolute starting URL using the same text configuration', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse('{"url":"https://www.google.com"}') as Response);
    expect(await generateStartingUrl(settings('priority'), 'Find a flight')).toBe('https://www.google.com/');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.service_tier).toBe('priority');
    expect(JSON.parse(body.messages[1].content)).toEqual({ goal: 'Find a flight' });
  });

  it.each(['not JSON', '{"url":null}', '{"url":"/relative"}', '{"url":"javascript:alert(1)"}', '{"url":"chrome://settings"}', '{"url":"https://user:pass@example.com"}', '{"url":"https://example.com","extra":true}', '["https://example.com"]'])('refuses unsafe or malformed URL output: %s', async (raw) => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(raw) as Response);
    await expect(generateStartingUrl(settings(), 'Find a flight')).rejects.toThrow();
  });
});
