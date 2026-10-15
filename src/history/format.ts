import type { RunTrace, TraceKind, TraceNode } from "../shared/trace";

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
export function elapsed(node: TraceNode, now = Date.now()): number {
  return node.durationMs ?? Math.max(0, now - node.startedAt);
}
export const pretty = (name: string) =>
  name
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/, (c) => c.toUpperCase());
export const STAGES = [
  { name: "Decisions", className: "stage-decision" },
  { name: "Text helper", className: "stage-helper" },
  { name: "Page & input", className: "stage-page" },
  { name: "Waiting", className: "stage-wait" },
] as const;
export function stageTimes(run: RunTrace, now = Date.now()): number[] {
  const byId = new Map(run.nodes.map((node) => [node.id, node]));
  const times = [0, 0, 0, 0];
  const group = (kind: TraceKind) =>
    kind === "decision" ? 0 : kind === "helper" ? 1 : kind === "wait" ? 3 : 2;
  for (const node of run.nodes) {
    if (node.kind === "cycle") continue;
    // Parent spans include their children. Subtract the union of child intervals, so staged
    // requests and backoff are shown once, not added on top of the decision's total.
    const end = node.startedAt + elapsed(node, now);
    const intervals = run.nodes
      .filter((child) => child.parentId === node.id)
      .map((child) => [
        Math.max(node.startedAt, child.startedAt),
        Math.min(end, child.startedAt + elapsed(child, now)),
      ])
      .filter(([start, end]) => end > start)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0,
      cursor = node.startedAt;
    for (const [start, end] of intervals) {
      covered += Math.max(0, end - Math.max(start, cursor));
      cursor = Math.max(cursor, end);
    }
    let owner = node;
    if (node.kind === "request" || node.kind === "check") {
      while (
        owner.parentId &&
        (owner.kind === "request" || owner.kind === "check")
      )
        owner = byId.get(owner.parentId) ?? { ...owner, parentId: undefined };
    }
    times[group(owner.kind)] += Math.max(0, elapsed(node, now) - covered);
  }
  return times;
}

export function questionLabel(value: any, key: string): string {
  if (typeof value === "string") return value;
  if (value?.element) return value.element;
  if (value?.title)
    return `${value.title}${value.url ? ` · ${value.url}` : ""}`;
  if (value?.url) return value.url;
  if (value?.element_index)
    return `Element ${value.element_index}${value.option_index ? ` · option ${value.option_index}` : ""}`;
  return pretty(key);
}
