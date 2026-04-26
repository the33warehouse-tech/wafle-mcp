/**
 * Helpers for long-running tools that need to emit `notifications/progress`
 * back to the MCP client.
 *
 * MCP spec: notifications/progress params are
 *   { progressToken, progress, total?, message? }
 * `progressToken` is the same token the client sent in the request `_meta`.
 *
 * `pollWithProgress` is the canonical loop for wafle background jobs:
 *   1. Poll the wafle status endpoint every `intervalMs` (default 2s).
 *   2. Forward each update via `onProgress`.
 *   3. Stop on terminal status (`done|completed|ok|failed|error|cancelled`)
 *      or when `timeoutMs` elapses.
 *
 * The helper is transport-agnostic — it doesn't know about MCP. The caller
 * passes a callback that emits the progress notification.
 */
import type { WafleClient } from "../client/wafle-client.js";

export interface ProgressUpdate {
  /** Monotonic counter (e.g. items processed). */
  progress: number;
  /** Total expected items (if known). */
  total?: number;
  /** Optional human-readable message ("syncing batch 4/10"). */
  message?: string;
}

export interface JobStatus {
  status: string;
  progress?: number;
  total?: number;
  message?: string;
  /** Whatever the wafle endpoint returned — surfaced verbatim on terminal status. */
  raw: unknown;
}

const TERMINAL_STATUS = new Set([
  "done",
  "completed",
  "complete",
  "ok",
  "success",
  "succeeded",
  "failed",
  "failure",
  "error",
  "errored",
  "cancelled",
  "canceled",
]);

interface RawJobShape {
  status?: string;
  state?: string;
  progress?: number;
  total?: number;
  processed?: number;
  pending?: number;
  message?: string;
  error?: string;
}

function normalize(raw: unknown): JobStatus {
  if (!raw || typeof raw !== "object") {
    return { status: "unknown", raw };
  }
  const j = raw as RawJobShape;
  const status = (j.status ?? j.state ?? "unknown").toString().toLowerCase();
  const progress = j.progress ?? j.processed ?? 0;
  const out: JobStatus = { status, raw };
  if (typeof progress === "number") out.progress = progress;
  if (typeof j.total === "number") out.total = j.total;
  if (typeof j.message === "string") out.message = j.message;
  else if (typeof j.error === "string" && (status === "failed" || status === "error")) out.message = j.error;
  return out;
}

/** Is this a terminal status — should we stop polling? */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUS.has(status.toLowerCase());
}

export interface PollWithProgressOptions {
  /** Status endpoint relative to wafle base URL, e.g. `/system/queue/job/abc`. */
  statusPath: string;
  /** Optional override of the polling interval. Default 2000ms. */
  intervalMs?: number;
  /** Hard timeout. Default 5 minutes. */
  timeoutMs?: number;
  /** Called once per poll while the job is in progress. */
  onProgress?: (update: ProgressUpdate) => Promise<void> | void;
  /** Optional initial progress emitted before the first poll. */
  initialMessage?: string;
}

export interface PollResult {
  /** Did we observe a terminal status? */
  terminal: boolean;
  /** Last observed status. */
  status: string;
  /** Final raw job body (for terminal cases) or the last poll body (for timeouts). */
  raw: unknown;
  /** Number of polls performed. */
  polls: number;
  /** True if we stopped because of `timeoutMs`. */
  timedOut: boolean;
}

/**
 * Poll a wafle job-status endpoint, forwarding every update via `onProgress`.
 * Returns when the job hits a terminal status or we time out.
 */
export async function pollWithProgress(
  client: WafleClient,
  opts: PollWithProgressOptions,
): Promise<PollResult> {
  const interval = opts.intervalMs ?? 2_000;
  const timeout = opts.timeoutMs ?? 5 * 60 * 1_000;
  const start = Date.now();
  let polls = 0;
  let lastRaw: unknown = null;
  let lastStatus = "pending";

  if (opts.initialMessage && opts.onProgress) {
    await opts.onProgress({ progress: 0, message: opts.initialMessage });
  }

  while (Date.now() - start < timeout) {
    polls++;
    let normalized: JobStatus;
    try {
      const raw = await client.get<unknown>(opts.statusPath);
      lastRaw = raw;
      normalized = normalize(raw);
    } catch (err) {
      // Transient errors during polling → keep going; log via onProgress message.
      const e = err as { message?: string };
      if (opts.onProgress) {
        await opts.onProgress({ progress: 0, message: `poll error: ${e?.message ?? "unknown"}` });
      }
      await sleep(interval);
      continue;
    }
    lastStatus = normalized.status;
    if (opts.onProgress) {
      const update: ProgressUpdate = { progress: normalized.progress ?? 0 };
      if (typeof normalized.total === "number") update.total = normalized.total;
      if (normalized.message) update.message = normalized.message;
      await opts.onProgress(update);
    }
    if (isTerminalStatus(normalized.status)) {
      return { terminal: true, status: normalized.status, raw: lastRaw, polls, timedOut: false };
    }
    await sleep(interval);
  }
  return { terminal: false, status: lastStatus, raw: lastRaw, polls, timedOut: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build an `onProgress` callback that forwards updates to the MCP client
 * via the runtime `sendNotification`. No-op if `progressToken` is missing
 * (client did not request progress).
 */
export function makeMcpProgressEmitter(
  sendNotification: ((notification: unknown) => Promise<void>) | undefined,
  progressToken: string | number | undefined,
): ((update: ProgressUpdate) => Promise<void>) | undefined {
  if (!sendNotification || progressToken === undefined) return undefined;
  return async (update: ProgressUpdate) => {
    const params: Record<string, unknown> = {
      progressToken,
      progress: update.progress,
    };
    if (update.total !== undefined) params["total"] = update.total;
    if (update.message !== undefined) params["message"] = update.message;
    try {
      await sendNotification({ method: "notifications/progress", params });
    } catch {
      // Swallow notification errors — they should never break the tool call.
    }
  };
}
