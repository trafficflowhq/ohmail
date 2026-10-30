/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import {
  consentPartition, presentAt, presentationReader, winningStates, type EngineMessage, type OhmailEngine,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { createEngine } from "../app/shell/engine-config.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * ALLOW, NOT SPAM AND BACK TO WAITING OFFER UNDO, AS MOVE DOES.
 *
 * A release wrote its rule change at the press and offered no Undo; a mistaken one was taken back
 * by hand on the Rules page. Now the mail moves at the press and the rule change waits in the
 * routing window: Undo moves the mail back and the rule is never written, and the window's close
 * writes it. Driven through the engine and the dispatch spine the shell builds.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

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
const state: { current: import("../app/shell/screener-state.js").ScreenerState | null } = { current: null };
const dispatch: { current: ReturnType<typeof import("../app/shell/shell-dispatch.js").useShellDispatch> | null } = { current: null };
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

/** The shell's composition: the dispatch spine, the presentation with the window's places, the Screener. */
async function mount(engine: OhmailEngine): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { useShellDispatch } = await import("../app/shell/shell-dispatch.js");
  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const t = useTranslations();
    const reader = engine.read();
    const d = useShellDispatch({
      engine, reader, t, demo: false, refreshFacts: () => {},
      toast: (message: string, opts?: { onAction?: () => void }) => { toasts.push({ message, onAction: opts?.onAction }); },
    });
    dispatch.current = d;
    const presented = React.useMemo(
      () => presentAt(presentationReader(reader, consentPartition(reader, { now: NOW })), d.routing.places),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [v, d.routing.places],
    );
    state.current = useScreenerState(engine, v, d.undoToast, undefined, presented, true, undefined, [], [], undefined, {
      hold: d.routing.holdRelease, cancel: (a) => d.routing.undo(d.routing.subjectOf(a)),
      restart: (a) => d.routing.restart(d.routing.subjectOf(a)), toastWithUndo: d.toastWithUndo,
    });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(Probe) }),
    }));
  });
  await flush();
  await settleFirstPaint();
  await flush();
}

const ruleWrites = (): string[] => calls.filter((c) => c.includes("/api/rules"));
/** Whether a letter's move to `folder` went as the press's own (`pressRule`), which decides no place of its own. */
const markedMove = (id: string, folder: string): boolean | undefined =>
  moveBodies.find((x) => x.url === `/api/messages/${id}/move` && x.body.folder === folder)?.body.pressRule === true;
const windowCloses = async (): Promise<void> => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  await flush();
};

describe("a release from Screened out", () => {
  it("moves the mail at once, holds the rule change, and writes it when the window closes", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    const sender = state.current!.screenedOut.find((x) => x.from.address === "out@one.test");
    expect(sender, "the screened-out sender is not on the shelf").toBeDefined();

    await act(async () => { state.current!.allowScreened(sender!, "ohbox"); });
    await flush();
    expect(calls).toContain("POST /api/messages/m1/move INBOX");
    expect(markedMove("m1", "INBOX"), "a release that rewrites the rule stamped its letters as filed by hand").toBe(true);
    expect(ruleWrites(), "the rule was written at the press").toEqual([]);
    const offer = toasts.find((x) => x.onAction !== undefined);
    expect(offer?.message, "the release offered no Undo").toBe(
      "Ohbox — 1 held from out@one.test released. Their rule now files future mail here too.");
    expect(state.current!.screenedOut.some((x) => x.from.address === "out@one.test"),
      "the released sender is still on the shelf").toBe(false);

    await windowCloses();
    expect(ruleWrites()).toEqual(["PATCH /api/rules/r1"]);
  });

  it("Undo moves the mail back, and the rule is never written", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    const sender = state.current!.screenedOut.find((x) => x.from.address === "out@one.test")!;
    await act(async () => { state.current!.allowScreened(sender, "ohbox"); });
    await flush();
    const offer = toasts.find((x) => x.onAction !== undefined)!;
    await act(async () => { offer.onAction!(); });
    await flush();
    await windowCloses();

    expect(calls).toContain("POST /api/messages/m1/move ohmail/Screened");
    expect(markedMove("m1", "ohmail/Screened"), "Undo's move back is not the press's own").toBe(true);
    expect(ruleWrites(), "Undo left the rule change to be written").toEqual([]);
    expect(toasts.at(-1)?.message).toBe(messages.screening.toastRoutingUndoneRules);
  });
});

describe("a release from a domain rule", () => {
  it("writes the address rule that walks their past mail when the window closes, and no other", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    const sender = state.current!.screenedOut.find((x) => x.from.address === "d@three.test")!;
    await act(async () => { state.current!.allowScreened(sender, "ohbox"); });
    await flush();
    expect(ruleWrites()).toEqual([]);
    expect(markedMove("m3", "INBOX"), "the address rule's release stamped its letter").toBe(true);
    await windowCloses();
    expect(ruleWrites()).toEqual(["POST /api/rules"]);
    expect(ruleBodies).toEqual([expect.objectContaining({ kind: "sender", match: "d@three.test", destination: "INBOX", applyRetro: true })]);
  });
});

describe("Not spam, back to Waiting", () => {
  it("moves the mail to Waiting at once and holds the rule's removal, with Undo", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    const row = state.current!.spam.find((x) => x.sender.from.address === "spam@two.test");
    expect(row, "the spam sender is not in Spam").toBeDefined();

    await act(async () => { state.current!.notSpamToWaiting(row!); });
    await flush();
    expect(calls).toContain("POST /api/messages/m2/move ohmail/Screener");
    // Back to the gate writes no rule: its move is an ordinary one.
    expect(markedMove("m2", "ohmail/Screener")).toBe(false);
    expect(ruleWrites(), "the rule was removed at the press").toEqual([]);
    expect(toasts.find((x) => x.onAction !== undefined)?.message).toBe("Not spam — spam@two.test is back in Waiting.");

    await windowCloses();
    expect(ruleWrites()).toEqual(["DELETE /api/rules/r2"]);
  });
});

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
