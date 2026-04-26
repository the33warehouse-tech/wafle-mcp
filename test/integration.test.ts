/**
 * End-to-end-ish test: build the full MCP server (with mocked client) and
 * exercise resources + prompts + tools list as a client would.
 */
import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { makeClient, makeFetchMock, silentLogger } from "./helpers.js";
import { expandGranted, ALL_SCOPES } from "../src/auth/scopes.js";

function setup() {
  const m = makeFetchMock();
  const client = makeClient({ fetchImpl: m.fetch });
  const built = buildServer({
    client,
    logger: silentLogger() as never,
    grantedScopes: expandGranted(ALL_SCOPES),
  });
  return { ...built, m };
}

describe("end-to-end build", () => {
  it("registers tools, resources, prompts and exposes registries", () => {
    const { registry, resources, prompts } = setup();
    expect(registry.size()).toBeGreaterThanOrEqual(64);
    expect(resources.size()).toBeGreaterThanOrEqual(14);
    expect(prompts.size()).toBe(5);
  });

  it("every tool name has wafle_ prefix (no regression)", () => {
    const { registry } = setup();
    for (const t of registry.list()) expect(t.name.startsWith("wafle_")).toBe(true);
  });

  it("resource list contains both static and templated URIs", () => {
    const { resources } = setup();
    const list = resources.list();
    expect(list.some((r) => !r.isTemplate)).toBe(true);
    expect(list.some((r) => r.isTemplate)).toBe(true);
  });

  it("wafle_resources_invalidate flushes the cache", async () => {
    const { resources, registry, m } = setup();
    // Prime cache with one read.
    m.push({ body: { ok: true } }); // for /health (system/health resource)
    await resources.read("wafle://system/health");
    expect(resources.cacheStats().size).toBe(1);
    // Invalidate via the tool.
    const res = await registry.get("wafle_resources_invalidate")!.run({});
    expect(res.isError).toBe(false);
    expect(resources.cacheStats().size).toBe(0);
    expect((res.structuredContent as { removed: number }).removed).toBe(1);
  });

  it("wafle_prompts_list returns all 5 prompts", async () => {
    const { registry } = setup();
    const res = await registry.get("wafle_prompts_list")!.run({});
    expect(res.isError).toBe(false);
    const sc = res.structuredContent as { count: number; prompts: { name: string }[] };
    expect(sc.count).toBe(5);
    expect(sc.prompts.map((p) => p.name).sort()).toEqual([
      "conectar_meta_y_sync",
      "debug_orden_fallida",
      "onboarding_tienda_nueva",
      "pedido_enviar",
      "segmentar_y_campania",
    ]);
  });

  it("wafle_products_sync_trigger_and_wait emits progress and returns terminal status", async () => {
    const { registry, m } = setup();
    // 1. POST /stores/x/products/sync → returns job id
    m.push({ body: { job_id: "job-abc" } });
    // 2. GET /system/queue/job/job-abc (running)
    m.push({ body: { status: "running", progress: 50, total: 100 } });
    // 3. GET /system/queue/job/job-abc (done)
    m.push({ body: { status: "done", progress: 100, total: 100 } });

    const updates: unknown[] = [];
    const sendNotification = async (n: unknown): Promise<void> => {
      updates.push(n);
    };
    const res = await registry.get("wafle_products_sync_trigger_and_wait")!.run(
      { slug: "gamerland", mode: "incremental", timeout_seconds: 30 },
      { sendNotification, progressToken: "tok-1" },
    );
    expect(res.isError).toBe(false);
    const sc = res.structuredContent as { ok: boolean; job_id: string; status: string };
    expect(sc.job_id).toBe("job-abc");
    expect(sc.status).toBe("done");
    expect(sc.ok).toBe(true);
    // Should have emitted at least one progress notification.
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0]).toMatchObject({ method: "notifications/progress" });
  });

  it("wafle_resources_invalidate respects scope (master-only)", async () => {
    // Build with a non-master granted scope set.
    const m = makeFetchMock();
    const client = makeClient({ fetchImpl: m.fetch });
    const built = buildServer({
      client,
      logger: silentLogger() as never,
      grantedScopes: expandGranted(["orders:read"]),
    });
    const res = await built.registry.get("wafle_resources_invalidate")!.run({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Scope denied/);
  });
});
