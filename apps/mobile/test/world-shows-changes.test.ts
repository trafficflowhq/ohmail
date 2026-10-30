import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, type EngineAdapter, type EngineMessage, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { createProjector, listStamp, type ProjectionInputs, type Projected } from "../src/state/world-projection";
import { SCREENING_UNSUPPLIED, type WorldActions } from "../src/state/live";

/**
 * A CHANGE IS SHOWN. The ratchet bounds what the world re-derives; these arms bound the other side:
 * through ONE kept projector, run as the provider runs it (on the derived stamp, with stable
 * inputs), an arrival, a read, a move out of the Inbox, a held delete, a language switch and the
 * next day each reach the rows. A constant stamp, a key that drops the stamp or the day, or a row
 * memo that forgets the day leaves an old row standing, and an arm here goes red.
 */

const t0 = Date.UTC(2026, 8, 29, 6, 0, 0); // 08:00 Zurich
const MIN = 60_000;
const DAY = 86_400_000;
const OWN = ["me@example.test"] as readonly string[];
const PLACES = new Map() as never;
const SCOPES = {};
const LEAVING: never[] = [];
const NOHELD = new Set<string>();

function msg(id: string, dateMs: number, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: `t-${id}`, messageIdHeader: null,
    subject: `S ${id}`, from: { name: "K", address: "k@example.test" }, to: [{ name: null, address: "me@example.test" }], cc: [],
    date: new Date(dateMs).toISOString(), folder: "INBOX", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(dateMs).toISOString(), ...over,
  } as EngineMessage;
}
const create = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "create", id: m.id, seq: 1, updatedAt: m.updatedAt, entity: m } as SyncChange);

function rig(first: EngineMessage[]) {
  const pages: SyncChange[][] = [first.map(create)];
  let seq = 1000;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: (pages.shift() ?? []).map((c) => ({ ...c, seq: seq++ })), updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: new Date().toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    screenerWaiting: async () => ({ items: [], nextCursor: null, total: 0, inFlight: [] }),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: { mode: "full" } });
  const projector = createProjector();
  const state = { locale: "en", heldDeletes: NOHELD as ReadonlySet<string> };
  let last: unknown[] | null = null;
  let world: Projected | null = null;
  /* React's memo: a run when a dependency moved; the day moves on the clock's tick, read as `now`. */
  const render = (): Projected => {
    const now = new Date();
    const deps = [listStamp(engine), state.locale, state.heldDeletes, Math.floor(now.getTime() / DAY)];
    if (last === null || deps.some((d, i) => !Object.is(d, last![i]))) {
      last = deps;
      world = projector.project({
        engine, worldKey: "rig", standalone: false, bearer: null, images: "direct" as never, zone: "Europe/Zurich",
        locale: state.locale, now, foldersOn: false, foldersPending: false, foldersStorable: true, walker: null, searchWalker: null,
        openOffMirror: () => undefined, scopes: SCOPES, leavingWaiting: LEAVING, heldDeletes: state.heldDeletes, heldPlaces: PLACES,
        ownAddresses: OWN, posture: SCREENING_UNSUPPLIED, actions: {} as WorldActions, onPresented: () => undefined,
        account: () => ({ name: "rig", email: "" }), setFoldersEnabled: async () => true, folderSummary: async () => null,
        rememberResurfaceTime: () => undefined, signatures: null, resurfaceTime: null, screenerServer: null, relayed: null, mailboxes: null,
      } as unknown as ProjectionInputs);
    }
    return world!;
  };
  const arrive = (m: EngineMessage) => pages.push([create(m)]);
  return { engine, render, arrive, state };
}

const rows = (w: Projected) => [...w.ohbox.resurfaced, ...w.ohbox.fresh, ...w.ohbox.seen];
const ids = (w: Projected) => rows(w).flatMap((m) => m.memberIds ?? [m.id]);

afterEach(() => { vi.useRealTimers(); });

describe("every change reaches the rows through one kept projector", () => {
  it("an arrival, a read, a move, a held delete, a language switch and the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const r = rig([msg("i1", t0 - 30 * MIN), msg("i3", t0 - 2 * DAY)]);
    await r.engine.start();
    await r.engine.refreshScreenerWaiting();
    expect(ids(r.render())).toEqual(expect.arrayContaining(["i1", "i3"]));

    r.arrive(msg("i2", t0 - MIN));
    await r.engine.syncOnce();
    expect(ids(r.render()), "an arrival is not shown").toContain("i2");

    await r.engine.mutate({ kind: "mark_seen", messageIds: ["i2"], unread: false, via: "glance" });
    expect(rows(r.render()).find((m) => (m.memberIds ?? [m.id]).includes("i2"))?.unread, "a read is not shown").toBe(false);

    await r.engine.mutate({ kind: "move", messageId: "i1", folder: "Archive" as never });
    expect(ids(r.render()), "a move is not shown").not.toContain("i1");

    r.state.heldDeletes = new Set(["i2"]);
    expect(ids(r.render()), "a held delete is not shown").not.toContain("i2");
    r.state.heldDeletes = NOHELD;

    const en = rows(r.render()).find((m) => m.id === "i3")!.time;
    r.state.locale = "de";
    const de = rows(r.render()).find((m) => m.id === "i3")!.time;
    expect(de, "a language switch is not shown").not.toBe(en);
    r.state.locale = "en";

    const today = rows(r.render()).find((m) => m.id === "i2")!.time;
    expect(today).toMatch(/^\d\d:\d\d$/);
    vi.setSystemTime(t0 + DAY);
    expect(rows(r.render()).find((m) => m.id === "i2")!.time, "the next day is not shown").not.toBe(today);
  });
});

describe("the composer's address book is the web's, over this phone's mirror", () => {
  it("names who wrote, never the account's own address, and an arrival reaches it", async () => {
    const r = rig([
      msg("p1", Date.now() - DAY, { from: { name: "Persephone Lind", address: "Persephone@example.test" } }),
      msg("o1", Date.now() - DAY, { from: { name: "Me", address: "me@example.test" }, to: [{ name: null, address: "k@example.test" }] }),
    ]);
    await r.engine.start();
    const book = r.render().addressBook.map((e) => [e.address, e.name]);
    expect(book).toContainEqual(["persephone@example.test", "Persephone Lind"]);
    expect(book.map(([a]) => a), "the account's own address is suggested").not.toContain("me@example.test");

    r.arrive(msg("n1", Date.now(), { from: { name: "Nora Vale", address: "nora@example.test" } }));
    await r.engine.syncOnce();
    expect(r.render().addressBook.map((e) => e.address), "an arrival is not in the book").toContain("nora@example.test");
  });
});
