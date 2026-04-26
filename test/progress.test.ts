/**
 * pollWithProgress + makeMcpProgressEmitter behavior.
 */
import { describe, it, expect, vi } from "vitest";
import { pollWithProgress, makeMcpProgressEmitter, isTerminalStatus } from "../src/utils/progress.js";
import { makeClient, makeFetchMock } from "./helpers.js";

describe("isTerminalStatus", () => {
  it("recognizes common terminal statuses", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("OK")).toBe(true);
    expect(isTerminalStatus("FAILED")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("pending")).toBe(false);
  });
});

describe("makeMcpProgressEmitter", () => {
  it("returns undefined when sendNotification or progressToken is missing", () => {
    expect(makeMcpProgressEmitter(undefined, undefined)).toBeUndefined();
    expect(makeMcpProgressEmitter(async () => {}, undefined)).toBeUndefined();
    expect(makeMcpProgressEmitter(undefined, "tok")).toBeUndefined();
  });

  it("emits notifications/progress with token, progress, total, message", async () => {
    const send = vi.fn(async () => {});
    const emit = makeMcpProgressEmitter(send, "tok-123")!;
    await emit({ progress: 50, total: 100, message: "halfway" });
    expect(send).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "tok-123", progress: 50, total: 100, message: "halfway" },
    });
  });

  it("swallows send errors", async () => {
    const send = vi.fn(async () => {
      throw new Error("nope");
    });
    const emit = makeMcpProgressEmitter(send, 1)!;
    // Should NOT throw.
    await emit({ progress: 1 });
  });
});

describe("pollWithProgress", () => {
  it("emits onProgress for each non-terminal poll, stops on terminal", async () => {
    const m = makeFetchMock();
    m.push({ body: { status: "running", progress: 10, total: 100 } });
    m.push({ body: { status: "running", progress: 60, total: 100 } });
    m.push({ body: { status: "done", progress: 100, total: 100, message: "all good" } });
    const client = makeClient({ fetchImpl: m.fetch });
    const updates: Array<{ progress: number; total?: number; message?: string }> = [];
    const result = await pollWithProgress(client, {
      statusPath: "/system/queue/job/abc",
      intervalMs: 5,
      timeoutMs: 5_000,
      onProgress: (u) => {
        updates.push(u);
      },
    });
    expect(result.terminal).toBe(true);
    expect(result.status).toBe("done");
    expect(result.polls).toBe(3);
    expect(updates.length).toBe(3);
    expect(updates[2]!.progress).toBe(100);
    expect(updates[2]!.message).toBe("all good");
  });

  it("times out when no terminal status arrives", async () => {
    const m = makeFetchMock();
    // Push enough non-terminal responses to last past the timeout window.
    for (let i = 0; i < 50; i++) m.push({ body: { status: "running", progress: i } });
    const client = makeClient({ fetchImpl: m.fetch });
    const result = await pollWithProgress(client, {
      statusPath: "/system/queue/job/abc",
      intervalMs: 5,
      timeoutMs: 30,
    });
    expect(result.terminal).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe("running");
  });

  it("emits initialMessage before the first poll if provided", async () => {
    const m = makeFetchMock();
    m.push({ body: { status: "done" } });
    const client = makeClient({ fetchImpl: m.fetch });
    const seen: string[] = [];
    await pollWithProgress(client, {
      statusPath: "/x",
      intervalMs: 1,
      timeoutMs: 1_000,
      initialMessage: "starting",
      onProgress: (u) => {
        if (u.message) seen.push(u.message);
      },
    });
    expect(seen[0]).toBe("starting");
  });

  it("recovers from transient poll errors and keeps trying", async () => {
    const m = makeFetchMock();
    m.pushError({ code: "ECONNRESET", message: "reset" });
    m.push({ body: { status: "done", progress: 1 } });
    const client = makeClient({ fetchImpl: m.fetch });
    const result = await pollWithProgress(client, {
      statusPath: "/x",
      intervalMs: 1,
      timeoutMs: 1_000,
    });
    expect(result.terminal).toBe(true);
    expect(result.status).toBe("done");
  });
});
