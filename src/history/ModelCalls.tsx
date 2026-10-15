import { useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Search,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import type { RunTrace, TraceNode } from "../shared/trace";
import { duration, elapsed, pretty, questionLabel } from "./format";
import {
  decode,
  explainRun,
  localTarget,
  object,
  readExchange,
  type Exchange,
  type ReturnedAnswer,
  type SentQuestion,
} from "./exchanges";

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const pct = (value: number) => `${Number((value * 100).toFixed(2))}%`;

/** Readable field/value rendering for all prompt fields, including provider-specific ones. */
function Fields({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === undefined)
    return <span className="text-muted-foreground">Not recorded</span>;
  if (value === null) return <code>null</code>;
  if (value === "")
    return <span className="text-muted-foreground">(empty string)</span>;
  if (Array.isArray(value) && !value.length) return <code>[]</code>;
  if (object(value) && !Object.keys(value).length) return <code>{"{}"}</code>;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return <span className="prompt-text">{String(value)}</span>;
  if (depth > 12) return <span>Nested detail is available in Raw JSON.</span>;
  if (Array.isArray(value))
    return (
      <ol className="prompt-list">
        {value.map((entry, i) => (
          <li key={i}>
            <Fields value={entry} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  return (
    <dl className="prompt-fields">
      {Object.entries(object(value) ?? {}).map(([key, entry]) => (
        <div key={key}>
          <dt>{pretty(key)}</dt>
          <dd>
            <Fields value={entry} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Controls({
  elements,
  selectedId,
}: {
  elements: any[];
  selectedId?: string;
}) {
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const typed = elements.filter((element) =>
    list(element.operations).includes("TYPE_TEXT"),
  );
  const sorted = [...elements].sort(
    (a, b) => Number(b.index === selectedId) - Number(a.index === selectedId),
  );
  const filtered = sorted.filter(
    (element) =>
      (!typing || list(element.operations).includes("TYPE_TEXT")) &&
      JSON.stringify(element).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="context-section">
      <div className="context-heading">
        <h4>Interactive controls</h4>
        <span>
          {elements.length} sent · {typed.length} typing{" "}
          {typed.length === 1 ? "field" : "fields"}
        </span>
      </div>
      <div className="control-filter">
        <Search className="size-3.5" />
        <input
          aria-label="Filter sent controls"
          placeholder="Find a control, value, or ID…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button aria-pressed={typing} onClick={() => setTyping(!typing)}>
          {typing ? "All controls" : "Typing fields"}
        </button>
      </div>
      {selectedId && elements.some((e) => e.index === selectedId) && (
        <p className="inspector-note">
          The target selected by the extension is shown first.
        </p>
      )}
      <div
        className="context-scroll controls-table"
        tabIndex={0}
        aria-label="Controls sent to the model"
      >
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Control and permitted actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((element, index) => (
              <tr
                key={index}
                className={element.index === selectedId ? "target-row" : ""}
              >
                <td>#{String(element.index)}</td>
                <td>
                  <details open={element.index === selectedId || undefined}>
                    <summary>
                      <span>{element.label || "(unlabelled control)"}</span>
                      {element.index === selectedId && (
                        <span className="target-tag">Chosen target</span>
                      )}
                      <ChevronDown className="size-3" />
                    </summary>
                    <div className="control-details">
                      <Fields
                        value={Object.fromEntries(
                          Object.entries(element).filter(
                            ([key]) =>
                              !["index", "label", "operations"].includes(key),
                          ),
                        )}
                      />
                    </div>
                  </details>
                  <div className="control-operations">
                    {element.role && <span>{element.role}</span>}
                    {list(element.operations).map((operation, i) => (
                      <span key={i}>{pretty(String(operation))}</span>
                    ))}
                  </div>
                  {Object.hasOwn(element, "value") && (
                    <p className="control-value">
                      Value:{" "}
                      {element.value === "" ? "(empty)" : String(element.value)}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="p-3 text-xs text-muted-foreground">
            No matching controls.
          </p>
        )}
      </div>
      <p className="inspector-note">
        Showing {filtered.length} of {elements.length} recorded controls. Expand
        a control for all its fields.
      </p>
    </section>
  );
}

function TabsSent({ tabs, activeId }: { tabs: any[]; activeId?: number }) {
  const [query, setQuery] = useState("");
  const filtered = tabs.filter((tab) =>
    JSON.stringify(tab).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="context-section">
      <div className="context-heading">
        <h4>Open tabs</h4>
        <span>{tabs.length} sent</span>
      </div>
      <input
        className="context-search"
        type="search"
        aria-label="Filter sent tabs"
        placeholder="Find a tab…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        className="context-scroll tab-context"
        tabIndex={0}
        aria-label="Tabs sent to the model"
      >
        {filtered.map((tab, i) => (
          <div key={i}>
            <p>
              <span className="text-muted-foreground">#{String(tab.id)}</span>{" "}
              {tab.title || "(untitled)"}
              {tab.id === activeId && (
                <span className="target-tag">Current</span>
              )}
            </p>
            <p className="tab-url">{tab.url}</p>
            {tab.windowId !== undefined && (
              <p className="inspector-note">Window {tab.windowId}</p>
            )}
          </div>
        ))}
        {!filtered.length && <p>No matching tabs.</p>}
      </div>
    </section>
  );
}

function Context({
  state,
  selectedId,
}: {
  state: Record<string, any>;
  selectedId?: string;
}) {
  const known = new Set([
    "task",
    "goal",
    "field",
    "page",
    "elements",
    "browser",
    "recent_actions",
    "run",
  ]);
  const extras = Object.fromEntries(
    Object.entries(state).filter(([key]) => !known.has(key)),
  );
  const page = object(state.page);
  return (
    <div className="model-context">
      {("task" in state || "goal" in state) && (
        <section className="context-section">
          <h4>Goal sent to this model</h4>
          <p className="goal-sent">{state.task ?? state.goal}</p>
        </section>
      )}
      {state.field && (
        <section className="context-section">
          <h4>Selected field sent to the helper</h4>
          <div className="selected-field">
            <Fields value={state.field} />
          </div>
        </section>
      )}
      {page && (
        <section className="context-section">
          <div className="context-heading">
            <h4>Page context</h4>
            {typeof page.text === "string" && (
              <span>{page.text.length.toLocaleString()} text characters</span>
            )}
          </div>
          <p className="page-title">{page.title}</p>
          {page.url && <p className="tab-url">{page.url}</p>}
          <div
            className="context-scroll page-excerpt"
            tabIndex={0}
            aria-label="Page text sent to the model"
          >
            {page.text === "" ? (
              "(empty page text)"
            ) : (
              <Fields value={page.text} />
            )}
          </div>
          {Object.keys(page).some(
            (k) => !["url", "title", "text"].includes(k),
          ) && (
            <Fields
              value={Object.fromEntries(
                Object.entries(page).filter(
                  ([key]) => !["url", "title", "text"].includes(key),
                ),
              )}
            />
          )}
          <p className="inspector-note">
            This is the extracted text in this request. It is not a screenshot
            of the page.
          </p>
        </section>
      )}
      {Array.isArray(state.elements) && (
        <Controls elements={state.elements} selectedId={selectedId} />
      )}
      {object(state.browser) && (
        <>
          <TabsSent
            tabs={list(state.browser.open_tabs)}
            activeId={state.browser.active_tab_id}
          />
          {Object.keys(state.browser).some(
            (k) => !["open_tabs", "active_tab_id"].includes(k),
          ) && (
            <Fields
              value={Object.fromEntries(
                Object.entries(state.browser).filter(
                  ([key]) => !["open_tabs", "active_tab_id"].includes(key),
                ),
              )}
            />
          )}
        </>
      )}
      {Array.isArray(state.recent_actions) && (
        <section className="context-section">
          <h4>Recent actions sent</h4>
          {state.recent_actions.length ? (
            <div className="context-scroll">
              <Fields value={state.recent_actions} />
            </div>
          ) : (
            <p className="inspector-note">
              None. This request contained no previous actions.
            </p>
          )}
        </section>
      )}
      {state.run && (
        <section className="context-section">
          <h4>Run progress sent</h4>
          <Fields value={state.run} />
        </section>
      )}
      {Object.keys(extras).length > 0 && (
        <section className="context-section">
          <h4>Additional context sent</h4>
          <Fields value={extras} />
        </section>
      )}
    </div>
  );
}

function SentQuestions({ questions }: { questions: SentQuestion[] }) {
  return (
    <div className="sent-questions">
      {questions.map((question) => (
        <section key={question.name} className="context-section">
          <div className="context-heading">
            <h4>{pretty(question.name)}</h4>
            <span>
              {question.type === "noul" ? "predicate" : question.type}
            </span>
          </div>
          <div className="question-instructions">
            <Fields value={question.instructions} />
          </div>
          {question.choices.length > 0 && (
            <details
              className="offered-choices"
              open={question.name === "operation" || undefined}
            >
              <summary>
                {question.choices.length} candidate descriptions sent
              </summary>
              <div className="context-scroll">
                {question.choices.map((choice) => (
                  <div key={choice.id}>
                    <h5>{choice.id}</h5>
                    <Fields value={decode(choice.description)} />
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}

function Answer({
  answer,
  question,
}: {
  answer: ReturnedAnswer;
  question?: SentQuestion;
}) {
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const choices = new Map(
    question?.choices.map((choice) => [choice.id, choice.description]) ?? [],
  );
  const probabilities = Object.entries(answer.probabilities).sort(
    (a, b) => b[1] - a[1],
  );
  const filtered = probabilities.filter(([id]) =>
    `${id} ${questionLabel(choices.get(id), id)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="returned-answer">
      <h4>{pretty(answer.name)}</h4>
      {answer.type === "refusal" ? (
        <div className="exchange-warning">
          <CircleAlert className="size-4" />
          <div>
            <p>Model refused this question.</p>
            <Fields value={answer.raw} />
          </div>
        </div>
      ) : answer.choice !== undefined ? (
        <>
          <div className="selected-answer">
            <Check className="size-4" />
            <strong>
              {question?.name === "operation"
                ? pretty(answer.choice)
                : questionLabel(choices.get(answer.choice), answer.choice)}
            </strong>
            <code>{answer.choice}</code>
          </div>
          <div className="answer-scores">
            {typeof answer.confidence === "number" && (
              <span>
                <strong>{pct(answer.confidence)}</strong> confidence
              </span>
            )}
            {typeof answer.probabilities[answer.choice] === "number" && (
              <span>
                <strong>{pct(answer.probabilities[answer.choice])}</strong>{" "}
                choice probability
              </span>
            )}
          </div>
          {!choices.has(answer.choice) && (
            <p className="inspector-note">
              {question
                ? "This choice has no matching candidate in the saved request."
                : "The offered choices are unavailable because this question was not retained in the saved request."}
            </p>
          )}
          {all && probabilities.length > 12 && (
            <input
              className="context-search"
              aria-label={`Filter ${answer.name} probabilities`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find an alternative…"
            />
          )}
          <div className="answer-probabilities">
            {(all ? filtered : filtered.slice(0, 8)).map(
              ([id, probability]) => (
                <div
                  key={id}
                  className={id === answer.choice ? "chosen-probability" : ""}
                >
                  <span>
                    {question?.name === "operation"
                      ? pretty(id)
                      : questionLabel(choices.get(id), id)}
                  </span>
                  <strong>
                    {typeof probability === "number"
                      ? pct(probability)
                      : "Invalid value"}
                  </strong>
                  <i>
                    <b
                      style={{
                        width: `${typeof probability === "number" ? Math.max(0, Math.min(100, probability * 100)) : 0}%`,
                      }}
                    />
                  </i>
                </div>
              ),
            )}
          </div>
          {probabilities.length > 8 && (
            <button
              className="inspector-link"
              onClick={() => {
                setAll(!all);
                setQuery("");
              }}
            >
              {all
                ? "Show fewer alternatives"
                : `Show all ${probabilities.length} returned probabilities`}
            </button>
          )}
          {!probabilities.length && (
            <p className="inspector-note">
              No option probabilities were returned.
            </p>
          )}
        </>
      ) : typeof answer.probability === "number" ? (
        <div className="predicate-answer">
          <strong>{pct(answer.probability)}</strong>
          <span>
            {answer.name === "goal_done"
              ? "probability the goal is achieved"
              : answer.name === "stuck"
                ? "probability progress is stuck"
                : "probability the statement is true"}
          </span>
        </div>
      ) : (
        <Fields value={answer.raw} />
      )}
    </section>
  );
}

function Result({ exchange }: { exchange: Exchange }) {
  const { node, answers, questions, replies } = exchange;
  return (
    <div>
      {node.error && (
        <div className="exchange-warning">
          <CircleAlert className="size-4" />
          <p>{node.error}</p>
        </div>
      )}
      {node.output?.responseBodyTruncated && (
        <p className="inspector-note">
          Only the first 8,000 characters of this error response were saved.
        </p>
      )}
      {exchange.responseMissing && (
        <div className="exchange-warning">
          <CircleAlert className="size-4" />
          <p>
            {node.status === "running"
              ? "Waiting for the provider response."
              : node.output?.retrying
                ? `HTTP ${exchange.httpStatus}. A retry was scheduled; no response body was saved for this attempt.`
                : "The response body is not available in this trace. Check the error or Raw JSON for retained details."}
          </p>
        </div>
      )}
      {answers.map((answer) => (
        <Answer
          key={answer.name}
          answer={answer}
          question={questions.find((q) => q.name === answer.name)}
        />
      ))}
      {replies.map((reply, index) => (
        <section className="returned-answer" key={index}>
          <h4>Exact assistant message</h4>
          <pre className="assistant-reply">{reply.raw}</pre>
          {object(reply.value) && Object.hasOwn(reply.value, "text") && (
            <div
              className={
                reply.value.text === null ? "exchange-warning" : "returned-text"
              }
            >
              <p>
                {reply.value.text === null
                  ? "The model returned null: no text value was supplied for this field."
                  : "Text value returned:"}
              </p>
              {reply.value.text !== null && <Fields value={reply.value.text} />}
            </div>
          )}
          {object(reply.value) && Object.hasOwn(reply.value, "url") && (
            <p className="returned-text">
              Starting URL: {String(reply.value.url)}
            </p>
          )}
          {reply.finishReason && (
            <p className="inspector-note">
              Finish reason: {reply.finishReason}
            </p>
          )}
        </section>
      ))}
      {!exchange.responseMissing && !answers.length && !replies.length && (
        <Fields value={node.output?.response} />
      )}
      {questions
        .filter((q) => !answers.some((a) => a.name === q.name))
        .map(
          (q) =>
            !exchange.responseMissing && (
              <p className="inspector-note" key={q.name}>
                No answer was returned for {pretty(q.name)}.
              </p>
            ),
        )}
      {exchange.usage && (
        <section className="token-usage">
          <h4>Reported token usage</h4>
          <div>
            {typeof exchange.usage.input === "number" && (
              <span>
                <strong>{exchange.usage.input.toLocaleString()}</strong> input
              </span>
            )}
            {typeof exchange.usage.output === "number" && (
              <span>
                <strong>{exchange.usage.output.toLocaleString()}</strong> output
              </span>
            )}
            {typeof exchange.usage.cached === "number" && (
              <span>
                <strong>{exchange.usage.cached.toLocaleString()}</strong> cached
                input
              </span>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function RawExchange({ node }: { node: TraceNode }) {
  return (
    <div className="raw-exchange">
      <p className="inspector-note">
        Recorded request and response bodies, with the trace’s redactions and
        omissions preserved.
      </p>
      <h4>Request body</h4>
      <pre>{JSON.stringify(node.input ?? { unavailable: true }, null, 2)}</pre>
      <h4>Response body</h4>
      <pre>{JSON.stringify(node.output ?? { unavailable: true }, null, 2)}</pre>
    </div>
  );
}

function ExchangeCard({
  exchange,
  number,
  run,
  now,
  lastInStage,
}: {
  exchange: Exchange;
  number: number;
  run: RunTrace;
  now: number;
  lastInStage: boolean;
}) {
  const [view, setView] = useState("readable");
  const local = lastInStage ? localTarget(run, exchange.parent) : undefined;
  const operation = exchange.parent?.output?.answers?.operation?.choice;
  const selectedId =
    typeof operation === "string"
      ? exchange.parent?.output?.answers?.[`${operation.toLowerCase()}_target`]
          ?.choice
      : undefined;
  const contextMessages = exchange.messages.filter(
    (message) => message.role === "user",
  );
  const instructionMessages = exchange.messages.filter(
    (message) => message.role !== "user",
  );
  return (
    <section
      className="exchange-card"
      aria-label={`Model call ${number}: ${exchange.title}`}
    >
      <header className="exchange-header">
        <div className="exchange-number">{number}</div>
        <div className="min-w-0 flex-1">
          <h3>{exchange.title}</h3>
          <p>
            {exchange.model || "Model not recorded"} · {exchange.node.label}
          </p>
        </div>
        <div className="exchange-timing">
          <strong>{duration(elapsed(exchange.node, now))}</strong>
          <span>
            {exchange.httpStatus
              ? `HTTP ${exchange.httpStatus}`
              : exchange.node.status === "running"
                ? "In progress"
                : "No HTTP status saved"}
          </span>
        </div>
      </header>
      <Tabs value={view} onValueChange={setView} className="gap-0">
        <div className="exchange-toolbar">
          <TabsList>
            <TabsTrigger value="readable">Readable</TabsTrigger>
            <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          </TabsList>
          <p>
            {exchange.inputMissing
              ? "Request details unavailable"
              : exchange.questions.length
              ? `${exchange.questions.length} questions sent`
              : `${exchange.messages.length} messages sent`}
          </p>
        </div>
        <TabsContent value="raw" className="px-5 pb-5">
          <RawExchange node={exchange.node} />
        </TabsContent>
        <TabsContent value="readable">
          <div className="exchange-columns">
            <div className="sent-column">
              <div className="io-heading">
                <ArrowUpRight className="size-4" />
                <h4>What the model received</h4>
              </div>
              {exchange.inputMissing ? (
                <div className="exchange-warning">
                  <CircleAlert className="size-4" />
                  <p>
                    {typeof exchange.node.input?.omitted === "string"
                      ? `This request body was removed from saved history to fit the storage limit${typeof exchange.node.input.originalBytes === "number" ? ` (${Math.ceil(exchange.node.input.originalBytes / 1024)} KB)` : ""}. Its exact contents cannot be recovered from this export.`
                      : "No request body was recorded for this call."}
                    {" "}The prepared decision state in Execution trace may differ from what was sent.
                  </p>
                </div>
              ) : (
                <Tabs defaultValue="context" className="input-tabs">
                  <TabsList aria-label={`Input sections for call ${number}`}>
                    <TabsTrigger value="context">Context</TabsTrigger>
                    <TabsTrigger value="instructions">
                      Questions & instructions
                    </TabsTrigger>
                    <TabsTrigger value="settings">Parameters</TabsTrigger>
                  </TabsList>
                  <TabsContent value="context">
                    {exchange.state && (
                      <Context state={exchange.state} selectedId={selectedId} />
                    )}
                    {contextMessages.map((message, i) => (
                      <div key={i}>
                        <p className="message-role">
                          Message {exchange.messages.indexOf(message) + 1} ·{" "}
                          {message.role}
                        </p>
                        {object(decode(message.content)) ? (
                          <Context state={decode(message.content)} />
                        ) : (
                          <Fields value={message.content} />
                        )}
                      </div>
                    ))}
                    {!exchange.state && !contextMessages.length && (
                      <p className="inspector-note">
                        No separate page context is present in this request. See
                        Questions & instructions and Raw JSON for the recorded
                        input.
                      </p>
                    )}
                  </TabsContent>
                  <TabsContent value="instructions">
                    <p className="inspector-note">
                      Exact instructions and candidate descriptions from this
                      API request. Questions resolved locally or deferred are
                      not included.
                    </p>
                    <SentQuestions questions={exchange.questions} />
                    {instructionMessages.map((message, i) => (
                      <section className="context-section" key={i}>
                        <h4>
                          Message {exchange.messages.indexOf(message) + 1} ·{" "}
                          {message.role}
                        </h4>
                        <Fields value={decode(message.content)} />
                      </section>
                    ))}
                  </TabsContent>
                  <TabsContent value="settings">
                    <Fields value={exchange.parameters} />
                  </TabsContent>
                </Tabs>
              )}
            </div>
            <div className="received-column">
              <div className="io-heading">
                <ArrowDownLeft className="size-4" />
                <h4>What the model returned</h4>
              </div>
              <Result exchange={exchange} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
      {local && (
        <div className="extension-followup">
          <span>Extension decision · no model call</span>
          <p>
            Selected <strong>{local.label}</strong> (#{local.id}) because it was
            the only target available for {pretty(local.operation)}. The 100%
            value in the execution trace comes from this local selection.
          </p>
        </div>
      )}
      {lastInStage && exchange.parent?.error && (
        <div className="extension-followup followup-error">
          <span>Extension processing</span>
          <p>
            {exchange.httpStatus === 200
              ? "The API returned successfully, but the extension could not use the result. "
              : ""}
            {exchange.parent.error}
          </p>
        </div>
      )}
    </section>
  );
}

export function ModelCalls({ run, now }: { run: RunTrace; now: number }) {
  const exchanges = useMemo(
    () =>
      run.nodes
        .filter((node) => node.kind === "request")
        .map((node) => readExchange(node, run)),
    [run],
  );
  const explanation = useMemo(() => explainRun(run), [run]);
  const [selected, setSelected] = useState<string | null>(null);
  const shown = selected
    ? exchanges.filter((exchange) => exchange.node.id === selected)
    : exchanges;
  return (
    <div className="model-calls">
      {explanation.length > 0 && (
        <section className="run-explanation">
          <h3>
            <FileText className="size-4" />
            What happened
            {run.nodes.filter((n) => n.kind === "cycle").length > 1
              ? " in the final cycle"
              : ""}
          </h3>
          <ol>
            {explanation.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </section>
      )}
      <div className="calls-intro">
        <div>
          <h3>Model inputs & responses</h3>
          <p>
            Each card is one actual API attempt. Inspect the saved context and
            instructions alongside the returned answer.
          </p>
        </div>
        {exchanges.length > 1 && (
          <label>
            Show
            <select
              aria-label="Select model call"
              value={selected ?? ""}
              onChange={(event) => setSelected(event.target.value || null)}
            >
              <option value="">All {exchanges.length} calls</option>
              {exchanges.map((exchange, i) => (
                <option key={exchange.node.id} value={exchange.node.id}>
                  {i + 1}. {exchange.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!exchanges.length && (
        <p className="call-empty">
          No API attempts were recorded. Execution trace shows any local
          preparation or errors.
        </p>
      )}
      {shown.map((exchange) => (
        <ExchangeCard
          key={exchange.node.id}
          exchange={exchange}
          number={exchanges.indexOf(exchange) + 1}
          run={run}
          now={now}
          lastInStage={
            !exchanges.some(
              (next) =>
                next.parent?.id === exchange.parent?.id &&
                run.nodes.indexOf(next.node) > run.nodes.indexOf(exchange.node),
            )
          }
        />
      ))}
      <p className="inspector-note">
        This view uses saved API bodies. It does not reconstruct missing
        responses or the model’s private reasoning. The execution trace also
        contains prepared inputs, local selections, checks, and browser actions.
      </p>
      {selected && (
        <Button variant="outline" size="sm" onClick={() => setSelected(null)}>
          Show all calls
        </Button>
      )}
    </div>
  );
}
