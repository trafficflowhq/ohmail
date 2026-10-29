/** @vitest-environment jsdom */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The engine's own devDependency, reached through its package: the webapp does not carry one. */
const ENGINE_PKG = existsSync(resolve("packages/client-engine/package.json"))
  ? resolve("packages/client-engine/package.json")
  : resolve("../../packages/client-engine/package.json");
const { IDBFactory, IDBDatabase } = createRequire(ENGINE_PKG)("fake-indexeddb") as {
  IDBFactory: new () => IDBFactory;
  IDBDatabase: { prototype: IDBDatabase };
};

/**
 * A RENEWAL NAMES ITS ATTEMPT, AND A RETRY OF AN ANSWER THAT NEVER LANDED REUSES THE NAME. The server
 * re-admits a spent refresh token presented with the attempt that spent it; under a new name past the
 * 60 s grace it sweeps the family. So the name is written to the jar before the request goes, resumed by
 * this page, a reload or another tab while the jar has not moved on, and settled by a definitive answer.
 * Tabs are two module instances over one jsdom jar, one fetch and one FIFO lock.
 */

type Refresh = typeof import("../app/session-refresh");

const MIN = 60_000;
/** A CSRF value no random id or hex digest can contain, so "not stored" is a real reading. */
const MARKED_CSRF = "csrf-value-never-stored";
let answers: Array<() => Response> = [];
let sent: Array<{ attemptId: unknown; contentType: string | null }> = [];

const minted = (csrf: string) => (): Response => {
  document.cookie = `tf_csrf=${csrf}; Path=/`;
  return new Response(null, { status: 204 });
};
const lost = (): Response => { throw new TypeError("Failed to fetch"); };
const revoked = (): Response => new Response(
  JSON.stringify({ error: { code: "refresh_revoked", message: "invalid refresh token" } }),
  { status: 401, headers: { "content-type": "application/json" } },
);

async function openTab(): Promise<Refresh> {
  vi.resetModules();
  return import("../app/session-refresh");
}
const lastName = (): unknown => sent.at(-1)?.attemptId;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-02T21:00:00.000Z"));
  answers = [];
  sent = [];
  window.localStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=c0; Path=/";
  let chain: Promise<unknown> = Promise.resolve();
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: {
      request: (_n: string, _o: unknown, cb: () => Promise<unknown>) => {
        const run = chain.then(() => cb());
        chain = run.then(() => undefined, () => undefined);
        return run;
      },
    },
  });
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/auth/refresh")) {
      const headers = new Headers(init?.headers as HeadersInit);
      sent.push({ attemptId: JSON.parse(String(init?.body ?? "{}")).attemptId, contentType: headers.get("content-type") });
      const next = answers.shift();
      if (!next) throw new Error("no answer queued for this refresh");
      return next();
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a renewal names its attempt", () => {
  it("every refresh carries a name in a JSON body, and the name is not the CSRF value", async () => {
    document.cookie = `tf_csrf=${MARKED_CSRF}; Path=/`;
    const tab = await openTab();
    answers = [minted("c1")];
    expect(await tab.resumeSession()).toBe("resumed");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.contentType).toBe("application/json");
    expect(typeof lastName()).toBe("string");
    expect(String(lastName()).length).toBeLessThanOrEqual(128);
    expect(String(lastName())).not.toContain(MARKED_CSRF);
  });

  it("an answer that never landed keeps the name: this page, a reload and another tab retry as the SAME attempt", async () => {
    document.cookie = `tf_csrf=${MARKED_CSRF}; Path=/`;
    const tab = await openTab();
    answers = [lost, lost, lost];
    expect(await tab.resumeSession()).toBe("unavailable");
    const first = lastName();
    expect(await tab.resumeSession()).toBe("unavailable");
    expect(lastName(), "this page's retry").toBe(first);
    const other = await openTab();
    expect(await other.resumeSession()).toBe("unavailable");
    expect(lastName(), "a reload or another tab").toBe(first);
    expect(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY) ?? "", "the stored name holds no CSRF value").not.toContain(MARKED_CSRF);
  });

  it("a 204 keeps the name owed for the jar it left; the next renewal, on the jar the answer set, is a new attempt", async () => {
    const tab = await openTab();
    answers = [lost, minted("c1"), minted("c2")];
    await tab.resumeSession();
    const first = lastName();
    expect(await tab.resumeSession()).toBe("resumed");
    expect(lastName(), "the retry that landed").toBe(first);
    expect(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY), "a crash before the cookies are saved needs it").toContain(String(first));
    await tab.resumeSession();
    expect(lastName(), "a new renewal is a new attempt").not.toBe(first);
  });

  it("a coded refusal settles it too", async () => {
    const tab = await openTab();
    answers = [lost, revoked];
    await tab.resumeSession();
    expect(await tab.resumeSession()).toBe("refused");
    expect(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY)).toBeNull();
  });

  it("a jar that moved on (a new tf_csrf landed) never resumes an old name", async () => {
    const tab = await openTab();
    answers = [lost, minted("c2")];
    await tab.resumeSession();
    const first = lastName();
    document.cookie = "tf_csrf=c1; Path=/";
    await tab.resumeSession();
    expect(lastName()).not.toBe(first);
  });

  it("a tf_csrf that merely LAPSED (no answer landed) still resumes the name", async () => {
    const tab = await openTab();
    answers = [lost, minted("c1")];
    await tab.resumeSession();
    const first = lastName();
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
    vi.setSystemTime(new Date(Date.now() + 5 * MIN));
    await tab.resumeSession();
    expect(lastName()).toBe(first);
  });

  it("past one access window the name is not resumed", async () => {
    const tab = await openTab();
    answers = [lost, minted("c1")];
    await tab.resumeSession();
    const first = lastName();
    vi.setSystemTime(new Date(Date.now() + 15 * MIN));
    await tab.resumeSession();
    expect(lastName()).not.toBe(first);
  });

  it("a name stamped in the FUTURE is discarded, never resumed", async () => {
    const tab = await openTab();
    answers = [lost, minted("c1")];
    await tab.resumeSession();
    const first = lastName();
    const owed = JSON.parse(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY)!) as { at: number };
    window.localStorage.setItem(tab.SESSION_ATTEMPT_KEY, JSON.stringify({ ...owed, at: Date.now() + 10 * MIN }));
    const other = await openTab();
    await other.resumeSession();
    expect(lastName()).not.toBe(first);
  });

  it("a jar that refuses storage keeps this page's own name for the retry", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("refused", "QuotaExceededError"); });
    const tab = await openTab();
    answers = [lost, lost];
    await tab.resumeSession();
    const first = lastName();
    await tab.resumeSession();
    expect(lastName()).toBe(first);
  });
});

/** The name IndexedDB holds now, read as a restarted page would. */
async function durableName(): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((ok, no) => {
    const req = indexedDB.open("ohmail-session", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("attempt"); };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
  try {
    return await new Promise((ok, no) => {
      const get = db.transaction("attempt", "readonly").objectStore("attempt").get("owed");
      get.onsuccess = () => ok((get.result as { id?: unknown } | undefined)?.id ?? null);
      get.onerror = () => no(get.error);
    });
  } finally {
    db.close();
  }
}

const databases = async (): Promise<string[]> => (await indexedDB.databases()).map((d) => d.name ?? "");

/* KILLED BEFORE IT SAVED THE ANSWER: Chrome writes cookies to disk about every 30 s and localStorage in
 * batches, so a browser killed just after a renewal's 204 comes back holding the spent token. The server
 * re-admits it under the name it went out with, and sweeps the family under any other. */
describe("a browser killed before it saved its renewal's answer", () => {
  beforeEach(() => { (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory(); });
  afterEach(() => { Reflect.deleteProperty(globalThis, "indexedDB"); });

  it("the jar back on its old mark: the restart 76 s later presents the SAME name", async () => {
    const tab = await openTab();
    answers = [minted("c1"), minted("c2")];
    expect(await tab.resumeSession()).toBe("resumed");
    const spent = lastName();
    document.cookie = "tf_csrf=c0; Path=/";
    vi.setSystemTime(new Date(Date.now() + 76_000));
    await (await openTab()).resumeSession();
    expect(lastName(), "the name the spent token went out under").toBe(spent);
  });

  it("localStorage lost its batch too: the restart still presents the SAME name", async () => {
    const tab = await openTab();
    answers = [minted("c1"), minted("c2")];
    expect(await tab.resumeSession()).toBe("resumed");
    const spent = lastName();
    document.cookie = "tf_csrf=c0; Path=/";
    window.localStorage.clear();
    vi.setSystemTime(new Date(Date.now() + 76_000));
    await (await openTab()).resumeSession();
    expect(lastName()).toBe(spent);
    expect(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY), "both copies hold it again").toContain(String(spent));
  });

  it("localStorage kept an OLDER name: IndexedDB's newer one goes", async () => {
    const tab = await openTab();
    answers = [minted("c1"), minted("c2"), minted("c3")];
    expect(await tab.resumeSession()).toBe("resumed");
    const older = window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY)!;
    vi.setSystemTime(new Date(Date.now() + 12 * MIN));
    expect(await tab.resumeSession()).toBe("resumed");
    const newer = lastName();
    document.cookie = "tf_csrf=c1; Path=/";
    window.localStorage.setItem(tab.SESSION_ATTEMPT_KEY, older);
    vi.setSystemTime(new Date(Date.now() + 76_000));
    await (await openTab()).resumeSession();
    expect(lastName(), "the name the renewal that died went out under").toBe(newer);
  });

  it("the name is in IndexedDB when the request leaves", async () => {
    const tab = await openTab();
    const answered = globalThis.fetch;
    let atSend: unknown = "never read";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/auth/refresh")) atSend = await durableName();
      return answered(input, init);
    }) as typeof fetch;
    answers = [minted("c1")];
    expect(await tab.resumeSession()).toBe("resumed");
    expect(atSend).toBe(lastName());
  });

  it("CONTROL: no crash, the jar moved on: the next renewal is a new attempt", async () => {
    const tab = await openTab();
    answers = [minted("c1"), minted("c2")];
    await tab.resumeSession();
    const first = lastName();
    vi.setSystemTime(new Date(Date.now() + 12 * MIN));
    await (await openTab()).resumeSession();
    expect(lastName()).not.toBe(first);
  });

  it("a coded refusal settles both copies", async () => {
    const tab = await openTab();
    answers = [lost, revoked];
    await tab.resumeSession();
    expect(await databases(), "the control: the name was written").toContain(tab.SESSION_ATTEMPT_DB);
    expect(await tab.resumeSession()).toBe("refused");
    expect(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY)).toBeNull();
    expect(await databases()).not.toContain(tab.SESSION_ATTEMPT_DB);
  });

  it.each([
    ["missing", undefined],
    ["refusing", { open: () => { throw new DOMException("refused", "SecurityError"); } }],
    ["failing", { open: () => { const req = {} as IDBOpenDBRequest; setTimeout(() => req.onerror?.(new Event("error"))); return req; } }],
    ["hung", { open: () => ({}) }],
  ])("an IndexedDB that is %s: the renewal still goes out, within the budget", async (_how, factory) => {
    (globalThis as { indexedDB?: unknown }).indexedDB = factory;
    const tab = await openTab();
    answers = [minted("c1")];
    const answer = tab.resumeSession();
    await vi.advanceTimersByTimeAsync(tab.ATTEMPT_STORE_BUDGET_MS);
    expect(await answer).toBe("resumed");
    expect(sent).toHaveLength(1);
  });
});

/* A COPY THAT MISSED A WRITE HOLDS AN OLDER NAME: the 204 leaves the earlier renewal's name in IndexedDB,
 * so an IndexedDB that hung, failed or refused on the renewal whose answer died must not shadow the name
 * that renewal went out under, which the other copies hold. */
describe("a copy that missed a write never shadows the newer name", () => {
  let idbOpen: "answers" | "hung" | "failing" = "answers";
  beforeEach(() => {
    idbOpen = "answers";
    const real = new IDBFactory();
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: (name: string, version?: number) => {
        if (idbOpen === "answers") return real.open(name, version);
        const req = {} as IDBOpenDBRequest;
        if (idbOpen === "failing") setTimeout(() => req.onerror?.(new Event("error")));
        return req;
      },
      deleteDatabase: (name: string) => real.deleteDatabase(name),
    };
  });
  afterEach(() => { Reflect.deleteProperty(globalThis, "indexedDB"); });

  it.each([
    ["hung", "this page"], ["hung", "a reload"], ["failing", "this page"], ["failing", "a reload"],
  ] as const)("IndexedDB %s on the renewal whose answer died, answering by its retry 76 s later: %s presents the SAME name", async (how, where) => {
    const tab = await openTab();
    answers = [minted("c1"), lost, minted("c2")];
    expect(await tab.resumeSession()).toBe("resumed");
    vi.setSystemTime(new Date(Date.now() + 12 * MIN));
    idbOpen = how;
    const renewal = tab.resumeSession();
    await vi.advanceTimersByTimeAsync(tab.ATTEMPT_STORE_BUDGET_MS);
    expect(await renewal).toBe("unavailable");
    const spent = lastName();
    idbOpen = "answers";
    vi.setSystemTime(new Date(Date.now() + 76_000));
    expect(await (where === "this page" ? tab : await openTab()).resumeSession()).toBe("resumed");
    expect(lastName(), "the name the spent token went out under").toBe(spent);
  });

  it("IndexedDB refusing every write after an earlier name landed: each lost renewal's retry keeps its name", async () => {
    const tab = await openTab();
    answers = [minted("c1")];
    expect(await tab.resumeSession()).toBe("resumed");
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.apply(this, args);
      // Refused as a full disk refuses it: the transaction aborts.
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    for (const [csrf, where] of [["c2", "this page"], ["c3", "a reload"]] as const) {
      vi.setSystemTime(new Date(Date.now() + 12 * MIN));
      answers = [lost, minted(csrf)];
      expect(await tab.resumeSession()).toBe("unavailable");
      const spent = lastName();
      vi.setSystemTime(new Date(Date.now() + 76_000));
      expect(await (where === "this page" ? tab : await openTab()).resumeSession()).toBe("resumed");
      expect(lastName(), `the retry in ${where}`).toBe(spent);
    }
  });
});
