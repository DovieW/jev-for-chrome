import type {
  RunTrace,
  TraceKind,
  TraceNode,
  TraceSpan,
} from "../shared/trace";

export const HISTORY_KEY = "jev_run_history_v1";
export const MAX_RUNS = 5;
// Five runs stay comfortably below chrome.storage.local's quota, including UTF-8 text.
export const MAX_RUN_BYTES = 1_200_000;
const MAX_NODES = 2400;
const size = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const noopSpan: TraceSpan = {
  child: () => noopSpan,
  end() {},
  fail() {},
  event() {},
  measure: (_kind, _label, _input, work) => work(noopSpan),
};

/** Keys are removed even if a provider echoes them in an error or a page contains them. */
export function sanitizeTrace(value: unknown, secrets: string[] = []): any {
  if (value === undefined) return undefined;
  const clean = (text: string) => {
    for (const secret of secrets
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      text = text.replaceAll(secret, "[redacted]");
    return text
      .replace(/\bBearer\s+[^\s"\\]+/gi, "Bearer [redacted]")
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, "[redacted]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replace(
        /([?&](?:api[_-]?key|token|access_token|password|secret|auth|code)=)[^&#\s"\\]*/gi,
        "$1[redacted]",
      );
  };
  return JSON.parse(
    JSON.stringify(value, (key, entry) => {
      if (
        /^(?:authorization|api[_-]?key|apiToken|password|secret|access_token|reasoning_content|reasoning)$/i.test(
          key,
        )
      )
        return "[redacted]";
      return typeof entry === "string" ? clean(entry) : entry;
    }),
  );
}

export function boundRun(run: RunTrace): RunTrace {
  const copy: RunTrace = structuredClone(run);
  const clip = (text: string | undefined, limit: number) => {
    if (!text || text.length <= limit) return text;
    copy.truncated = true;
    return text.slice(0, limit) + "… [detail shortened]";
  };
  copy.goal = clip(copy.goal, 12000)!;
  copy.error = clip(copy.error, 4000);
  copy.model = clip(copy.model, 300)!;
  copy.helperModel = clip(copy.helperModel, 300)!;
  for (const node of copy.nodes) node.error = clip(node.error, 2000);
  if (size(copy) <= MAX_RUN_BYTES) return copy;
  copy.truncated = true;
  // Shed duplicate observation/prepared-state payloads before the actual API exchanges.
  // Retain request/response bodies as long as possible: these are the source of truth.
  const payloads = copy.nodes
    .flatMap((node) =>
      (["input", "output"] as const)
        .filter((key) => node[key] !== undefined)
        .map((key) => ({ node, key, bytes: size(node[key]) })),
    )
    // Preserve small outcomes/errors as well as wire responses.
    .sort((a, b) =>
      Number(a.node.kind === "request" || a.bytes <= 4096) -
        Number(b.node.kind === "request" || b.bytes <= 4096) || b.bytes - a.bytes,
    );
  let bytes = size(copy);
  for (const { node, key, bytes: removed } of payloads) {
    if (bytes <= MAX_RUN_BYTES) break;
    const model = node[key]?.model;
    node[key] = {
      ...(typeof model === "string" ? { model } : {}),
      omitted: "Detail omitted to keep local history within its size limit.",
      originalBytes: removed,
    };
    bytes -= removed - size(node[key]);
  }
  // Very long runs can exceed the budget through labels/errors alone. Retain event order,
  // status and timing even then, and make the detail loss explicit.
  if (size(copy) > MAX_RUN_BYTES) {
    for (const node of copy.nodes) {
      delete node.input;
      delete node.output;
      node.label = clip(node.label, 48)!;
      if (node.error)
        node.error = "Error details omitted to fit the history limit.";
    }
  }
  return copy;
}

type Storage = Pick<typeof chrome.storage.local, "get" | "set">;

/** One serialized writer prevents a slow older snapshot from overwriting a newer run. */
export class RunHistoryStore {
  private runs: RunTrace[] = [];
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private deleted = new Set<string>();
  public error?: string;
  constructor(
    private storage?: Storage,
    private notify = () => {
      try {
        void chrome.runtime
          .sendMessage({ type: "RUN_HISTORY_UPDATED" })
          .catch(() => undefined);
      } catch {
        /* no receiver */
      }
    },
  ) {}

  private initialize(): Promise<void> {
    return (this.ready ??= (async () => {
      const storage = this.storage ?? chrome.storage?.local;
      if (!storage) return;
      this.storage = storage;
      const saved = await storage.get(HISTORY_KEY);
      this.runs = (Array.isArray(saved[HISTORY_KEY]) ? saved[HISTORY_KEY] : [])
        .filter(
          (run: RunTrace) => run?.version === 1 && Array.isArray(run.nodes),
        )
        .slice(0, MAX_RUNS);
      let changed = false;
      for (const run of this.runs) {
        if (run.status !== "running" && run.status !== "paused") continue;
        changed = true;
        run.status = "interrupted";
        run.endedAt = run.updatedAt;
        run.error =
          "The extension restarted before this run finished. The last saved events are shown.";
        for (const node of run.nodes)
          if (node.status === "running") {
            node.status = "cancelled";
            node.durationMs = Math.max(0, run.updatedAt - node.startedAt);
          }
      }
      if (changed) await storage.set({ [HISTORY_KEY]: this.runs });
    })());
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      await this.initialize();
      await work();
    });
    this.queue = next.catch((error) => {
      const warning = `Could not save run history: ${message(error)}`;
      if (this.error !== warning) {
        this.error = warning;
        this.notify();
      }
    });
    return next;
  }

  save(run: RunTrace): Promise<void> {
    const snapshot = boundRun(run);
    return this.enqueue(async () => {
      if (this.deleted.has(snapshot.id)) return;
      this.runs = [snapshot, ...this.runs.filter((r) => r.id !== snapshot.id)]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_RUNS);
      await this.storage?.set({ [HISTORY_KEY]: this.runs });
      this.error = undefined;
      this.notify();
    });
  }

  async list(): Promise<RunTrace[]> {
    await this.enqueue(async () => {});
    return structuredClone(this.runs);
  }

  delete(id?: string): Promise<void> {
    return this.enqueue(async () => {
      for (const run of this.runs)
        if (!id || run.id === id) this.deleted.add(run.id);
      this.runs = id ? this.runs.filter((run) => run.id !== id) : [];
      await this.storage?.set({ [HISTORY_KEY]: this.runs });
      this.error = undefined;
      this.notify();
    });
  }
}

export class RunRecorder {
  readonly run: RunTrace;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private sequence = 0;
  constructor(
    private store: RunHistoryStore,
    info: Pick<
      RunTrace,
      "goal" | "provider" | "model" | "helperModel" | "maxSteps"
    >,
    private secrets: string[] = [],
  ) {
    const now = Date.now();
    this.run = {
      version: 1,
      id: crypto.randomUUID(),
      ...sanitizeTrace(info, secrets),
      startedAt: now,
      updatedAt: now,
      status: "running",
      steps: 0,
      nodes: [],
    };
    // Register immediately so clearing history also suppresses a just-started task.
    void this.flush();
  }
  addSecrets(secrets: string[]) {
    this.secrets = [...new Set([...this.secrets, ...secrets].filter(Boolean))];
  }
  private checkpoint() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 250);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const bounded = boundRun(this.run);
    if (bounded.truncated) {
      this.run.truncated = true;
      this.run.goal = bounded.goal;
      this.run.model = bounded.model;
      this.run.helperModel = bounded.helperModel;
      this.run.error = bounded.error;
      // Keep active node references intact while also bounding the in-memory recorder.
      bounded.nodes.forEach((node, index) => {
        this.run.nodes[index].input = node.input;
        this.run.nodes[index].output = node.output;
        this.run.nodes[index].error = node.error;
        this.run.nodes[index].label = node.label;
      });
    }
    await this.store.save(this.run).catch(() => undefined); // diagnostics never stop a task
  }
  update(status: RunTrace["status"], steps: number, error?: string) {
    if (this.closed) return;
    this.run.status = status;
    this.run.steps = steps;
    this.run.updatedAt = Date.now();
    this.run.error = sanitizeTrace(error, this.secrets);
    this.checkpoint();
  }
  finish(status: RunTrace["status"], steps: number, error?: string) {
    if (this.closed) return;
    this.update(status, steps, error);
    this.run.endedAt = Date.now();
    for (const node of this.run.nodes)
      if (node.status === "running") {
        node.status =
          status === "stopped" || status === "interrupted"
            ? "cancelled"
            : status === "error"
              ? "error"
              : "ok";
        node.durationMs = Math.max(0, this.run.endedAt - node.startedAt);
      }
    this.closed = true;
    void this.flush();
  }
  span(
    kind: TraceKind,
    label: string,
    input?: unknown,
    parentId?: string,
  ): TraceSpan {
    if (this.closed) return noopSpan;
    if (this.run.nodes.length >= MAX_NODES) {
      this.run.truncated = true;
      return noopSpan;
    }
    const node: TraceNode = {
      id: String(++this.sequence),
      parentId,
      kind,
      label: sanitizeTrace(label, this.secrets).slice(0, 300),
      startedAt: Date.now(),
      status: "running",
      input: sanitizeTrace(input, this.secrets),
    };
    this.run.nodes.push(node);
    this.run.updatedAt = Date.now();
    this.checkpoint();
    const span: TraceSpan = {
      child: (kind, label, input) => this.span(kind, label, input, node.id),
      end: (output, status = "ok") => {
        if (this.closed || node.status !== "running") return;
        node.durationMs = Math.max(0, Date.now() - node.startedAt);
        node.status = status;
        node.output = sanitizeTrace(output, this.secrets);
        this.run.updatedAt = Date.now();
        this.checkpoint();
      },
      fail: (error, output) => {
        if (this.closed || node.status !== "running") return;
        node.error = sanitizeTrace(message(error), this.secrets);
        span.end(output, "error");
      },
      event: (label, output, status = "ok") =>
        span.child("check", label).end(output, status),
      measure: async (kind, label, input, work) => {
        const child = span.child(kind, label, input);
        try {
          const result = await work(child);
          child.end(result);
          return result;
        } catch (error) {
          child.fail(error);
          throw error;
        }
      },
    };
    return span;
  }
}
