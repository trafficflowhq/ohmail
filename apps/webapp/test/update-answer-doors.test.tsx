/** @vitest-environment jsdom */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SERVER THAT SAYS "THIS APP IS TOO OLD" OR "I AM BEING UPDATED" IS HEARD AT EVERY DOOR THE WEB
 * ASKS THROUGH — the API client, the engine's transport and the renewal — and tells the one update
 * line. Driven through the real client, the real engine and the real refresh; `fetch` is the stub
 * server, which is the only thing in this tree that sends either answer. The act under way is not
 * judged: a press stays queued, and the error a surface reads carries the same sentence.
 */
process.env.NEXT_PUBLIC_API_BASE = "/api";
process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";

const ENGINE_PKG = existsSync(resolve("packages/client-engine/package.json"))
  ? resolve("packages/client-engine/package.json")
  : resolve("../../packages/client-engine/package.json");
const { IDBFactory } = createRequire(ENGINE_PKG)("fake-indexeddb") as { IDBFactory: new () => IDBFactory };

const envelope = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error: { code, message: code, retryable: true } }),
    { status, headers: { "content-type": "application/json", ...headers } });
const ok = (): Response => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

let answer: () => Response;
const asked: string[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = "tf_csrf=c; Path=/";
  asked.length = 0;
  answer = ok;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    asked.push(String(input));
    return answer();
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const line = async () => (await import("@ohmail/app-logic/doors/app-update")).currentUpdateOffer();

describe("the API client", () => {
  it("426 client_too_old: the line says so with Reload, and the error carries the same sentence", async () => {
    const { api, ApiError } = await import("../app/api-client.js");
    answer = () => envelope(426, "client_too_old");
    const err = await api("/mailboxes").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(426);
    expect((err as Error).message).toBe("This ohmail is too old for its server.");
    expect(await line()).toMatchObject({ kind: "tooOld", verb: "reload" });
  });

  it("503 server_updating: the line says so with no verb, and the next 2xx lifts it", async () => {
    const { api } = await import("../app/api-client.js");
    answer = () => envelope(503, "server_updating", { "retry-after": "30" });
    const err = await api("/mailboxes").catch((e: unknown) => e);
    expect((err as Error).message).toBe("ohmail is being updated and will be back shortly.");
    expect(await line()).toMatchObject({ kind: "serverUpdating" });
    expect((await line())?.act).toBeUndefined();
    answer = ok;
    await api("/mailboxes");
    expect(await line()).toBeNull();
  });

  it("an edge's 503 and a 503 db_busy stay the general failure they were", async () => {
    const { api } = await import("../app/api-client.js");
    answer = () => new Response("Service Unavailable", { status: 503 });
    await api("/mailboxes").catch(() => undefined);
    answer = () => envelope(503, "db_busy", { "retry-after": "5" });
    await api("/mailboxes").catch(() => undefined);
    expect(await line()).toBeNull();
  });
});

describe("the engine's transport", () => {
  it("a press answered 426 stays queued, and the line says the app is too old", async () => {
    const { createEngine } = await import("../app/shell/engine-config.js");
    const { OUTBOX_TYPE } = await import("@ohmail/client-engine");
    answer = () => envelope(426, "client_too_old");
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" }, null);
    await engine.start().catch(() => undefined);
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["m1"], unread: false });
    expect(res.status, "the act was refused or dropped").toBe("queued");
    expect(engine.pendingMutations()).toHaveLength(1);
    expect(OUTBOX_TYPE).toBeTruthy();
    expect(await line()).toMatchObject({ kind: "tooOld" });
  });
});

describe("the renewal door", () => {
  it("426 at /auth/refresh is heard, and is not the end of the session", async () => {
    const { resumeSession } = await import("../app/session-refresh.js");
    answer = () => envelope(426, "client_too_old");
    const verdict = await resumeSession({});
    expect(verdict).not.toBe("refused");
    expect(await line()).toMatchObject({ kind: "tooOld" });
  });
});
