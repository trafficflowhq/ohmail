/**
 * The service worker, run as the browser runs it: a wake while no window is visible draws the
 * words the page stored, two strings of at most 120 characters each, or nothing at all. Anything
 * of the origin can write that entry, and a notice stays on a locked screen until it is dismissed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const WORKER = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");

type Handler = (event: { data?: unknown; waitUntil(p: Promise<unknown>): void }) => void;

type WorkerLock = { request(name: string, options: LockOptions, draw: () => Promise<boolean>): Promise<boolean> };
const unlocked: WorkerLock = { request: async (_name, _options, draw) => draw() };

/** The worker over a stub `self`: no visible window, and `entry` as the page last stored it. */
function workerWith(entry: () => unknown, locks: WorkerLock | null = unlocked, visible = () => false) {
  const handlers = new Map<string, Handler[]>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const nudges: unknown[] = [];
  const self = {
    addEventListener: (type: string, h: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), h]); },
    navigator: { locks },
    clients: {
      matchAll: async () => visible()
        ? [{ visibilityState: "visible", postMessage: (note: unknown) => { nudges.push(note); } }]
        : [],
      claim: async () => undefined,
      openWindow: async () => undefined,
    },
    registration: {
      scope: "https://mail.example/",
      showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); },
    },
    skipWaiting: async () => undefined,
  };
  const caches = { open: async () => ({ match: async () => new Response(JSON.stringify(entry())) }) };
  runInNewContext(WORKER, { self, caches, AbortController, setTimeout, clearTimeout });
  const fire = async (type: string, data?: unknown): Promise<void> => {
    const waits: Promise<unknown>[] = [];
    for (const h of handlers.get(type) ?? []) h({ data, waitUntil: (p) => { waits.push(p); } });
    await Promise.all(waits);
  };
  return { fire, shown, nudges };
}

const words = (n: number): string => "w".repeat(n);

describe("the worker draws two strings of at most 120 characters each, or nothing", () => {
  it("draws nothing for a title of 121 characters, nor for a body of 121", async () => {
    for (const [title, body] of [[words(121), words(10)], [words(10), words(121)]] as const) {
      const w = workerWith(() => ({ enabled: true, title, body }));
      await w.fire("push");
      expect(w.shown, `${title.length} and ${body.length}`).toEqual([]);
    }
  });

  it("draws 120 and 120 once, exactly those two strings", async () => {
    const title = words(120);
    const body = "b".repeat(120);
    const w = workerWith(() => ({ enabled: true, title, body }));
    await w.fire("push");
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toBe(title);
    expect(w.shown[0]!.options.body).toBe(body);
  });

  it("counts characters, not the halves a string is stored in", async () => {
    const w = workerWith(() => ({ enabled: true, title: "\u{1F4EC}".repeat(120), body: "b" }));
    await w.fire("push");
    expect(w.shown).toHaveLength(1);
  });

  it("draws nothing for a message posted to it", async () => {
    const w = workerWith(() => ({ enabled: true, title: "ohmail", body: "New mail" }));
    await w.fire("message", { type: "show", title: "Zqsubject", body: "Zqsender" });
    expect(w.shown).toEqual([]);
  });

  it.each([true, false])("waits for a pending write and uses its final enabled value %s", async (enabled) => {
    let current = { enabled: true, title: "ohmail", body: "Old words" };
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const w = workerWith(() => current, {
      request: async (name, _options, draw) => {
        expect(name).toBe("ohmail-notify-state");
        entered();
        await release;
        return draw();
      },
    });
    const pushing = w.fire("push");
    await started;
    expect(w.shown).toEqual([]);
    current = { enabled, title: "ohmail", body: "New mail" };
    finish();
    await pushing;
    expect(w.shown.map(({ options }) => options.body)).toEqual(enabled ? ["New mail"] : []);
  });

  it("does not draw without a shared worker-cache lock", async () => {
    const w = workerWith(() => ({ enabled: true, title: "ohmail", body: "New mail" }), null);
    await w.fire("push");
    expect(w.shown).toEqual([]);
  });

  it("still passes a wake to the visible window without a shared worker-cache lock", async () => {
    const w = workerWith(() => ({ enabled: true, title: "ohmail", body: "New mail" }), null, () => true);
    await w.fire("push");
    expect(w.shown).toEqual([]);
    expect(w.nudges).toEqual([{ type: "ohmail:wake" }]);
  });

  it("draws nothing when a worker-cache lock does not become available", async () => {
    vi.useFakeTimers();
    try {
      const w = workerWith(() => ({ enabled: true, title: "ohmail", body: "New mail" }), {
        request: (_name, { signal }) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      });
      const pushing = w.fire("push");
      await vi.advanceTimersByTimeAsync(4_000);
      await pushing;
      expect(w.shown).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
