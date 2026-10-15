import type { TraceSpan } from '../trace';
import { JevRequest, JevResponse, TypeSafeConfig } from '../types';
import { NEXT_ACTION_RULES, TARGET_RULES } from '../prompts';
import { postJson, ProviderHttpError } from './http';

/** Keep the complete target table; criteria refer to it instead of repeating its content. */
export function compactTypeSafeRequest(request: JevRequest, level = 0): JevRequest {
  const compact = structuredClone(request);
  for (const [name, question] of Object.entries(compact.questions)) {
    if (question.type !== 'choice' || !name.endsWith('_target')) continue;
    const instructions = question.instructions;
    // Only rewrite our own target schema, never a caller's arbitrary question.
    if (!instructions || typeof instructions !== 'object' ||
        !('rules' in instructions) || !Array.isArray(instructions.rules) ||
        !instructions.rules.includes(NEXT_ACTION_RULES) ||
        !instructions.rules.includes(TARGET_RULES)) continue;
    question.criteria = Object.fromEntries(Object.keys(question.criteria).map((id) =>
      [id, { element_index: id.split(':')[0], ...(id.includes(':') ? { option_index: id } : {}) }]
    ));
    question.instructions = {
      ...instructions,
      rules: TARGET_RULES,
      target_lookup: 'Look up element_index in state.elements; option_index identifies its dropdown option.',
    };
  }
  if (level === 0) return compact;

  const limit = level === 1 ? 240 : 80;
  const clip = (value: string) => value.length <= limit ? value :
    `${value.slice(0, Math.floor(limit * 0.7))} … ${value.slice(-Math.floor(limit * 0.3))}`;
  const pageLimit = level === 1 ? 2000 : 600;
  const text = compact.state.page.text;
  compact.state.page.text = text.length <= pageLimit ? text :
    `${text.slice(0, pageLimit)}\n[Page text shortened; use the observed controls below.]`;
  compact.state.elements = compact.state.elements.map((element) => ({
    ...element,
    label: clip(element.label),
    ...(element.value ? { value: clip(element.value) } : {}),
    ...(element.href ? { href: clip(element.href) } : {}),
    ...(element.section ? { section: clip(element.section) } : {}),
    ...(element.options ? { options: element.options.map((option) => ({
      ...option, label: clip(option.label), value: clip(option.value),
    })) } : {}),
  }));
  // Retain all recent outcomes and run progress, but shorten copied page/field content.
  compact.state.recent_actions = compact.state.recent_actions.map((action) => ({
    ...action,
    ...(action.action ? { action: clip(action.action) } : {}),
    ...(action.text ? { text: clip(action.text) } : {}),
    ...(action.outcome ? { outcome: clip(action.outcome) } : {}),
  }));
  compact.state.observation_notice = 'Long labels and values are abbreviated with …; missing text is not evidence that the goal is complete.';
  return compact;
}

function isContextLimit(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError) || error.status !== 400) return false;
  try {
    return JSON.parse(error.detail)?.detail?.error_type === 'max_tokens_exceeded';
  } catch {
    return false;
  }
}

export async function callTypeSafe(
  config: TypeSafeConfig,
  request: JevRequest,
  trace?: TraceSpan
): Promise<JevResponse> {
  const apiKey = (config.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('TypeSafe API Key is not configured. Please set it in Options.');
  }

  const endpoint = config.endpoint || 'https://api.typesafe.ai/v1/systemone';
  const model = (config.model || '').trim() || 'jev-latest';

  for (let level = 0; level < 3; level++) {
    const compact = compactTypeSafeRequest(request, level);
    try {
      return await postJson(
        endpoint,
        { Authorization: `Bearer ${apiKey}` },
        { model, state: compact.state, questions: compact.questions },
        { label: 'TypeSafe API', traceLabel: `TypeSafe · input compression ${level}`, trace }
      ) as JevResponse;
    } catch (error) {
      if (!isContextLimit(error)) throw error;
      trace?.event('Context limit reached', { compactionLevel: level, retrying: level < 2 }, 'skipped');
      if (level === 2) {
        throw new Error('This page exceeds TypeSafe’s context limit even after shortening it. Try a simpler page or choose another decision provider in Settings. No action was executed for this decision.');
      }
    }
  }
  throw new Error('TypeSafe decision could not be completed.');
}
