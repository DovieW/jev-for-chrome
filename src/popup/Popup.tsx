import React, { useEffect, useState } from "react";
import {
  Settings2,
  Play,
  StepForward,
  Square,
  Copy,
  Check,
  MousePointer2,
  TextCursorInput,
  Globe,
  Clock3,
  CircleAlert,
  ListFilter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Brand, Hint, PROVIDER_LABELS, sendMessage } from "../ui/app";
import {
  AgentProgress,
  AgentStepLog,
  AppSettings,
  DEFAULT_SETTINGS,
  ExtensionMessage,
} from "../shared/types";
import { activeJevModel } from "../shared/providers";

const STATUSES: Record<
  string,
  { label: string; description: string; dot: string }
> = {
  idle: {
    label: "Ready",
    description: "Working in your current tab",
    dot: "bg-slate-400",
  },
  running: {
    label: "Running",
    description: "You can stop at any time",
    dot: "bg-slate-600 animate-pulse",
  },
  paused: {
    label: "Paused",
    description: "Step through the next action",
    dot: "bg-amber-600",
  },
  done: {
    label: "Complete",
    description: "Review the result on the page",
    dot: "bg-emerald-700",
  },
  blocked: {
    label: "Needs attention",
    description: "Review the page before continuing",
    dot: "bg-amber-600",
  },
  error: {
    label: "Could not continue",
    description: "Check the message below",
    dot: "bg-destructive",
  },
};
function targetTabId(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get("tabId");
  const id = raw ? Number(raw) : NaN;
  return Number.isInteger(id) ? id : undefined;
}
function problemSummary(message: string): string {
  if (
    /No API key|API Key is not configured|API Token must be configured/i.test(
      message,
    )
  )
    return "Add an API key in Settings to start this task.";
  if (/internal browser page/i.test(message))
    return "Open a regular web page, then try again.";
  if (/HTTP 429/i.test(message))
    return "Your provider is rate limiting requests. Try again shortly.";
  if (/HTTP (401|403)/i.test(message))
    return "Your provider rejected the request. Check the API key in Settings.";
  return message.length > 180
    ? "The task could not continue. Review the details before trying again."
    : message;
}
const EXAMPLES = [
  [
    "Find flights",
    "Find one-way flights from Zurich to London on Google Flights",
  ],
  [
    "Search Wikipedia",
    "Search for Taylor Swift and open her early life section",
  ],
  ["Shop", "Add the highest-rated product to shopping cart"],
];
function ActionRow({ log }: { log: AgentStepLog }) {
  const operation = log.operation;
  const Icon =
    operation === "NAVIGATE"
      ? Globe
      : operation === "TYPE_TEXT"
        ? TextCursorInput
        : operation === "DONE"
          ? Check
          : operation === "CLICK"
            ? MousePointer2
            : Clock3;
  const title =
    (
      {
        NAVIGATE: "Opened a starting page",
        TYPE_TEXT: "Entered text",
        CLICK: "Clicked an element",
        SELECT: "Selected an option",
        DONE: "Task complete",
        BLOCKED: "Needs attention",
        PRESS_ENTER: "Pressed Enter",
        WAIT: "Waited for the page",
        SCROLL_DOWN: "Scrolled down",
        SCROLL_UP: "Scrolled up",
        "DONE (vetoed)": "Checking completion",
        "BLOCKED (vetoed)": "Checking another way forward",
      } as Record<string, string>
    )[operation] || operation.toLowerCase().replaceAll("_", " ");
  return (
    <li className="flex gap-3 py-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">{title}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {log.latencyMs} ms
          </span>
        </div>
        {log.targetLabel && (
          <p
            className="mt-1 truncate text-xs text-muted-foreground"
            title={log.targetLabel}
          >
            {log.targetLabel}
          </p>
        )}
        {log.targetValue && (
          <p className="operation-value mt-1 line-clamp-2 text-xs">
            {log.targetValue}
          </p>
        )}
        {(log.confidence !== undefined ||
          log.goalDone !== undefined ||
          log.stuck !== undefined) && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[10px] text-muted-foreground">
              Decision details
            </summary>
            <div className="mt-1 space-y-0.5 text-[10px] tabular-nums text-muted-foreground">
              {log.confidence !== undefined && (
                <p>Confidence {Math.round(log.confidence * 100)}%</p>
              )}
              {log.goalDone !== undefined && (
                <p>Goal achieved {Math.round(log.goalDone * 100)}%</p>
              )}
              {log.stuck !== undefined && (
                <p>Stuck {Math.round(log.stuck * 100)}%</p>
              )}
            </div>
          </details>
        )}
      </div>
    </li>
  );
}

export const Popup: React.FC = () => {
  const [goal, setGoal] = useState("");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [progress, setProgress] = useState<AgentProgress>({
    status: "idle",
    goal: "",
    currentStep: 0,
    maxSteps: 30,
    logs: [],
  });
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const running = progress.status === "running";

  useEffect(() => {
    let live = true;
    Promise.all([
      sendMessage<{ settings: AppSettings }>({ type: "GET_SETTINGS" }),
      sendMessage<{ progress: AgentProgress }>({ type: "GET_PROGRESS" }),
    ])
      .then(([{ settings }, { progress }]) => {
        if (!live) return;
        setSettings(settings);
        setProgress(progress);
        if (progress.goal) setGoal(progress.goal);
        setReady(true);
      })
      .catch((error) => {
        if (live) setMessage(error.message);
      });
    const listener = (message: ExtensionMessage) => {
      if (message.type === "PROGRESS_UPDATE") setProgress(message.progress);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      live = false;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);
  const execute = async (type: "START_AGENT" | "STEP_AGENT" | "STOP_AGENT") => {
    setPending(true);
    setMessage("");
    try {
      await sendMessage({ type, goal: goal.trim(), tabId: targetTabId() });
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setPending(false);
    }
  };
  const toggleLabels = async (show: boolean) => {
    setMessage("");
    try {
      await sendMessage({ type: "TOGGLE_OVERLAY", show, tabId: targetTabId() });
      setSettings((old) => ({ ...old, showOverlay: show }));
    } catch (error: any) {
      setMessage(error.message);
    }
  };
  const copyTrace = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            goal: progress.goal,
            status: progress.status,
            step: `${progress.currentStep}/${progress.maxSteps}`,
            error: progress.lastError,
            provider: settings.activeProvider,
            steps: [...progress.logs]
              .reverse()
              .map((log) => ({
                step: log.step,
                operation: log.operation,
                target: log.targetLabel,
                targetId: log.targetId,
                text: log.targetValue,
                confidence: log.confidence,
                latencyMs: log.latencyMs,
                probabilities: log.probabilities,
                goalDone: log.goalDone,
                stuck: log.stuck,
              })),
          },
          null,
          2,
        ),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setMessage(
        "Could not copy the trace. Check clipboard permissions and try again.",
      );
    }
  };
  const status = STATUSES[progress.status] || STATUSES.idle;
  const error = message || progress.lastError;
  const model = activeJevModel(settings);
  return (
    <div className="popup-shell">
      <header className="flex items-center justify-between border-b px-5 py-4">
        <Brand compact />
        <Hint text="Settings">
          <Button
            aria-label="Settings"
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            <Settings2 className="size-4" />
          </Button>
        </Hint>
      </header>
      <main className="px-5 pt-5">
        <div className="mb-3 flex items-center justify-between">
          <Label htmlFor="goal" className="text-sm font-medium">
            What would you like to do?
          </Label>
          <span className="text-[10px] text-muted-foreground">Current tab</span>
        </div>
        <Textarea
          id="goal"
          className="min-h-[104px] resize-none text-sm leading-relaxed shadow-none"
          placeholder="Search, compare, or fill out a form…"
          value={goal}
          disabled={!ready || running || pending}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (
              (e.metaKey || e.ctrlKey) &&
              e.key === "Enter" &&
              goal.trim() &&
              !running &&
              !pending
            ) {
              e.preventDefault();
              void execute("START_AGENT");
            }
          }}
        />
        <div className="mt-2 flex items-center gap-1">
          <span className="mr-1 text-[10px] text-muted-foreground">Try</span>
          {EXAMPLES.map(([label, value]) => (
            <Button
              key={label}
              size="xs"
              variant="ghost"
              className="px-1.5 text-[10px] font-normal text-muted-foreground"
              disabled={!ready || running || pending}
              onClick={() => {
                setGoal(value);
                document.getElementById("goal")?.focus();
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          {running ? (
            <Button
              variant="outline"
              className="flex-1"
              disabled={pending}
              onClick={() => execute("STOP_AGENT")}
            >
              <Square className="size-3.5" />
              Stop run
            </Button>
          ) : (
            <>
              <Button
                className="flex-1"
                disabled={!ready || pending || !goal.trim()}
                onClick={() => execute("START_AGENT")}
              >
                <Play className="size-3.5" />
                Run task
              </Button>
              <Hint
                text={
                  progress.status === "paused"
                    ? "Execute the next action"
                    : "Start with a single action"
                }
              >
                <Button
                  variant="outline"
                  disabled={!ready || pending || !goal.trim()}
                  onClick={() => execute("STEP_AGENT")}
                >
                  <StepForward className="size-3.5" />
                  Step
                </Button>
              </Hint>
            </>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className={`size-1.5 rounded-full ${status.dot}`} />
            <span>{status.label}</span>
          </div>
          <span className="tabular-nums text-muted-foreground">
            {progress.currentStep} / {progress.maxSteps} steps
          </span>
        </div>
        {error && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive"
          >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0">
              <p>{problemSummary(error)}</p>
              {problemSummary(error) !== error && (
                <details className="mt-2">
                  <summary className="cursor-pointer font-medium">
                    Details
                  </summary>
                  <p className="operation-value mt-2">{error}</p>
                </details>
              )}
              {/API key|API Key|API Token/i.test(error) && (
                <button
                  className="mt-2 font-medium underline underline-offset-2"
                  onClick={() => chrome.runtime.openOptionsPage()}
                >
                  Open Settings
                </button>
              )}
            </div>
          </div>
        )}
        {progress.inputNote && (
          <p className="mt-3 rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            {progress.inputNote}
          </p>
        )}
        <Separator className="my-4" />
        <section aria-label="Activity">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium">Activity</h2>
            <Hint text="Copy the full run trace">
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                disabled={!progress.logs.length}
                onClick={copyTrace}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy trace"}
              </Button>
            </Hint>
          </div>
          {progress.logs.length ? (
            <ol className="activity-list max-h-[170px] divide-y overflow-y-auto pr-1">
              {progress.logs.map((log, i) => (
                <ActionRow key={`${log.timestamp}-${i}`} log={log} />
              ))}
            </ol>
          ) : (
            <div className="py-6 text-center">
              <p className="text-xs font-medium text-muted-foreground">
                Ready when you are
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Your actions will appear here as the task runs.
              </p>
            </div>
          )}
        </section>
        <Separator className="mb-3 mt-2" />
        <div className="flex items-center justify-between pb-4">
          <Label
            htmlFor="page-labels"
            className="flex items-center gap-2 text-xs font-normal text-muted-foreground"
          >
            <ListFilter className="size-3.5" />
            Page labels
          </Label>
          <Switch
            id="page-labels"
            size="sm"
            disabled={!ready || pending}
            checked={settings.showOverlay}
            onCheckedChange={toggleLabels}
          />
        </div>
      </main>
      <footer className="flex items-center justify-between border-t bg-muted/30 px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium">
            {PROVIDER_LABELS[settings.activeProvider]}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {model}
          </p>
        </div>
        <Badge
          variant="outline"
          className="gap-1.5 border-border bg-background py-1 text-[10px] font-normal text-muted-foreground"
        >
          <span className="size-1 rounded-full bg-slate-400" />
          Local extension
        </Badge>
      </footer>
      <span className="sr-only" role="status" aria-live="polite">
        {status.label}. {status.description}
      </span>
    </div>
  );
};
