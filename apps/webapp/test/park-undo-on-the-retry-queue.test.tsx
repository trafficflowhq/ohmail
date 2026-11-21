/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { winningStates, type OhmailEngine } from "@ohmail/client-engine";
import { placeLabel } from "@ohmail/app-logic/text/format";
import messages from "../messages/en.json";
import { createEngine } from "../app/shell/engine-config.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * A CONVERSATION'S PARK OFFERS UNDO FOR EVERY LETTER, ALSO THOSE ON THE RETRY QUEUE: the dispatch spine the mail
 * frame's room calls once per frame (`packages/app/src/frame/room.tsx` `Seam`: `useShellDispatch` over the engine,
 * the mirror, the report and the place's label). Moved here from `release-offers-undo.test.tsx`, whose other cases
 * mount the Screener's state over today's words and wait for the Screener's mount; these two read the spine alone.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
const NOW = new Date("2026-09-28T09:00:00.000Z");
const AT = "2026-09-28T08:00:00.000Z";

function message(id: string, from: string, folder: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: AT, folder, snippet: `snippet ${id}`, unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: AT,
  } as EngineMessage;
}
const rule = (id: string, match: string, destination: string, kind = "sender") => ({
  id, kind, match, destination, priority: 0, provenance: "promoted", enabled: true,
  subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: AT, updatedAt: AT, retro: { requestedAt: null, doneAt: null },
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: string[] = [];
let ruleBodies: Array<Record<string, unknown>> = [];
let moveBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
const toasts: Array<{ message: string; onAction?: () => void }> = [];
const originalFetch = globalThis.fetch;
/** A three-letter conversation in the Ohbox, served when a case asks for it. */
const CONVO = ["c1", "c2", "c3"];
let convo = false;
/** The letters whose next triage write the server answers with a retryable 503 (a deploy). */
let retrying = new Set<string>();
let triagePosts: Array<{ id: string; state: string; status: number }> = [];

beforeEach(() => {
  calls = [];
  ruleBodies = [];
  moveBodies = [];
  toasts.length = 0;
  convo = false;
  retrying = new Set<string>();
  triagePosts = [];
  localStorage.clear();
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push(`${method} ${url}${method === "POST" && url.endsWith("/move") ? ` ${JSON.parse(body).folder}` : ""}`);
    if (url.startsWith("/api/sync/snapshot")) {
      return Promise.resolve(json(200, {
        asOfSeq: 1, nextCursor: null, window: { days: 0, minRows: 0 },
        changes: [
          { type: "message", op: "create", id: "m1", seq: 1, updatedAt: AT, entity: message("m1", "out@one.test", "ohmail/Screened") },
          { type: "rule", op: "create", id: "r1", seq: 1, updatedAt: AT, entity: rule("r1", "out@one.test", "ohmail/Screened") },
          { type: "message", op: "create", id: "m2", seq: 1, updatedAt: AT, entity: message("m2", "spam@two.test", "ohmail/Quarantine") },
          { type: "rule", op: "create", id: "r2", seq: 1, updatedAt: AT, entity: rule("r2", "spam@two.test", "ohmail/Quarantine") },
          { type: "message", op: "create", id: "m3", seq: 1, updatedAt: AT, entity: message("m3", "d@three.test", "ohmail/Screened") },
          { type: "rule", op: "create", id: "r3", seq: 1, updatedAt: AT, entity: rule("r3", "three.test", "ohmail/Screened", "domain") },
          ...(convo ? CONVO.map((id) => ({
            type: "message", op: "create", id, seq: 1, updatedAt: AT, entity: { ...message(id, "pal@four.test", "INBOX"), threadId: "t1" },
          })) : []),
        ],
      }));
    }
    const triage = /^\/api\/messages\/([^/]+)\/triage$/.exec(url);
    if (method === "POST" && triage) {
      const state = (JSON.parse(body) as { state: string }).state;
      const status = retrying.delete(triage[1]!) ? 503 : 200;
      triagePosts.push({ id: triage[1]!, state, status });
      return Promise.resolve(status === 503
        ? json(503, { error: { code: "unavailable", message: "deploying" } })
        : json(200, { messageId: triage[1], state, bubbleUpAt: null, updatedAt: AT }));
    }
    if (url.startsWith("/api/sync?")) {
      return Promise.resolve(json(200, {
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: AT,
      }));
    }
    if (method === "POST" && url.endsWith("/move")) {
      moveBodies.push({ url, body: JSON.parse(body) as Record<string, unknown> });
      return Promise.resolve(json(200, { ok: true }));
    }
    if (method === "PATCH" && url === "/api/rules/r1") return Promise.resolve(json(200, { ...rule("r1", "out@one.test", "INBOX") }));
    if (method === "DELETE" && url === "/api/rules/r2") return Promise.resolve(new Response(null, { status: 204 }));
    if (method === "POST" && url === "/api/rules") {
      ruleBodies.push(JSON.parse(body) as Record<string, unknown>);
      return Promise.resolve(json(201, { ...rule("r9", "d@three.test", "INBOX") }));
    }
    return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
  }) as unknown as typeof fetch;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const dispatch: { current: ReturnType<typeof import("@ohmail/app-logic/press/shell-dispatch").useShellDispatch> | null } = { current: null };
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
});
async function flush(n = 25): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** The room's seam: the dispatch spine over the engine and the mirror, its toasts the report. */
async function mount(engine: OhmailEngine): Promise<void> {
  const { useShellDispatch } = await import("@ohmail/app-logic/press/shell-dispatch");
  function Probe(): null {
    const [, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const t = useTranslations();
    const reader = engine.read();
    dispatch.current = useShellDispatch({
      engine, reader, t, placeLabel, demo: false, refreshFacts: () => {}, scope: null,
      toast: (message: string, opts?: { onAction?: () => void }) => { toasts.push({ message, onAction: opts?.onAction }); },
    });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
  });
  await flush();
  await settleFirstPaint();
  await flush();
}

/**
 * A CONVERSATION'S PARK TAKES BACK EVERY LETTER WHOSE PRESS STANDS. A letter whose write met a
 * retryable answer waits on this client's retry queue and lands on the next drive: it is parked,
 * so the press names it and its Undo is owed too. Without that the letter stayed parked while the
 * rest came back, and a press whose every letter met the 503 said nothing had changed, with no Undo.
 */
describe("a conversation's Park with letters on the retry queue", () => {
  for (const queued of [["c2"], CONVO]) {
    it(`names all three, offers Undo, and Undo takes every letter back when ${queued.length} of 3 wait to be sent again`, async () => {
      convo = true;
      retrying = new Set(queued);
      const engine = createEngine(false, ARMED);
      await engine.start();
      await mount(engine);
      let stood = -1;
      await act(async () => {
        void dispatch.current!.mutateSetAndReport(
          CONVO.map((messageId) => ({ kind: "triage_set" as const, messageId, state: "set_aside" as const })),
          (n) => `Parked ${n}`,
        ).then((n) => { stood = n; });
      });
      await flush();
      expect(triagePosts.filter((p) => p.status === 503).map((p) => p.id), "control: these writes met the 503").toEqual(queued);
      expect(toasts.map((x) => x.message), "the press said nothing changed").not.toContain(messages.ohbox.refusedPress);
      const offer = toasts.find((x) => x.onAction !== undefined);
      expect(offer?.message, "the press did not name every parked letter with its Undo").toBe("Parked 3");
      expect(stood, "the press counted only the letters that applied").toBe(3);
      await act(async () => { offer!.onAction!(); });
      await flush();
      await act(async () => { await engine.flushPending(); });
      await flush();

      const last = (id: string) => triagePosts.filter((p) => p.id === id && p.status === 200).at(-1)?.state ?? "none";
      expect(CONVO.filter((id) => !triagePosts.some((p) => p.id === id && p.state === "none")), "Undo left these letters out").toEqual([]);
      expect(CONVO.map(last), "a letter is still parked on the server").toEqual(["none", "none", "none"]);
      expect(CONVO.map((id) => winningStates(engine.read()).get(id)?.state ?? "none")).toEqual(["none", "none", "none"]);
      expect(toasts.at(-1)?.message).toBe(messages.ohbox.toastUndone);
    });
  }

  /* The Undo stands by the press's own rule: its writes queued for retry land on the next drive. */
  it("an Undo whose every write is answered retryable says Undone, never that nothing changed", async () => {
    convo = true;
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    await act(async () => {
      void dispatch.current!.mutateSetAndReport(
        CONVO.map((messageId) => ({ kind: "triage_set" as const, messageId, state: "set_aside" as const })),
        (n) => `Parked ${n}`,
      );
    });
    await flush();
    const offer = toasts.find((x) => x.onAction !== undefined)!;
    expect(offer.message).toBe("Parked 3");
    retrying = new Set(CONVO);
    const before = toasts.length;
    await act(async () => { offer.onAction!(); });
    await flush();
    expect(triagePosts.filter((p) => p.status === 503 && p.state === "none").map((p) => p.id),
      "control: the Undo's writes met the 503").toEqual(CONVO);
    const said = toasts.slice(before).map((x) => x.message);
    expect(said, "a queued Undo said nothing changed").not.toContain(messages.ohbox.refusedPress);
    expect(said).toEqual([messages.ohbox.toastUndone]);
    await act(async () => { await engine.flushPending(); });
    await flush();
    const last = (id: string) => triagePosts.filter((p) => p.id === id && p.status === 200).at(-1)?.state ?? "none";
    expect(CONVO.map(last), "the queued Undo did not land").toEqual(["none", "none", "none"]);
  });
});
