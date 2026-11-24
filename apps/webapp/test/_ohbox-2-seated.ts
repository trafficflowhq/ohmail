/**
 * THE NEW SHELL's DOOR FOR A READ-STATE CASE, share ohbox-2's helper (the join folds it with share ohbox-1's
 * `mountSeated`, which stands inline in `ohbox/ohbox-read-state.test.ts` and is this file's model, line for line where
 * it can be): the web's shell over a live engine (`fixtures/thread-read-shell.ts`'s `mountThread`: a served page of
 * mail from a consented sender, each letter its own conversation, the read wire recorded), its server echoing each
 * read-state write on the next drain (without the echo the engine's acknowledged write lapses after ~20 s, a fault
 * of the fixture's: ohbox-1's NEEDS-DOOR). What the older read-display cases counted through today's view's seams is
 * read here where the new shell carries it: `marked` (every read-state write, as the wire carries it), `held` (every
 * hold the engine was asked for: `holdOpenRow(id)` as the id, `releaseOpenRow()` as null: today's `onHoldRow`, which
 * the seat hands the engine, `packages/app-logic/src/ohbox/live.ts`), and the letter over the list where one column
 * stands (the address's). A person's Back is the address going back to the Ohbox's (`back`).
 *
 * The test file imports this FIRST: the shell's door pins the API base before anything reads it.
 */
import { ISO, act, answerSyncWith, installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { vi } from "vitest";
import { OhmailEngine } from "@ohmail/client-engine";
import { mountThread, msg as served, patches } from "./fixtures/thread-read-shell.js";

export interface SeatedRow {
  id: string;
  unread: boolean;
  subject?: string;
  /** Its minute after 08:00 on 2026-08-03 (the served page's clock); by default newest first in the order given. */
  n?: number;
  /** Its conversation; by default one of its own (`t-<id>`). */
  threadId?: string;
}

/** Every read-state write the engine sent, in order (`glance` where nobody pressed a read verb). */
export const marked: Array<{ ids: string[]; unread: boolean; via?: "glance" }> = [];
/** The writes as today's view's `onMarkSeen` seam handed them up (ids and direction; the wire's `via` left out). */
export const writes = (): Array<{ ids: string[]; unread: boolean }> => marked.map(({ ids, unread }) => ({ ids, unread }));
/** Every hold the engine was asked for: the id held, or null for a release. */
export const held: Array<string | null> = [];
/** The row the engine held at each read-state write it was asked for (`mark_seen` through its `mutate`), in order. */
export const heldAtSave: Array<string | null> = [];
/** The door's container, while a seat stands. */
let root: HTMLElement | null = null;
export const host = (): HTMLElement => {
  if (root === null) throw new Error("no seat is up");
  return root;
};

/** Is the reading column hidden? Under 700 wide one column stands. */
export const columnHidden = (): boolean => window.matchMedia("(max-width: 699.98px)").matches;

/** The window's width for the frame's columns, and the media query the read rule asks. */
export function setViewport(mobile: boolean): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: mobile ? 390 : 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"),
      media: query,
      onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

/** A change the server says on its next drain beyond the echo: a row changed elsewhere, gone, or new mail. */
export type Owed = { id: string; gone: boolean; over?: Record<string, unknown>; arrives?: { n: number; subject: string; unread: boolean } };
let owed: Owed[] = [];

/** Each case's before: the shell's environment, the Ohbox's address, nothing recorded. */
export function seatEnv(mobile = false): void {
  installShellEnv();
  window.location.hash = "#/ohbox";
  root = null;
  marked.length = 0;
  held.length = 0;
  heldAtSave.length = 0;
  owed = [];
  setViewport(mobile);
}

/** Each case's after. */
export async function seatDown(): Promise<void> {
  root = null;
  await teardownShellEnv();
  vi.restoreAllMocks();
  vi.useRealTimers();
}

/**
 * THE NEW SHELL over `rows`, served as a live account's page (each its own conversation, from a sender the account
 * admitted). `first`: the first row selected as today's inert harness handed it, made as a person makes it: one `j`
 * (a preview: nothing is read by it).
 */
export async function mountSeated(rows: SeatedRow[], opts: { first?: boolean } = {}): Promise<HTMLElement> {
  const hold = OhmailEngine.prototype.holdOpenRow;
  const release = OhmailEngine.prototype.releaseOpenRow;
  vi.spyOn(OhmailEngine.prototype, "holdOpenRow").mockImplementation(function (this: OhmailEngine, id: string) {
    held.push(id);
    return hold.call(this, id);
  });
  vi.spyOn(OhmailEngine.prototype, "releaseOpenRow").mockImplementation(function (this: OhmailEngine, id?: string) {
    held.push(null);
    return release.call(this, id);
  });
  const mutate = OhmailEngine.prototype.mutate;
  vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(function (this: OhmailEngine, ...args: Parameters<OhmailEngine["mutate"]>) {
    if ((args[0] as { kind?: string }).kind === "mark_seen") heldAtSave.push(this.openRowHeld());
    return mutate.apply(this, args);
  });
  const page = rows.map((r, i) =>
    served(r.id, r.n ?? 50 - i, { threadId: r.threadId ?? `t-${r.id}`, subject: r.subject ?? `subj-${r.id}`, unread: r.unread }),
  );
  root = await mountThread(page);
  /* THE SERVER ECHOES WHAT IT WAS TOLD, as a real one's sync does (ohbox-read-state's `mountSeated`, word for word). */
  const rowsById = new Map(page.map((c) => [c.id, c.entity as Record<string, unknown>]));
  let echoed = 0;
  let seq = 1000;
  owed = [];
  answerSyncWith(() => {
    const changes = { creates: [] as unknown[], updates: [] as unknown[], moves: [] as unknown[], deletes: [] as unknown[] };
    for (const p of patches.slice(echoed)) for (const id of p.ids) {
      const row = rowsById.get(id);
      if (row === undefined) continue;
      /* An OPEN READ (the write carries `openRead`) is stamped by the server on the rows it turns read, as the real
         one stamps `openReadAt` (`dto/materialize.ts`); a mark-unread clears it. */
      const openRead = (p as { openRead?: boolean }).openRead === true;
      if (p.unread) row.openReadAt = null;
      else if (openRead && row.unread === true) row.openReadAt = new Date().toISOString();
      row.unread = p.unread;
      changes.updates.push({ type: "message", op: "update", id, seq: ++seq, updatedAt: ISO, entity: { ...row } });
    }
    echoed = patches.length;
    for (const o of owed.splice(0)) {
      if (o.arrives !== undefined) {
        const tid = `t-${o.id}`;
        const m = served(o.id, o.arrives.n, { threadId: tid, subject: o.arrives.subject, unread: o.arrives.unread });
        rowsById.set(o.id, m.entity as Record<string, unknown>);
        changes.creates.push(m, {
          type: "thread", op: "create", id: tid, seq: ++seq, updatedAt: ISO,
          entity: { id: tid, accountId: "acct_live_1", rootMessageIdHeader: null, subject: o.arrives.subject, messageIds: [o.id],
            lastMessageAt: ISO, participants: [], updatedAt: ISO },
        });
      } else if (o.gone) {
        rowsById.delete(o.id);
        changes.deletes.push({ type: "message", op: "delete", id: o.id, seq: ++seq, updatedAt: ISO, entity: null });
      } else {
        const row = rowsById.get(o.id)!;
        Object.assign(row, o.over);
        changes.updates.push({ type: "message", op: "update", id: o.id, seq: ++seq, updatedAt: ISO, entity: { ...row } });
      }
    }
    return new Response(JSON.stringify({ changes, cursor: `echo-${seq}`, hasMore: false, serverTime: ISO }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const wire = patches;
  const put = wire.push.bind(wire);
  wire.push = (...sent) => {
    for (const p of sent) marked.push({ ids: p.ids, unread: p.unread, ...(p.via === "glance" ? { via: "glance" as const } : {}) });
    return put(...sent);
  };
  if (opts.first) await key("j");
  return root;
}

/** The server says it now: a delta served on the drain the browser's `online` buys (ohbox-read-state's `serverSays`). */
export async function serverSays(change: Owed): Promise<void> {
  owed.push(change);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(25); });
}

/** A frame passes: the rule looks at what is on screen. */
export async function frame(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
}

/** A key as a person presses it. */
export async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await frame();
}

/** A row of the Ohbox's list by its letter. */
export const rowEl = (id: string): HTMLElement => {
  const el = host().querySelector<HTMLElement>(`[role=option][data-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
};

/** A click on a row, as a person makes it. */
export async function click(id: string, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    rowEl(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  await frame();
}

/** The letter the address names (`#/ohbox/m/<id>`), or null. */
export const openInAddress = (): string | null => /^#\/ohbox\/m\/([^/?]+)/.exec(window.location.hash)?.[1] ?? null;

/** A person's Back from a letter: the address returns to the Ohbox's own, and the frame follows it. */
export async function back(): Promise<void> {
  await act(async () => {
    window.location.hash = "#/ohbox";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await frame();
}

/** The tab is hidden, closed, or frozen into the back/forward cache. */
export async function pagehide(): Promise<void> {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
}

/** Time passes, in steps a commit can land between. */
export async function wait(ms: number, step = 250): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(step, left)); });
  }
}

/** The ids of the rows a group's listbox holds ("New", "Earlier", "Resurfaced"). */
export const idsInGroup = (label: string): string[] => {
  const box = host().querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll<HTMLElement>("[role=option][data-id]")].map((r) => r.dataset.id!);
};
