/**
 * THE SHELL OVER A STORE THAT HOLDS MORE THAN THE DEVICE — the Older tail's harness.
 *
 * `live-walk-shell.ts` mounts the real shell over a driven `/sync`; this adds the store's two
 * reach-past doors (`/messages/timeline` and the Ohbox's own `GET /messages?view=imbox`), one
 * deterministic first drain, and a record of every write that reached the wire. `storeRows` are
 * rows only the store holds; `honoursEdge` false is a server older than the edge parameter.
 */
import { expect, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../../messages/en.json";
import { LOADING_GRACE_MS } from "@ohmail/app-logic/session/loading-grace";
import { act, installShellEnv, ISO, mailbox, mountShell, tick } from "./live-walk-shell";

export type Row = { id: string; date: string | null; unread?: boolean; folder?: string; from?: string };
export interface Write { method: string; url: string; body: unknown }

export const OHBOX = messages.ohbox as unknown as Record<string, string>;

/** A sender with a rule — the Ohbox's own correspondent. */
export const DECIDED = "m2@example.invalid";
/** A first-time sender the Screener holds: one recent letter at the gate, older ones in the store. */
export const STRANGER = "stranger@example.invalid";

/** Store-only rows from a decided sender, older than anything `/sync` serves; uuid ids. */
export const OLDER: Row[] = [
  { id: "00000000-0000-4000-8000-000000000044", date: "2025-03-20T09:00:00.000Z", unread: true, from: DECIDED },
  { id: "00000000-0000-4000-8000-000000000033", date: "2025-03-10T09:00:00.000Z", from: DECIDED },
  { id: "00000000-0000-4000-8000-000000000022", date: "2025-02-15T09:00:00.000Z", from: DECIDED },
  { id: "00000000-0000-4000-8000-000000000011", date: "2025-01-05T09:00:00.000Z", from: DECIDED },
];
/** The held stranger's letters past the window, newer than every decided one — page one's top. */
export const HELD: Row[] = [
  { id: "00000000-0000-4000-8000-0000000000a2", date: "2025-06-02T09:00:00.000Z", unread: true, from: STRANGER },
  { id: "00000000-0000-4000-8000-0000000000a1", date: "2025-06-01T09:00:00.000Z", unread: true, from: STRANGER },
];

export const store = {
  /** Every message `/sync` handed out. */
  served: [] as Row[],
  /** Rows only the store holds. */
  rows: [] as Row[],
  /** Each `view=imbox` ask, as its query. */
  asks: [] as URLSearchParams[],
  /** Every non-GET request, in order. */
  writes: [] as Write[],
  /** Every `GET /messages/:id`, as its id. */
  byId: [] as string[],
  /** The store's word on a read press, delivered by the next drain: the rows it changed. */
  owed: [] as Row[],
  /** Extra mail from the decided sender in the first drain — a mirror filled to the window. */
  bulk: 0,
  /** The Ohbox page's size when the ask names none: two, so a walk is cheap to reach. */
  pageSize: 2,
  honoursEdge: true,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const newestFirst = (a: Row, b: Row): number =>
  (b.date ?? "").localeCompare(a.date ?? "") || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export const messageEntity = (m: Row) => ({
  id: m.id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: `subject of ${m.id}`, from: { name: `Sender ${m.id}`, address: m.from ?? `${m.id}@example.invalid` },
  to: [], cc: [], date: m.date, folder: m.folder ?? "INBOX", snippet: "", unread: m.unread ?? false,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
});
const create = (type: string, id: string, seq: number, entity: unknown) =>
  ({ type, op: "create", id, seq, updatedAt: ISO, entity });

/**
 * Three Ohbox letters with their senders' rules; one the Screener holds at its folder (the recent
 * letter); and the stranger's newest letter, in the INBOX with no rule — the Screener presents it.
 */
function firstDrain(): Response {
  const inbox: Row[] = [
    { id: "m1", date: ISO, unread: true },
    { id: "m2", date: ISO },
    { id: "m3", date: ISO },
  ];
  const held: Row = { id: "m4", date: ISO, unread: true, folder: "ohmail/Screener" };
  const stranger: Row = { id: "m5", date: ISO, unread: true, from: STRANGER };
  // The decided sender's mail inside the window, one every ten minutes back from the fixture clock.
  const bulk: Row[] = Array.from({ length: store.bulk }, (_, i) => ({
    id: `b${i}`, date: new Date(Date.parse(ISO) - (i + 1) * 600_000).toISOString(), from: DECIDED,
  }));
  store.served = [...inbox, held, stranger, ...bulk];
  let seq = 0;
  const creates = [
    ...store.served.map((m) => create("message", m.id, ++seq, messageEntity(m))),
    ...inbox.map((m) => create("rule", `rule_${m.id}`, ++seq, {
      id: `rule_${m.id}`, kind: "sender", match: `${m.id}@example.invalid`, destination: "INBOX", priority: 0,
      provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
      createdAt: ISO, updatedAt: ISO,
    })),
    create("tag", "tag_1", ++seq, { id: "tag_1", name: "Keep", hue: "blue", createdAt: ISO, updatedAt: ISO }),
  ];
  return json({ changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c9", hasMore: false, serverTime: ISO });
}

function timelineAnswer(): Response {
  const rows = [...store.served, ...store.rows].sort(newestFirst);
  const months: Array<{ month: string; count: number; first: Row }> = [];
  for (const m of rows) {
    const last = months[months.length - 1];
    if (last?.month === m.date!.slice(0, 7)) last.count += 1;
    else months.push({ month: m.date!.slice(0, 7), count: 1, first: { id: m.id, date: m.date } });
  }
  return json({ total: rows.length, months, undated: 0 });
}

/** The store's Ohbox view, keyset-paged two rows at a time. */
function imboxAnswer(url: string): Response {
  const q = new URL(url, "https://harness.invalid").searchParams;
  store.asks.push(q);
  const limit = Number(q.get("limit") ?? store.pageSize);
  const all = [...store.served, ...store.rows].sort(newestFirst);
  let start = 0;
  const cursor = q.get("cursor");
  if (cursor !== null) start = Number(cursor);
  else if (store.honoursEdge && q.get("beforeId") !== null) {
    const bid = q.get("beforeId")!;
    const bdate = q.get("beforeDate")!;
    const at = all.findIndex((m) => m.date! < bdate || (m.date === bdate && m.id < bid));
    start = at < 0 ? all.length : at;
  }
  const items = all.slice(start, start + limit).map(messageEntity);
  return json({ items, nextCursor: start + limit < all.length ? String(start + limit) : null });
}

/** Install the shell env and the store's doors. Call from `beforeEach`. */
export function installOlderStore(): void {
  installShellEnv();
  store.served = [];
  store.rows = [];
  store.asks = [];
  store.writes = [];
  store.byId = [];
  store.owed = [];
  store.bulk = 0;
  store.pageSize = 2;
  store.honoursEdge = true;
  let drains = 0;
  const base = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { ids?: string[]; unread?: boolean } : null;
      store.writes.push({ method, url, body });
      // THE STORE APPLIES A READ PRESS, and says so on the next drain, as the server does.
      if (method === "PATCH" && /\/messages(\?|$)/.test(url) && body?.ids) {
        for (const id of body.ids) {
          const row = [...store.rows, ...store.served].find((m) => m.id === id);
          if (row) store.owed.push({ ...row, unread: body.unread ?? false });
        }
      }
    }
    // No snapshot route here: the since=0 drain is the bootstrap, and it is served once.
    if (url.includes("/sync/snapshot")) return json({ code: "not_found" }, 404);
    if (url.includes("/sync") && !url.includes("types=rule")) {
      drains += 1;
      if (drains === 1) return firstDrain();
      const updates = store.owed.splice(0).map((m) => ({
        type: "message", op: "update", id: m.id, seq: 100 + drains, updatedAt: ISO, entity: messageEntity(m),
      }));
      return json({ changes: { creates: [], updates, moves: [], deletes: [] }, cursor: `c${100 + drains}`, hasMore: false, serverTime: ISO });
    }
    if (url.includes("/messages/timeline")) return timelineAnswer();
    const byId = method === "GET" ? /\/messages\/([0-9a-f-]{36})(?:\?|$)/.exec(url) : null;
    if (byId) {
      store.byId.push(byId[1]!);
      const row = store.rows.find((m) => m.id === byId[1]);
      return row ? json(messageEntity(row)) : json({ code: "not_found" }, 404);
    }
    if (url.includes("/messages?") && url.includes("view=imbox")) return imboxAnswer(url);
    return (base as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
}

/**
 * The shell, mounted over one organizer mailbox and settled past the loading grace. `window`
 * builds the engine with a window small enough that the fixture's own rows cross it.
 */
export async function mountSettled(
  opts: { window?: { days: number; minRows: number; maxRows: number } } = {},
): Promise<HTMLElement> {
  let engine: OhmailEngine | undefined;
  if (opts.window) {
    const { HttpAdapter, MemoryMirrorStore, OhmailEngine: Engine } = await import("@ohmail/client-engine");
    engine = new Engine({
      adapter: new HttpAdapter({ baseUrl: "/api", fetch: (u: string, i?: RequestInit) => globalThis.fetch(u, i) }),
      store: new MemoryMirrorStore(),
      storePolicy: { mode: "windowed", ...opts.window },
    });
  }
  const el = await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })], engine ? { engine } : {});
  await tick(LOADING_GRACE_MS * 4);
  return el;
}

export const listed = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")].map((r) => r.dataset.id!);
export const olderRows = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Older"] .row[data-id]')]
    .map((r) => r.dataset.id!);

export async function pressLoadOlder(el: HTMLElement): Promise<void> {
  const button = [...el.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => (b.textContent ?? "").trim() === OHBOX.olderAction);
  expect(button, "no Load older mail control to press").toBeTruthy();
  await act(async () => { button!.click(); });
  for (let i = 0; i < 6; i += 1) await tick(0);
}
