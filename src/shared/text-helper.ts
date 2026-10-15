import type { TraceSpan } from './trace';
import { parseFieldText } from 'jev-dev-kit';
import { STARTING_URL_PROMPT, TEXT_VALUE_PROMPT } from './prompts';

export { parseFieldText };
import { OPENROUTER_HEADERS } from './providers/openrouter';
import { postJson } from './providers/http';
import { AppSettings, PageAction, RecentAction, TEXT_HELPER_PRESETS } from './types';

export interface FieldContext {
  goal: string;
  field: {
    label?: string;
    role?: string;
    value?: string;
  };
  page: {
    title: string;
    text: string;
  };
  recent_actions: Array<Pick<RecentAction, 'action' | 'text'>>;
}

export function createFieldContext(
  goal: string,
  action: PageAction,
  page: { title: string; text: string },
  history: RecentAction[]
): FieldContext {
  return {
    goal,
    field: {
      label: action.label,
      role: action.role,
      value: action.value,
    },
    page: {
      title: page.title,
      text: page.text.slice(0, 6000),
    },
    recent_actions: history.slice(-6).map((h) => ({ action: h.action, text: h.text })),
  };
}


export interface HelperKeyStatus {
  provider: string;
  baseUrl: string;
  model: string;
  /** Where the key comes from, or null when none is available. */
  source: 'helper' | 'openrouter' | 'openai' | null;
  message: string;
}

/** Custom compatible endpoints never receive OpenAI-specific credentials or parameters. */
export function isOfficialOpenAI(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === 'https://api.openai.com' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Explains which key the text helper will use for the current settings, before any request is made. */
export function describeHelperKey(settings: AppSettings): HelperKeyStatus {
  const cfg = settings.textHelper;
  const preset = TEXT_HELPER_PRESETS[cfg.provider] || TEXT_HELPER_PRESETS.openrouter;
  const baseUrl = ((cfg.baseUrl || '').trim() || preset.baseUrl).replace(/\/+$/, '');
  const model = (cfg.model || '').trim() || preset.model;
  const own = (cfg.apiKey || '').trim();
  const openrouterKey = (settings.openrouter.apiKey || '').trim();
  const viaOpenRouter = baseUrl.includes('openrouter.ai');
  const openaiKey = (settings.openai.apiKey || '').trim();
  if (own) return { provider: cfg.provider, baseUrl, model, source: 'helper', message: `Text helper uses its own key for ${model} at ${baseUrl}.` };
  if (viaOpenRouter && openrouterKey) return { provider: cfg.provider, baseUrl, model, source: 'openrouter', message: `Text helper reuses the OpenRouter key for ${model}.` };
  if (isOfficialOpenAI(baseUrl) && openaiKey) return { provider: cfg.provider, baseUrl, model, source: 'openai', message: `Text helper reuses the OpenAI Decisions key for ${model}.` };
  const hint = viaOpenRouter
    ? 'Enter an OpenRouter key in the Jev provider section or in the Text helper section.'
    : `The text helper is set to "${cfg.provider}" (${baseUrl}). Enter a helper key${isOfficialOpenAI(baseUrl) ? ' or an OpenAI Decisions key' : ' for this endpoint'}.`;
  return { provider: cfg.provider, baseUrl, model, source: null, message: `No API key for the text helper. ${hint}` };
}

/**
 * Asks the small text model for exactly one field value. Any malformed or empty answer
 * is rejected so nothing is ever typed that the model did not explicitly return.
 */
export async function generateFieldText(
  settings: AppSettings,
  context: FieldContext,
  trace?: TraceSpan
): Promise<string> {
  return parseFieldText(await requestHelper(settings, TEXT_VALUE_PROMPT, context, trace));
}

/** A bootstrap request has no page to observe and returns a URL, never executable code. */
export async function generateStartingUrl(settings: AppSettings, goal: string, trace?: TraceSpan): Promise<string> {
  const raw = await requestHelper(settings, STARTING_URL_PROMPT, { goal }, trace);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Starting URL helper returned invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('url' in value) || typeof value.url !== 'string') {
    throw new Error('Starting URL helper must return exactly one URL; no navigation performed.');
  }
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error('Starting URL helper returned an invalid absolute URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Starting URL must use HTTP(S) without embedded credentials.');
  }
  return url.href;
}

async function requestHelper(settings: AppSettings, prompt: string, context: unknown, trace?: TraceSpan): Promise<string> {
  const cfg = settings.textHelper;
  const status = describeHelperKey(settings);
  const { baseUrl, model } = status;

  // Share the OpenRouter key only when the helper actually talks to OpenRouter.
  const apiKey =
    status.source === 'helper'
      ? (cfg.apiKey || '').trim()
      : status.source === 'openrouter'
      ? (settings.openrouter.apiKey || '').trim()
      : status.source === 'openai'
      ? (settings.openai.apiKey || '').trim()
      : '';
  if (!apiKey) {
    throw new Error(`Text helper cannot run: ${status.message} No text is guessed by the executor.`);
  }

  const isOpenRouter = baseUrl.includes('openrouter.ai');
  const isDeepSeek = baseUrl.includes('api.deepseek.com');
  const isOpenAI = isOfficialOpenAI(baseUrl);

  const payload: Record<string, any> = {
    model,
    ...(isOpenAI ? { max_completion_tokens: 1024, service_tier: cfg.serviceTier || 'default' } : { max_tokens: 1024 }),
    ...(isOpenAI && /^gpt-6-luna(?:-|$)/.test(model) ? { reasoning_effort: 'none' } : {}),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify(context) },
    ],
    ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
  };

  const json = await postJson(
    `${baseUrl}/chat/completions`,
    { Authorization: `Bearer ${apiKey}`, ...(isOpenRouter ? OPENROUTER_HEADERS : {}) },
    payload,
    { label: 'Text helper', trace }
  );

  const rawContent = json?.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    throw new Error('Text helper returned an empty message; no action performed.');
  }

  return rawContent;
}
