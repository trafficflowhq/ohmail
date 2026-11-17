/**
 * The service worker, run as the browser runs it: a wake while no window is visible draws the
 * words the page stored, two strings of at most 120 characters each, or nothing at all. Anything
 * of the origin can write that entry, and a notice stays on a locked screen until it is dismissed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const WORKER = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");

type Handler = (event: { data?: unknown; waitUntil(p: Promise<unknown>): void }) => void;

/** The worker over a stub `self`: no visible window, and `entry` as the page last stored it. */
function workerWith(entry: unknown) {
  const handlers = new Map<string, Handler[]>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const self = {
    addEventListener: (type: string, h: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), h]); },
    clients: { matchAll: async () => [], claim: async () => undefined, openWindow: async () => undefined },
    registration: {
      scope: "https://mail.example/",
      showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); },
    },
    skipWaiting: async () => undefined,
  };
  const caches = { open: async () => ({ match: async () => new Response(JSON.stringify(entry)) }) };
  runInNewContext(WORKER, { self, caches });
  const fire = async (type: string, data?: unknown): Promise<void> => {
    const waits: Promise<unknown>[] = [];
    for (const h of handlers.get(type) ?? []) h({ data, waitUntil: (p) => { waits.push(p); } });
    await Promise.all(waits);
  };
  return { fire, shown };
}

const words = (n: number): string => "w".repeat(n);

describe("the worker draws two strings of at most 120 characters each, or nothing", () => {
  it("draws nothing for a title of 121 characters, nor for a body of 121", async () => {
    for (const [title, body] of [[words(121), words(10)], [words(10), words(121)]] as const) {
      const w = workerWith({ enabled: true, title, body });
      await w.fire("push");
      expect(w.shown, `${title.length} and ${body.length}`).toEqual([]);
    }
  });

  it("draws 120 and 120 once, exactly those two strings", async () => {
    const title = words(120);
    const body = "b".repeat(120);
    const w = workerWith({ enabled: true, title, body });
    await w.fire("push");
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toBe(title);
    expect(w.shown[0]!.options.body).toBe(body);
  });

  it("counts characters, not the halves a string is stored in", async () => {
    const w = workerWith({ enabled: true, title: "\u{1F4EC}".repeat(120), body: "b" });
    await w.fire("push");
    expect(w.shown).toHaveLength(1);
  });

  it("draws nothing for a message posted to it", async () => {
    const w = workerWith({ enabled: true, title: "ohmail", body: "New mail" });
    await w.fire("message", { type: "show", title: "Zqsubject", body: "Zqsender" });
    expect(w.shown).toEqual([]);
  });
});
