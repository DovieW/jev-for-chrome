/** Serializable diagnostics, separate from provider credentials and agent control. */
export type TraceKind =
  | "cycle"
  | "observe"
  | "decision"
  | "helper"
  | "action"
  | "wait"
  | "check"
  | "request";
export type TraceStatus = "running" | "ok" | "error" | "skipped" | "cancelled";
export interface TraceNode {
  id: string;
  parentId?: string;
  kind: TraceKind;
  label: string;
  startedAt: number;
  durationMs?: number;
  status: TraceStatus;
  input?: any;
  output?: any;
  error?: string;
}
export interface RunTrace {
  version: 1;
  id: string;
  goal: string;
  provider: string;
  model: string;
  helperModel: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  status:
    | "running"
    | "paused"
    | "done"
    | "blocked"
    | "error"
    | "stopped"
    | "interrupted";
  steps: number;
  maxSteps: number;
  error?: string;
  nodes: TraceNode[];
  truncated?: boolean;
}
/** Optional instrumentation travels with a request, never through a global active span. */
export interface TraceSpan {
  child(kind: TraceKind, label: string, input?: unknown): TraceSpan;
  end(output?: unknown, status?: TraceStatus): void;
  fail(error: unknown, output?: unknown): void;
  event(label: string, output?: unknown, status?: TraceStatus): void;
  measure<T>(
    kind: TraceKind,
    label: string,
    input: unknown,
    work: (span: TraceSpan) => Promise<T>,
  ): Promise<T>;
}
