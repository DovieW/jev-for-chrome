import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundRun,
  HISTORY_KEY,
  MAX_RUN_BYTES,
  RunHistoryStore,
  RunRecorder,
  sanitizeTrace,
} from "../src/background/run-history";
import { stageTimes } from "../src/history/format";
import { callOpenAI } from "../src/shared/providers/openai";
import { postJson } from "../src/shared/providers/http";
import type { RunTrace } from "../src/shared/trace";
import type { JevRequest } from "../src/shared/types";

function storage() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (next: Record<string, unknown>) => {
      data = structuredClone(next);
    }),
  };
}
function recorder(store: RunHistoryStore, goal = "Find blue widgets") {
  return new RunRecorder(
    store,
    {
      goal,
      provider: "openai",
      model: "gpt-6-luna",
      helperModel: "gpt-6-luna",
      maxSteps: 30,
    },
    ["private-test-key"],
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("persistent run history", () => {
  it("keeps five most recent tasks, updates one task in place, and survives a new store", async () => {
    vi.useFakeTimers();
    const disk = storage();
    const store = new RunHistoryStore(disk, () => {});
    const records: RunRecorder[] = [];
    for (let i = 0; i < 7; i++) {
      vi.setSystemTime(1000 + i * 100);
      const record = recorder(store, `Task ${i}`);
      records.push(record);
      record.finish("done", i);
      await record.flush();
    }
    expect((await store.list()).map((run) => run.goal)).toEqual([
      "Task 6",
      "Task 5",
      "Task 4",
      "Task 3",
      "Task 2",
    ]);
    await records[5].flush();
    expect((await store.list()).map((run) => run.goal)).toEqual([
      "Task 6",
      "Task 5",
      "Task 4",
      "Task 3",
      "Task 2",
    ]);
    const restored = await new RunHistoryStore(disk, () => {}).list();
    expect(restored).toHaveLength(5);
    expect(restored[0].status).toBe("done");
  });

  it("marks an unfinished saved run interrupted after a worker restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const disk = storage();
    const record = recorder(new RunHistoryStore(disk, () => {}));
    record
      .span("cycle", "Decision cycle 1")
      .child("decision", "Waiting on model");
    vi.setSystemTime(2000);
    record.update("running", 0);
    await record.flush();
    const [restored] = await new RunHistoryStore(disk, () => {}).list();
    expect(restored.status).toBe("interrupted");
    expect(restored.endedAt).toBe(2000);
    expect(
      restored.nodes.every(
        (node) => node.status === "cancelled" && node.durationMs === 1000,
      ),
    ).toBe(true);
  });

  it("does not resurrect a deleted active run when pending or late writes arrive", async () => {
    const disk = storage();
    const store = new RunHistoryStore(disk, () => {});
    const record = recorder(store);
    const span = record.span("decision", "Pending request");
    await record.flush();
    await store.delete(record.run.id);
    span.end({ choice: "DONE" });
    record.finish("done", 0);
    await record.flush();
    expect(await store.list()).toEqual([]);
    const next = recorder(store, "New task");
    next.finish("done", 0);
    await next.flush();
    expect((await store.list()).map((run) => run.goal)).toEqual(["New task"]);
    expect(Object.keys(await disk.get())).toEqual([HISTORY_KEY]);
  });

  it("freezes a stopped trace and ignores late spans and results", async () => {
    const store = new RunHistoryStore(storage(), () => {});
    const record = recorder(store);
    const pending = record.span("decision", "Pending model");
    record.finish("stopped", 0);
    const before = structuredClone(record.run);
    pending.end({ choice: "CLICK" });
    pending.child("request", "Late target").end({ response: "late" });
    expect(record.run).toEqual(before);
    await record.flush();
    expect((await store.list())[0].nodes[0].status).toBe("cancelled");
  });

  it("clears a newly started run before its first timed checkpoint", async () => {
    const store = new RunHistoryStore(storage(), () => {});
    const record = recorder(store);
    await store.delete();
    record.span("cycle", "Late cycle").end();
    record.finish("done", 0);
    await record.flush();
    expect(await store.list()).toEqual([]);
  });

  it("redacts a key changed between manual steps", async () => {
    const store = new RunHistoryStore(storage(), () => {});
    const record = recorder(store);
    record.addSecrets(["new-provider-key"]);
    record
      .span("decision", "Choose")
      .fail(new Error("Echoed new-provider-key"));
    record.finish("error", 0);
    await record.flush();
    expect(JSON.stringify(await store.list())).not.toContain(
      "new-provider-key",
    );
  });

  it("records stage errors, elapsed time and retry delays without double counting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = new RunHistoryStore(storage(), () => {});
    const record = recorder(store);
    const cycle = record.span("cycle", "Decision cycle 1");
    const decision = cycle.child("decision", "Choose action");
    const first = decision.child("request", "Attempt 1");
    vi.setSystemTime(1100);
    first.fail(new Error("HTTP 429"));
    const delay = decision.child("wait", "Backoff");
    vi.setSystemTime(1900);
    delay.end();
    const second = decision.child("request", "Attempt 2");
    vi.setSystemTime(2100);
    second.end({ choice: "DONE" });
    decision.end();
    cycle.end();
    record.finish("done", 0);
    await record.flush();
    expect(stageTimes(record.run)).toEqual([300, 0, 0, 800]);
    expect(record.run.nodes[2]).toMatchObject({
      status: "error",
      durationMs: 100,
      error: "HTTP 429",
    });
  });

  it("redacts known keys from labels, errors, JSON strings and bodies, and excludes reasoning", async () => {
    const store = new RunHistoryStore(storage(), () => {});
    const record = recorder(store, "Inspect private-test-key");
    const node = record.span("helper", "private-test-key", {
      messages: [{ content: "private-test-key" }],
      authorization: "Bearer private-test-key",
      reasoning_content: "private reasoning",
    });
    node.fail(new Error("Server echoed private-test-key"));
    record.finish("error", 0, "private-test-key");
    await record.flush();
    const saved = JSON.stringify(await store.list());
    expect(saved).not.toContain("private-test-key");
    expect(saved).not.toContain("private reasoning");
    expect(
      sanitizeTrace("https://user:pass@example.com/?token=secret&query=hello"),
    ).toBe("https://[redacted]@example.com/?token=[redacted]&query=hello");
  });

  it("bounds UTF-8 payload size while keeping each event and marking omissions", () => {
    const run: RunTrace = {
      version: 1,
      id: "test",
      goal: "test",
      provider: "openai",
      model: "test",
      helperModel: "test",
      maxSteps: 30,
      status: "done",
      steps: 30,
      startedAt: 0,
      updatedAt: 1000,
      nodes: Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        kind: "decision",
        label: `Decision ${i}`,
        startedAt: i,
        durationMs: 5,
        status: "ok",
        input: { page: "漢".repeat(10000) },
        output: { choice: "CLICK" },
      })),
    };
    const bounded = boundRun(run);
    expect(
      new TextEncoder().encode(JSON.stringify(bounded)).length,
    ).toBeLessThanOrEqual(MAX_RUN_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.nodes).toHaveLength(100);
    expect(
      bounded.nodes.every(
        (node) => node.output?.choice === "CLICK" && node.durationMs === 5,
      ),
    ).toBe(true);
    expect(run.nodes[0].input?.page).toHaveLength(10000);
    const verbose = {
      ...run,
      nodes: Array.from({ length: 2400 }, (_, i) => ({
        ...run.nodes[0],
        id: String(i),
        label: "漢".repeat(300),
        error: "漢".repeat(2000),
      })),
    };
    expect(
      new TextEncoder().encode(JSON.stringify(boundRun(verbose))).length,
    ).toBeLessThanOrEqual(MAX_RUN_BYTES);
  });

  it("reports persistence errors without failing the recorder or overwriting settings", async () => {
    const disk = storage();
    const store = new RunHistoryStore(disk, () => {});
    disk.set.mockRejectedValue(new Error("Quota exceeded"));
    const record = recorder(store);
    record.finish("done", 0);
    await expect(record.flush()).resolves.toBeUndefined();
    expect(store.error).toContain("Quota exceeded");
    expect(
      disk.set.mock.calls.every(
        ([write]) => Object.keys(write).join() === HISTORY_KEY,
      ),
    ).toBe(true);
  });
});

describe("request instrumentation", () => {
  it("captures both dependent OpenAI calls with the actual questions and returned probabilities", async () => {
    const request: JevRequest = {
      model: "gpt-6-luna",
      state: {
        task: "Search",
        page: { url: "https://example.com", title: "Search", text: "Search" },
        elements: [],
        recent_actions: [],
      },
      questions: {
        operation: {
          type: "choice",
          instructions: "Choose",
          criteria: { CLICK: "Click", DONE: "Done" },
        },
        click_target: {
          type: "choice",
          instructions: "Choose target",
          criteria: { "1": "Search", "2": "Cancel" },
        },
      },
    };
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const name = body.questions[0].name;
      const choice = name === "operation" ? "CLICK" : "1";
      return new Response(
        JSON.stringify({
          model: "gpt-6-luna",
          answers: [
            {
              name,
              type: "choice",
              choice,
              confidence: 0.8,
              probabilities: body.questions[0].choices.map((c: any) => ({
                value: c.value,
                probability: c.value === choice ? 0.8 : 0.2,
              })),
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const store = new RunHistoryStore(storage(), () => {});
    const record = recorder(store);
    const decision = record.span("decision", "Choose", request);
    const result = await callOpenAI(
      {
        apiKey: "private-test-key",
        model: "gpt-6-luna",
        endpoint: "https://example.com/decisions",
      },
      request,
      decision,
    );
    decision.end(result);
    record.finish("done", 1);
    await record.flush();
    const requests = record.run.nodes.filter((node) => node.kind === "request");
    expect(requests.map((node) => node.input.questions[0].name)).toEqual([
      "operation",
      "click_target",
    ]);
    expect(requests[1].output.response.answers[0].probabilities[0]).toEqual({
      value: "1",
      probability: 0.8,
    });
    expect(JSON.stringify(await store.list())).not.toContain(
      "private-test-key",
    );
  });

  it("captures network retry time and failed attempts without storing authorization headers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"error":{"message":"Rate limited"}}', { status: 429 }),
        )
        .mockResolvedValueOnce(new Response('{"answers":{}}')),
    );
    const record = recorder(new RunHistoryStore(storage(), () => {}));
    const span = record.span("decision", "Choose");
    const promise = postJson(
      "https://example.com",
      { Authorization: "Bearer private-test-key" },
      { model: "test" },
      { trace: span },
    );
    await vi.advanceTimersByTimeAsync(850);
    await promise;
    span.end();
    record.finish("done", 0);
    await record.flush();
    expect(
      record.run.nodes
        .filter((node) => node.kind === "request")
        .map((node) => node.status),
    ).toEqual(["error", "ok"]);
    expect(
      record.run.nodes.find((node) => node.kind === "wait")?.durationMs,
    ).toBe(800);
    expect(JSON.stringify(record.run)).not.toContain("Authorization");
    expect(
      record.run.nodes.find((node) => node.kind === "request")?.output,
    ).toEqual({
      httpStatus: 429,
      response: { error: { message: "Rate limited" } },
      responseBodyTruncated: false,
      retrying: true,
    });
  });

  it("retains structured HTTP error responses and redacts echoed credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "Invalid key private-test-key",
              code: "invalid_api_key",
            },
          }),
          { status: 401 },
        ),
      ),
    );
    const store = new RunHistoryStore(storage(), () => {});
    const record = recorder(store);
    const span = record.span("helper", "Generate text");
    await expect(
      postJson("https://example.com", {}, {}, { trace: span }),
    ).rejects.toThrow("HTTP 401");
    span.fail(new Error("Text helper failed"));
    record.finish("error", 0);
    await record.flush();
    const request = (await store.list())[0].nodes.find(
      (node) => node.kind === "request",
    );
    expect(request).toMatchObject({
      status: "error",
      output: {
        httpStatus: 401,
        response: { error: { code: "invalid_api_key" } },
        responseBodyTruncated: false,
        retrying: false,
      },
    });
    expect(request?.output.response.error.message).toContain("[redacted]");
    expect(JSON.stringify(request)).not.toContain("private-test-key");
  });

  it("bounds oversized text error bodies and explicitly records truncation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("x".repeat(10000), { status: 400 })),
    );
    const record = recorder(new RunHistoryStore(storage(), () => {}));
    const span = record.span("decision", "Choose");
    await expect(
      postJson("https://example.com", {}, {}, { trace: span }),
    ).rejects.toThrow("HTTP 400");
    const request = record.run.nodes.find((node) => node.kind === "request");
    expect(request?.output.response).toHaveLength(8000);
    expect(request?.output.responseBodyTruncated).toBe(true);
    expect(request?.output.retrying).toBe(false);
  });

  it("keeps unreadable bodies missing while preserving the HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => {
            throw new Error("Read failed");
          },
        })
        .mockResolvedValueOnce(new Response("Not JSON")),
    );
    const record = recorder(new RunHistoryStore(storage(), () => {}));
    const span = record.span("decision", "Choose");
    await expect(
      postJson("https://example.com", {}, {}, { trace: span }),
    ).rejects.toThrow("HTTP 400");
    await expect(
      postJson("https://example.com", {}, {}, { trace: span }),
    ).rejects.toThrow();
    const requests = record.run.nodes.filter((node) => node.kind === "request");
    expect(requests.map((node) => node.output.httpStatus)).toEqual([400, 200]);
    expect(requests.every((node) => node.output.response === undefined)).toBe(
      true,
    );
  });
});
