import type { RunTrace, TraceNode } from "../shared/trace";
import { pretty, questionLabel } from "./format";

export const object = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
export function decode(value: unknown): any {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
export interface SentQuestion {
  name: string;
  type: string;
  instructions: unknown;
  choices: Array<{ id: string; description: unknown }>;
}
export interface ReturnedAnswer {
  name: string;
  type?: string;
  choice?: string;
  confidence?: number;
  probability?: number;
  probabilities: Record<string, number>;
  raw: unknown;
}
export interface Exchange {
  node: TraceNode;
  parent?: TraceNode;
  title: string;
  model?: string;
  state?: Record<string, any>;
  questions: SentQuestion[];
  answers: ReturnedAnswer[];
  messages: Array<{ role: string; content: unknown }>;
  replies: Array<{ raw: string; value: any; finishReason?: string }>;
  parameters: Record<string, any>;
  httpStatus?: number;
  usage?: { input?: number; output?: number; cached?: number };
  inputMissing: boolean;
  responseMissing: boolean;
}

/** Normalize only the recorded wire request/response; never substitute prepared agent state. */
export function readExchange(node: TraceNode, run: RunTrace): Exchange {
  const body = object(node.input);
  const nestedInput = object(decode(body?.input));
  const response =
    object(node.output?.response?.result) ?? object(node.output?.response);
  const questionSource = body?.questions ?? nestedInput?.questions;
  const questions: SentQuestion[] = (
    Array.isArray(questionSource)
      ? questionSource.map((q) => [q?.name, q])
      : Object.entries(object(questionSource) ?? {})
  )
    .filter(([name, q]) => typeof name === "string" && object(q))
    .map(([name, q]) => ({
      name,
      type: q.type,
      instructions: decode(q.instructions),
      choices: Array.isArray(q.choices)
        ? q.choices.map((choice: any) => ({
            id: String(choice.value),
            description: decode(choice.description),
          }))
        : Object.entries(object(q.criteria) ?? {}).map(([id, description]) => ({
            id,
            description,
          })),
    }));
  const answerSource =
    response?.answers ??
    (response
      ? Object.fromEntries(
          questions
            .filter((q) => object(response[q.name]))
            .map((q) => [q.name, response[q.name]]),
        )
      : undefined);
  const answers: ReturnedAnswer[] = (
    Array.isArray(answerSource)
      ? answerSource.map((a) => [a?.name, a])
      : Object.entries(object(answerSource) ?? {})
  )
    .filter(([name, a]) => typeof name === "string" && object(a))
    .map(([name, a]) => ({
      name,
      type: a.type,
      choice: a.choice,
      confidence: a.confidence,
      probability: a.probability ?? a.noul,
      probabilities: Array.isArray(a.probabilities)
        ? Object.fromEntries(
            a.probabilities
              .filter((p: any) => typeof p?.value === "string")
              .map((p: any) => [p.value, p.probability]),
          )
        : (object(a.probabilities) ?? {}),
      raw: a,
    }));
  const messages = Array.isArray(body?.messages)
    ? body.messages.map((m: any) => ({
        role: String(m.role),
        content: m.content,
      }))
    : [];
  const replies = Array.isArray(response?.choices)
    ? response.choices
        .filter((c: any) => typeof c?.message?.content === "string")
        .map((c: any) => ({
          raw: c.message.content,
          value: decode(c.message.content),
          finishReason: c.finish_reason,
        }))
    : [];
  const parent = run.nodes.find((n) => n.id === node.parentId);
  const state =
    object(body?.state) ??
    object(nestedInput?.state) ??
    (nestedInput?.page || nestedInput?.task ? nestedInput : undefined);
  const usage = response?.usage;
  const parameters = Object.fromEntries(
    Object.entries(body ?? {}).filter(
      ([key]) => !["state", "input", "questions", "messages"].includes(key),
    ),
  );
  const title = messages.length
    ? (parent?.label ?? "Generate text")
    : questions.some((q) => q.name === "operation")
      ? "Choose next action"
      : questions.some((q) => q.name === "candidate_group")
        ? "Choose a target group"
        : questions.length === 1
          ? pretty(questions[0].name)
          : "Answer decision questions";
  return {
    node,
    parent,
    title,
    model: body?.model || object(node.output?.response)?.model,
    state,
    questions,
    answers,
    messages,
    replies,
    parameters,
    httpStatus: node.output?.httpStatus,
    usage: usage
      ? {
          input: usage.input_tokens ?? usage.prompt_tokens,
          output: usage.output_tokens ?? usage.completion_tokens,
          cached:
            usage.input_tokens_details?.cached_tokens ??
            usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined,
    inputMissing: !body || typeof body.omitted === "string",
    responseMissing:
      node.output?.response === undefined ||
      typeof node.output?.omitted === "string",
  };
}

export function localTarget(run: RunTrace, decision?: TraceNode) {
  const operation = decision?.output?.answers?.operation?.choice;
  if (typeof operation !== "string") return undefined;
  const name = `${operation.toLowerCase()}_target`;
  const event = run.nodes.find(
    (n) =>
      n.parentId === decision?.id &&
      n.kind === "check" &&
      n.label === `Only one candidate: ${name}`,
  );
  if (!event) return undefined;
  const id = String(event.output?.choice ?? "");
  const elements = decision?.input?.state?.elements;
  const element = Array.isArray(elements)
    ? elements.find((e: any) => e.index === id)
    : undefined;
  const criteria = decision?.input?.questions?.[name]?.criteria?.[id];
  return {
    name,
    id,
    label: element?.label ?? questionLabel(criteria, id),
    operation,
  };
}

/** Concise, deterministic explanation of the final cycle, grounded in actual recorded answers. */
export function explainRun(run: RunTrace): string[] {
  const cycle = run.nodes.filter((n) => n.kind === "cycle").at(-1);
  if (!cycle) return [];
  const ids = new Set([cycle.id]);
  for (const node of run.nodes)
    if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  const events = run.nodes.filter((n) => ids.has(n.id));
  const exchanges = events
    .filter((n) => n.kind === "request")
    .map((n) => readExchange(n, run));
  const chosen = exchanges
    .flatMap((exchange) => exchange.answers)
    .find((a) => a.name === "operation" && typeof a.choice === "string");
  const explanation: string[] = [];
  if (chosen)
    explanation.push(
      `The decision model chose ${pretty(chosen.choice!)}${typeof chosen.confidence === "number" ? ` with ${Math.round(chosen.confidence * 100)}% confidence` : ""}.`,
    );
  const decision = events.find((n) => n.kind === "decision");
  const local = localTarget(run, decision);
  if (local)
    explanation.push(
      `The extension selected “${local.label}” (#${local.id}) locally: it was the only target offered for ${pretty(local.operation)}. The model was not asked to choose that target.`,
    );
  const helper = exchanges.find((exchange) =>
    exchange.replies.some(
      (reply) => object(reply.value) && reply.value.text === null,
    ),
  );
  if (helper)
    explanation.push(
      'The text helper returned {"text":null}, providing no field value.',
    );
  if (
    run.steps === 0 &&
    !run.nodes.some((n) => n.kind === "action") &&
    ["error", "blocked", "stopped", "interrupted"].includes(run.status)
  )
    explanation.push("The run stopped before any browser action was recorded.");
  return explanation;
}

/** Opening an export is read-only and in-memory. Reject malformed event graphs before rendering. */
export function parseRunExport(text: string): RunTrace {
  const run = JSON.parse(text);
  const kinds = new Set([
    "cycle",
    "observe",
    "decision",
    "helper",
    "action",
    "wait",
    "check",
    "request",
  ]);
  const statuses = new Set(["running", "ok", "error", "skipped", "cancelled"]);
  if (
    run?.version !== 1 ||
    typeof run.id !== "string" ||
    typeof run.goal !== "string" ||
    typeof run.provider !== "string" ||
    typeof run.model !== "string" ||
    typeof run.helperModel !== "string" ||
    !Number.isFinite(run.startedAt) ||
    !Number.isFinite(run.updatedAt) ||
    !Number.isFinite(run.steps) ||
    !Number.isFinite(run.maxSteps) ||
    !Array.isArray(run.nodes) ||
    run.nodes.length > 2400 ||
    ![
      "running",
      "paused",
      "done",
      "blocked",
      "error",
      "stopped",
      "interrupted",
    ].includes(run.status)
  )
    throw new Error("This file is not a supported Jev run export.");
  const ids = new Set<string>();
  for (const node of run.nodes) {
    if (
      !node ||
      typeof node.id !== "string" ||
      ids.has(node.id) ||
      !kinds.has(node.kind) ||
      !statuses.has(node.status) ||
      typeof node.label !== "string" ||
      !Number.isFinite(node.startedAt) ||
      (node.durationMs !== undefined &&
        (!Number.isFinite(node.durationMs) || node.durationMs < 0)) ||
      (node.parentId !== undefined && !ids.has(node.parentId)) ||
      (node.error !== undefined && typeof node.error !== "string")
    )
      throw new Error(
        "The run export has invalid or incomplete event records.",
      );
    ids.add(node.id);
  }
  if (
    (run.endedAt !== undefined && !Number.isFinite(run.endedAt)) ||
    (run.error !== undefined && typeof run.error !== "string")
  )
    throw new Error("The run export has invalid metadata.");
  return run;
}
