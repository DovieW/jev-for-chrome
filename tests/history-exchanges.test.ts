import { describe, expect, it } from "vitest";
import fixture from "./fixtures/diagnostic-run.json";
import type { RunTrace, TraceNode } from "../src/shared/trace";
import {
  explainRun,
  localTarget,
  parseRunExport,
  readExchange,
} from "../src/history/exchanges";

const run = fixture as RunTrace;
const request = (input: unknown, response?: unknown): TraceNode => ({
  id: "wire",
  kind: "request",
  label: "API",
  status: "ok",
  startedAt: 0,
  durationMs: 10,
  input,
  output: response === undefined ? undefined : { httpStatus: 200, response },
});

describe("readable model exchanges", () => {
  it("uses the wire questions, not unused or locally resolved prepared questions", () => {
    const exchange = readExchange(run.nodes[5], run);
    expect(exchange.questions.map((q) => q.name)).toEqual([
      "operation",
      "goal_done",
      "stuck",
    ]);
    expect(exchange.questions.some((q) => q.name === "type_text_target")).toBe(
      false,
    );
    expect(exchange.state?.elements).toHaveLength(58);
    expect(exchange.state?.browser.open_tabs).toHaveLength(27);
    expect(exchange.questions[0].instructions).toMatchObject({
      goal: "Ask for a joke.",
      rules: expect.stringContaining("untrusted"),
    });
    expect(exchange.answers[0]).toMatchObject({
      confidence: 0.44,
      probabilities: { TYPE_TEXT: 0.52, BLOCKED: 0.3 },
    });
    expect(exchange.usage).toEqual({ input: 4602, output: 0, cached: 0 });
  });

  it("shows exact helper messages and separates HTTP success from unusable null output", () => {
    const exchange = readExchange(run.nodes[7], run);
    expect(exchange.messages).toHaveLength(2);
    expect(exchange.messages[0].content).toContain(
      "If a required value is missing",
    );
    expect(exchange.replies).toEqual([
      { raw: '{"text":null}', value: { text: null }, finishReason: "stop" },
    ]);
    expect(exchange.httpStatus).toBe(200);
    expect(exchange.parent?.status).toBe("error");
    expect(exchange.usage).toMatchObject({ input: 539, output: 11 });
  });

  it("explains local target selection without calling its 100% value model confidence", () => {
    expect(localTarget(run, run.nodes[3])).toEqual({
      name: "type_text_target",
      id: "41",
      label: "Search files",
      operation: "TYPE_TEXT",
    });
    const story = explainRun(run).join(" ");
    expect(story).toContain("44% confidence");
    expect(story).toContain("only target");
    expect(story).toContain("model was not asked");
    expect(story).toContain('{"text":null}');
    expect(story).toContain("before any browser action");
    expect(story).not.toContain("100% confidence");
  });

  it("uses each retry’s compressed state instead of the full prepared context", () => {
    const exchange = readExchange(
      request(
        {
          state: {
            task: "Test",
            page: { text: "Shortened text" },
            observation_notice: "Truncated by provider adapter",
          },
          questions: {
            operation: {
              type: "choice",
              criteria: { DONE: "Done", WAIT: "Wait" },
              instructions: ["First rule", "Second rule"],
            },
          },
        },
        {
          answers: {
            operation: {
              choice: "WAIT",
              confidence: 0.5,
              probabilities: { WAIT: 0.6, DONE: 0.4 },
            },
          },
        },
      ),
      run,
    );
    expect(exchange.state?.page.text).toBe("Shortened text");
    expect(exchange.questions[0].choices).toHaveLength(2);
    expect(exchange.answers[0].choice).toBe("WAIT");
  });

  it("normalizes Cloudflare input and result wrappers including bare answer maps", () => {
    const exchange = readExchange(
      request(
        {
          input: {
            state: { task: "Test" },
            questions: { goal_done: { type: "noul", instructions: "Done?" } },
          },
        },
        { result: { goal_done: { type: "noul", noul: 0.25 } } },
      ),
      run,
    );
    expect(exchange.state?.task).toBe("Test");
    expect(exchange.answers[0]).toMatchObject({
      name: "goal_done",
      probability: 0.25,
    });
  });

  it("keeps refusals and missing bodies explicit instead of inventing a result from the parent", () => {
    const refusal = readExchange(
      request(
        { questions: [{ name: "operation", type: "choice", choices: [] }] },
        { answers: [{ name: "operation", type: "refusal" }] },
      ),
      run,
    );
    expect(refusal.answers[0].type).toBe("refusal");
    const missing = readExchange(
      { ...request({ omitted: "Size limit" }), parentId: "4" },
      run,
    );
    expect(missing.inputMissing).toBe(true);
    expect(missing.responseMissing).toBe(true);
    expect(missing.state).toBeUndefined();
    expect(missing.answers).toEqual([]);
  });

  it("reads old exports without changing their data and rejects cyclic or oversized graphs", () => {
    expect(parseRunExport(JSON.stringify(run))).toEqual(run);
    expect(() =>
      parseRunExport(
        JSON.stringify({ ...run, nodes: [{ ...run.nodes[0], parentId: "1" }] }),
      ),
    ).toThrow(/event records/);
    expect(() =>
      parseRunExport(
        JSON.stringify({ ...run, nodes: Array(2401).fill(run.nodes[0]) }),
      ),
    ).toThrow(/supported/);
    expect(() => parseRunExport('{"version":2}')).toThrow(/supported/);
  });
});
