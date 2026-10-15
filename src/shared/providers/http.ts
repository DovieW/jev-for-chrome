import type { TraceSpan } from '../trace';
const TRANSIENT_STATUSES = new Set([429, 503, 529]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ProviderHttpError extends Error {
  constructor(public status: number, public detail: string, label: string) {
    super(`${label} error (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'ProviderHttpError';
  }
}

/**
 * POSTs JSON and returns the parsed body. Transient statuses are retried with backoff.
 * Model requests are idempotent; browser mutations are never retried through here.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: { retries?: number; label?: string; traceLabel?: string; trace?: TraceSpan } = {}
): Promise<any> {
  const retries = options.retries ?? 3;
  const label = options.label || 'Model provider';

  for (let attempt = 0; ; attempt++) {
    const request = options.trace?.child('request', `${options.traceLabel || label} · attempt ${attempt + 1}`, body);
    const backoff = async () => {
      const wait = options.trace?.child('wait', 'Retry backoff', { delayMs: 800 * 2 ** attempt });
      await sleep(800 * 2 ** attempt);
      wait?.end();
    };
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      request?.fail(err);
      // fetch itself throwing (DNS failure, connection reset, "Failed to fetch" from a
      // service worker) is retried the same as a transient status: model requests are
      // idempotent, and the body sent above is a fresh JSON string per attempt, not a
      // stream a prior attempt could have consumed, so resending it is safe.
      if (attempt < retries) {
        await backoff();
        continue;
      }
      throw new Error(`${label} connection failed (${err?.message || String(err)}); no action executed.`);
    }

    if (TRANSIENT_STATUSES.has(response.status) && attempt < retries) {
      request?.end({ httpStatus: response.status, retrying: true }, 'error');
      await backoff();
      continue;
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        // ignore unreadable body
      }
      const error = new ProviderHttpError(response.status, detail, label);
      request?.fail(error);
      throw error;
    }

    try {
      const json = await response.json();
      // Keep returned answers and text, never a provider's private reasoning field.
      const output = json?.choices ? { model: json.model, usage: json.usage, choices: json.choices.map((choice: any) => ({ message: { content: choice.message?.content }, finish_reason: choice.finish_reason })) } : json;
      request?.end({ httpStatus: response.status, response: output });
      return json;
    } catch (error) {
      request?.fail(error);
      throw error;
    }
  }
}
