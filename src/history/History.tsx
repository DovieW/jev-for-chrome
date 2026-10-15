import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  GitBranch,
  History as HistoryIcon,
  Loader2,
  Settings2,
  Trash2,
  X,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ModelCalls } from "./ModelCalls";
import { parseRunExport } from "./exchanges";
import { Brand, PROVIDER_LABELS, sendMessage } from "../ui/app";
import type { RunTrace, TraceNode } from "../shared/trace";
import {
  duration,
  elapsed,
  pretty,
  questionLabel,
  STAGES,
  stageTimes,
} from "./format";

const STATUS: Record<RunTrace["status"], string> = {
  running: "Running",
  paused: "Paused",
  done: "Complete",
  blocked: "Needs attention",
  error: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};
const date = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const isIssue = (node: TraceNode) =>
  ["error", "skipped", "cancelled"].includes(node.status);

function JsonDetail({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value === undefined) return null;
  return (
    <details
      className="trace-json"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Braces className="size-3.5" />
        {label}
      </summary>
      {open && <pre>{JSON.stringify(value, null, 2)}</pre>}
    </details>
  );
}

function Question({
  name,
  question,
  answer,
  selected,
  local = false,
}: {
  name: string;
  question: any;
  answer: any;
  selected: boolean;
  local?: boolean;
}) {
  const [all, setAll] = useState(false);
  const [search, setSearch] = useState("");
  if (!answer && !selected) return null;
  const rawProbability = answer?.noul ?? answer?.probability;
  if (question?.type === "noul")
    return (
      <div className="predicate-row">
        <span>
          {name === "goal_done"
            ? "Goal achieved"
            : name === "stuck"
              ? "Progress is stuck"
              : pretty(name)}
        </span>
        <span>
          {typeof rawProbability === "number"
            ? `${Math.round(rawProbability * 100)}%`
            : "No answer"}
        </span>
      </div>
    );
  if (!question?.criteria) return null;
  const choices = Object.entries(question.criteria).sort(
    ([a], [b]) =>
      Number(b === answer?.choice) - Number(a === answer?.choice) ||
      (answer?.probabilities?.[b] ?? -1) - (answer?.probabilities?.[a] ?? -1),
  );
  const filtered = choices.filter(([key, value]) =>
    `${key} ${questionLabel(value, key)}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="choice-branch">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {name === "operation" ? "Operation" : pretty(name)}{" "}
          <span className="font-normal text-muted-foreground">
            · {choices.length} {choices.length === 1 ? "option" : "options"}
          </span>
        </span>
        <span className="text-muted-foreground">
          {local
            ? "Selected locally"
            : !answer
              ? "No answer returned"
              : typeof answer.confidence === "number"
                ? `${Math.round(answer.confidence * 100)}% confidence`
                : ""}
        </span>
      </div>
      {all && choices.length > 8 && (
        <input
          type="search"
          aria-label={`Filter ${pretty(name)} options`}
          placeholder="Filter options…"
          className="mb-2 h-8 w-full rounded-md border bg-background px-2 text-xs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}
      <div className="choice-options">
        {(all ? filtered : filtered.slice(0, 4)).map(([key, value]) => {
          const probability = answer?.probabilities?.[key];
          return (
            <div
              key={key}
              className={`choice-option ${key === answer?.choice ? "chosen" : ""}`}
            >
              <span className="choice-marker">
                {key === answer?.choice ? (
                  <Check className="size-3.5" />
                ) : (
                  <span />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <span className="block text-xs leading-relaxed">
                  {name === "operation"
                    ? pretty(key)
                    : questionLabel(value, key)}
                </span>
                {name === "operation" && (
                  <span className="block text-[11px] leading-relaxed text-muted-foreground">
                    {questionLabel(value, key)}
                  </span>
                )}
                {typeof probability === "number" && (
                  <div className="probability-track">
                    <div
                      style={{
                        width: `${Math.min(100, Math.max(0, probability * 100))}%`,
                      }}
                    />
                  </div>
                )}
              </div>
              <span
                className="w-11 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                title={
                  typeof probability === "number"
                    ? "Provider-reported probability"
                    : "Provider did not report a probability"
                }
              >
                {typeof probability === "number"
                  ? `${(probability * 100).toFixed(1)}%`
                  : "—"}
              </span>
            </div>
          );
        })}
        {!filtered.length && (
          <p className="p-3 text-xs text-muted-foreground">
            No matching options.
          </p>
        )}
      </div>
      {choices.length > 4 && (
        <button
          className="mt-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            setAll(!all);
            setSearch("");
          }}
        >
          {all ? "Show fewer options" : `Show all ${choices.length} options`}
        </button>
      )}
    </div>
  );
}

function Decisions({
  node,
  localQuestions,
}: {
  node: TraceNode;
  localQuestions: string[];
}) {
  const questions = node.input?.questions;
  if (!questions || Array.isArray(questions)) return null;
  const answers = node.output?.answers || {};
  const operation = answers.operation?.choice;
  const target = operation ? `${operation.toLowerCase()}_target` : undefined;
  return (
    <div className="decision-branches">
      {questions.operation && (
        <Question
          name="operation"
          question={questions.operation}
          answer={answers.operation}
          local={localQuestions.includes("operation")}
          selected
        />
      )}
      <div className="predicate-group">
        {["goal_done", "stuck"].map(
          (name) =>
            questions[name] && (
              <Question
                key={name}
                name={name}
                question={questions[name]}
                answer={answers[name]}
                selected
              />
            ),
        )}
      </div>
      {target && questions[target] && (
        <>
          <div className="branch-connector">
            <ArrowRight className="size-3.5" />
            <span>Target for {pretty(operation)}</span>
          </div>
          <Question
            name={target}
            question={questions[target]}
            answer={answers[target]}
            local={localQuestions.includes(target)}
            selected
          />
        </>
      )}
      {!operation && (
        <p className="text-xs text-muted-foreground">
          No complete decision returned. Expand the API attempts below to
          inspect partial answers or refusals.
        </p>
      )}
    </div>
  );
}

function NodeView({
  node,
  run,
  now,
  issuesOnly,
  expandVersion,
  expanded,
}: {
  node: TraceNode;
  run: RunTrace;
  now: number;
  issuesOnly: boolean;
  expandVersion: number;
  expanded: boolean;
}) {
  const children = run.nodes.filter((child) => child.parentId === node.id);
  const descendantIssue = (id: string): boolean =>
    run.nodes.some(
      (child) =>
        child.parentId === id && (isIssue(child) || descendantIssue(child.id)),
    );
  const [open, setOpen] = useState(
    node.kind === "cycle" || node.kind === "decision" || isIssue(node),
  );
  useEffect(() => {
    if (expandVersion) setOpen(expanded);
  }, [expandVersion, expanded]);
  useEffect(() => {
    if (issuesOnly) setOpen(true);
  }, [issuesOnly]);
  if (issuesOnly && !isIssue(node) && !descendantIssue(node.id)) return null;
  const selected =
    node.kind === "decision"
      ? node.output?.answers?.operation?.choice
      : node.kind === "cycle"
        ? children.find((child) => child.kind === "decision")?.output?.answers
            ?.operation?.choice
        : undefined;
  const icon =
    node.status === "running" ? (
      <Loader2 className="size-3.5 animate-spin" />
    ) : isIssue(node) ? (
      <CircleAlert className="size-3.5" />
    ) : (
      <Check className="size-3.5" />
    );
  return (
    <details
      className={`trace-node trace-${node.kind} trace-${node.status}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight className="trace-chevron size-3.5 shrink-0 text-muted-foreground" />
        <span className="trace-state">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="trace-label">
            {node.label}
            {selected && (
              <span className="ml-2 text-muted-foreground">
                → {pretty(selected)}
              </span>
            )}
          </span>
          <span className="trace-offset">
            +{duration(Math.max(0, node.startedAt - run.startedAt))} from start
            {node.status === "skipped" ? " · Reconsidered" : ""}
            {node.status === "cancelled" ? " · Cancelled" : ""}
          </span>
        </span>
        <span
          className="trace-duration"
          title="Duration includes nested events"
        >
          {duration(elapsed(node, now))}
        </span>
      </summary>
      <div className="trace-body">
        {node.error && (
          <p className="mb-3 break-words text-xs text-destructive">
            {node.error}
          </p>
        )}
        {node.kind === "decision" && (
          <Decisions
            node={node}
            localQuestions={children
              .filter((child) => child.label.startsWith("Only one candidate: "))
              .map((child) => child.label.slice("Only one candidate: ".length))}
          />
        )}
        {node.kind === "check" && node.output && (
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            {node.output.outcome ||
              node.output.message ||
              node.output.source ||
              node.output.next}
            {typeof node.output.compactionLevel === "number" &&
              `Input compression ${node.output.compactionLevel} exceeded the context limit. ${node.output.retrying ? "Trying a smaller input." : "No more retries."}`}
          </p>
        )}
        {node.kind === "observe" && node.output?.url && (
          <div className="mb-3 text-xs leading-relaxed">
            <p className="font-medium">{node.output.title}</p>
            <p className="break-all text-muted-foreground">{node.output.url}</p>
            <p className="mt-1 text-muted-foreground">
              {node.output.actions} available actions ·{" "}
              {node.output.omittedActions} omitted from observation
            </p>
          </div>
        )}
        {node.kind === "action" && node.output && (
          <div className="mb-2 text-xs text-muted-foreground">
            {node.output.ok === true
              ? `Executed via ${node.output.via === "cdp" ? "trusted browser input" : node.output.via}`
              : node.output.message ||
                node.output.reason ||
                node.output.url ||
                node.output.navigation}
          </div>
        )}
        {node.kind === "helper" && typeof node.output === "string" && (
          <p className="mb-3 whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs">
            {node.output}
          </p>
        )}
        <JsonDetail
          label={
            node.kind === "decision"
              ? "Observation & instructions"
              : node.kind === "request"
                ? "Request body"
                : "Input"
          }
          value={node.input}
        />
        <JsonDetail
          label={node.kind === "request" ? "Response body" : "Result"}
          value={node.output}
        />
        {children.length > 0 && (
          <div className="trace-children">
            {children.map((child) => (
              <NodeView
                key={child.id}
                node={child}
                run={run}
                now={now}
                issuesOnly={issuesOnly}
                expandVersion={expandVersion}
                expanded={expanded}
              />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function RunDetail({
  run,
  now,
  onDelete,
  imported = false,
}: {
  run: RunTrace;
  now: number;
  onDelete: (id?: string) => void;
  imported?: boolean;
}) {
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expandVersion, setExpandVersion] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const times = stageTimes(run, now);
  const total = times.reduce((a, b) => a + b, 0);
  const requests = run.nodes.filter((node) => node.kind === "request");
  const problems = run.nodes.filter((node) => isIssue(node));
  const wall = Math.max(
    0,
    (run.endedAt ?? (run.status === "running" ? now : run.updatedAt)) -
      run.startedAt,
  );
  const exportRun = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `jev-run-${run.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <article className="min-w-0" aria-label="Run details">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge
            variant="outline"
            className={`run-status status-${run.status}`}
          >
            <span />
            {STATUS[run.status]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {date(run.startedAt)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={exportRun}>
            <Download />
            Export JSON
          </Button>
          {!imported && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete this run"
              onClick={() => setConfirmDelete(!confirmDelete)}
            >
              <Trash2 className="size-4 text-muted-foreground" />
            </Button>
          )}
        </div>
      </div>
      {confirmDelete && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-xs">
          <span className="flex-1">Delete this run and its saved details?</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onDelete(run.id)}
          >
            Delete run
          </Button>
        </div>
      )}
      <h2 className="run-goal">{run.goal}</h2>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {PROVIDER_LABELS[run.provider as keyof typeof PROVIDER_LABELS] ||
          run.provider}{" "}
        <span className="mx-1">/</span> {run.model}
        <span className="mx-2">·</span>Text helper: {run.helperModel}
      </p>
      <div className="run-metrics">
        <div>
          <span>Elapsed</span>
          <strong>{duration(wall)}</strong>
          <small>Includes pauses between steps</small>
        </div>
        <div>
          <span>Actions</span>
          <strong>
            {run.steps}
            <em> / {run.maxSteps}</em>
          </strong>
          <small>
            {run.nodes.filter((node) => node.kind === "cycle").length} decision
            {run.nodes.filter((node) => node.kind === "cycle").length === 1
              ? " cycle"
              : " cycles"}
          </small>
        </div>
        <div>
          <span>API attempts</span>
          <strong>{requests.length}</strong>
          <small>
            {requests.filter((node) => node.status === "error").length} failed
            attempts
          </small>
        </div>
      </div>
      {run.error && (
        <div role="alert" className="run-error">
          <CircleAlert className="size-4 shrink-0" />
          <p>{run.error}</p>
        </div>
      )}
      {run.truncated && (
        <div className="mb-5 rounded-lg border p-3 text-xs text-muted-foreground">
          Some diagnostic details were omitted or shortened to keep history
          within its local storage limit. Retained events and timings are shown
          below.
        </div>
      )}
      <section className="timing-card" aria-label="Latency breakdown">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-medium">Where the time went</h3>
          <span className="text-xs text-muted-foreground">
            {duration(total)} measured
          </span>
        </div>
        <div
          className="timing-bar"
          role="img"
          aria-label={STAGES.map(
            (stage, i) => `${stage.name}: ${duration(times[i])}`,
          ).join(", ")}
        >
          {STAGES.map(
            (stage, i) =>
              times[i] > 0 && (
                <span
                  key={stage.name}
                  className={stage.className}
                  style={{ flex: times[i] }}
                  title={`${stage.name}: ${duration(times[i])}`}
                />
              ),
          )}
        </div>
        <div className="timing-legend">
          {STAGES.map((stage, i) => (
            <div key={stage.name}>
              <span className={`stage-dot ${stage.className}`} />
              <span>{stage.name}</span>
              <strong>{duration(times[i])}</strong>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          API timing includes network time. Nested events count once; idle time
          is excluded.
        </p>
      </section>
      <Tabs defaultValue="calls" className="mt-7">
        <TabsList aria-label="Run view">
          <TabsTrigger value="calls">Model calls</TabsTrigger>
          <TabsTrigger value="execution">Execution trace</TabsTrigger>
        </TabsList>
        <TabsContent value="calls">
          <ModelCalls run={run} now={now} />
        </TabsContent>
        <TabsContent value="execution">
          <div className="mb-4 mt-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <GitBranch className="size-4 text-muted-foreground" />
                Decision path
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Choices, alternatives, and execution checks. Expand any event.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setExpanded(!expanded);
                  setExpandVersion((version) => version + 1);
                }}
              >
                {expanded ? "Collapse all" : "Expand all"}
              </Button>
              <Switch
                id="issues-only"
                checked={issuesOnly}
                onCheckedChange={setIssuesOnly}
              />
              <Label htmlFor="issues-only" className="text-xs">
                Issues only
              </Label>
            </div>
          </div>
          {issuesOnly && !problems.length ? (
            <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
              No failed or reconsidered events in this run.
            </div>
          ) : (
            <div className="trace-tree">
              {run.nodes
                .filter((node) => !node.parentId)
                .map((node) => (
                  <NodeView
                    key={node.id}
                    node={node}
                    run={run}
                    now={now}
                    issuesOnly={issuesOnly}
                    expandVersion={expandVersion}
                    expanded={expanded}
                  />
                ))}
            </div>
          )}
          {!run.nodes.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Waiting for the first event…
            </p>
          )}
          <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground">
            Probabilities are reported by the provider; a single available
            target may be selected locally. This view shows recorded inputs,
            answers, and checks—not private model reasoning. Parent timings
            include their child events.
          </p>
        </TabsContent>
      </Tabs>
    </article>
  );
}

export function History() {
  const [runs, setRuns] = useState<RunTrace[]>([]);
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("run"),
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [imported, setImported] = useState<RunTrace | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const run = imported ?? runs.find((run) => run.id === selected) ?? runs[0];
  useEffect(() => {
    let live = true,
      version = 0;
    const refresh = async () => {
      const request = ++version;
      try {
        const result = await sendMessage<{
          runs: RunTrace[];
          warning?: string;
        }>({ type: "GET_RUN_HISTORY" });
        if (live && request === version) {
          setRuns(result.runs);
          setError(result.warning || "");
          setReady(true);
        }
      } catch (error) {
        if (live) {
          setError((error as Error).message);
          setReady(true);
        }
      }
    };
    const listener = (message: { type: string }) => {
      if (message.type === "RUN_HISTORY_UPDATED") void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    window.addEventListener("focus", refresh);
    void refresh();
    return () => {
      live = false;
      chrome.runtime.onMessage.removeListener(listener);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  useEffect(() => {
    if (run?.status !== "running" || imported) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [run?.status, imported]);
  const remove = async (id?: string) => {
    try {
      const result = await sendMessage<{ runs: RunTrace[] }>({
        type: "DELETE_RUN_HISTORY",
        id,
      });
      setRuns(result.runs);
      setConfirmClear(false);
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const openExport = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 8_000_000)
        throw new Error("Choose a run export smaller than 8 MB.");
      setImported(parseRunExport(await file.text()));
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return (
    <div className="history-shell">
      <header className="app-header">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-6">
          <Brand />
          <Button variant="ghost" size="sm" asChild>
            <a href="options.html">
              <Settings2 />
              Settings
            </a>
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-6 py-8">
        <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <HistoryIcon className="size-3.5" />
              Diagnostics
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Run history
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              See what Jev saw, chose, and did.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Open run export"
              onChange={(event) => {
                void openExport(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              <FolderOpen />
              Open JSON
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!runs.length}
              onClick={() => setConfirmClear(!confirmClear)}
            >
              <Trash2 />
              Clear history
            </Button>
          </div>
        </div>
        {error && (
          <div role="alert" className="run-error">
            <CircleAlert className="size-4 shrink-0" />
            {error}
          </div>
        )}
        {imported && (
          <div className="import-notice">
            <p>
              <strong>Viewing an exported run.</strong> Opened locally for
              inspection; saved history is unchanged.
            </p>
            <Button variant="ghost" size="sm" onClick={() => setImported(null)}>
              <X />
              Close file
            </Button>
          </div>
        )}
        {confirmClear && (
          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-sm">
            <p className="flex-1">
              Delete all saved runs? An active task will keep running, without
              saving its remaining trace.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmClear(false)}
            >
              <X />
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={() => remove()}>
              Delete all runs
            </Button>
          </div>
        )}
        {!ready ? (
          <div className="history-empty">
            <Loader2 className="size-7 animate-spin text-muted-foreground" />
            <h2>Loading run history…</h2>
          </div>
        ) : !run ? (
          <div className="history-empty">
            <span className="empty-icon">
              <GitBranch className="size-6" />
            </span>
            <h2>No runs yet</h2>
            <p>
              Start a task from the extension popup or voice shortcut.
              <br />
              Your latest five runs will appear here.
            </p>
          </div>
        ) : (
          <div className="history-layout">
            <aside aria-label="Recent runs">
              <div className="mb-3 flex justify-between text-xs text-muted-foreground">
                <span>Recent runs</span>
                <span>{runs.length} / 5</span>
              </div>
              <nav className="run-list">
                {runs.map((item) => (
                  <button
                    key={item.id}
                    className={`run-list-item ${item.id === run.id ? "selected" : ""}`}
                    aria-current={item.id === run.id ? "true" : undefined}
                    onClick={() => {
                      setImported(null);
                      setSelected(item.id);
                      window.history.replaceState(null, "", `?run=${item.id}`);
                    }}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className={`run-status status-${item.status}`}>
                        <span />
                        {STATUS[item.status]}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {date(item.startedAt)}
                      </span>
                    </div>
                    <span className="run-list-goal">{item.goal}</span>
                    <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Clock3 className="size-3" />
                      <span>
                        {duration(
                          (item.endedAt ?? item.updatedAt) - item.startedAt,
                        )}
                      </span>
                      <span className="mx-1">·</span>
                      <span>
                        {item.steps} {item.steps === 1 ? "action" : "actions"}
                      </span>
                    </div>
                  </button>
                ))}
              </nav>
              <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
                Only the latest five runs are kept on this device. Details can
                include page text, tab URLs, and generated text. API keys and
                audio are excluded.
              </p>
            </aside>
            <RunDetail
              key={`${imported ? "imported-" : ""}${run.id}`}
              run={run}
              now={imported ? run.updatedAt : now}
              onDelete={remove}
              imported={Boolean(imported)}
            />
          </div>
        )}
      </main>
    </div>
  );
}
