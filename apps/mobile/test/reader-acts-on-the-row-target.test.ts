import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, ohboxRows, triagePiles, type EngineAdapter, type EngineMessage, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { createProjector, type ProjectionInputs, type Projected } from "../src/state/world-projection";
import { closeRoutingSession, openRoutingSession } from "../src/state/held-routing";
import { SCREENING_UNSUPPLIED, liveActions, planHeldRouting, type ToastOpts, type WorldActions, type WorldMail } from "../src/state/live";
import { paneRouteFor } from "../src/ui/pane-routes";
import { readFaceOf } from "../src/ui/row-swipe";
import { derivePosture, type PostureInput } from "../src/ui/posture/derive";
import { scaffoldPlan } from "../src/ui/scaffold/plan";
import { withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE PHONE READER SHOWS AND ACTS ON THE MESSAGE ITS OHBOX ROW OPENED, decided once, at the press,
 * through the shipped projector and a real engine. `a1` is from Lena, unread, with a file. The press
 * asks the engine's row (`World.rowOpenTarget`) and hands the answer to the route or the pane; every
 * later mount of that open — the transition frame, the folded route, the unfolded pane, a turned
 * tablet — reads that id. Re-asking the row on a mount moved the reader to our own Sent reply or an
 * older member once Later, Set aside or Junk had taken `a1` out of its row (HIGH).
 * No React Native renderer runs here: the migrations' effects are read in source (the last block).
 */

const AT = Date.UTC(2026, 8, 20, 8, 0, 0);
const ME = { name: "Me", address: "me@example.test" };
const LENA = { name: "Lena", address: "lena@example.test" };

function msg(id: string, atMs: number, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
    from: LENA, to: [ME], cc: [], date: new Date(atMs).toISOString(), arrivedAt: new Date(atMs).toISOString(),
    folder: "INBOX", snippet: `the words of ${id}`, unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(atMs).toISOString(), ...over,
  } as EngineMessage;
}
const create = (type: string, id: string, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq: 1, updatedAt: new Date(AT).toISOString(), entity } as SyncChange);

const OURS = { from: ME, to: [LENA], folder: "Sent" as EngineMessage["folder"] };
const laterX2: Record<string, Partial<EngineMessage>> = {
  "our away answer": { ...OURS, autoReplyByUs: true },
  "our calendar acknowledgement": { ...OURS, subject: "Accepted: Q3 plan", itipReplyHeader: true },
  "our own reply": { ...OURS, subject: "Re: Q3 plan" },
  "a stranger's reply held in the Screener": { from: { name: "S", address: "s@elsewhere.test" }, folder: "ohmail/Screener" as EngineMessage["folder"] },
  "a member filed to Junk": { from: { name: "J", address: "j@elsewhere.test" }, folder: "ohmail/Quarantine" as EngineMessage["folder"] },
};
const rowA1 = () => msg("a1", AT, { unread: true, hasAttachments: true, attachmentCount: 1 });

/** Lena is a sender the account decided about, so her mail stands in the Ohbox (`domain`: through her domain's rule). */
const consent = (kind: "sender" | "domain" = "sender"): SyncChange => create("rule", "rule_lena", {
  id: "rule_lena", kind, match: kind === "sender" ? LENA.address : "example.test", destination: "INBOX", priority: 0, provenance: "seeded-from-sent",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(),
});

/** The provider, renderer-free: one engine, one projector, the inputs the app passes. */
async function phone(first: SyncChange[], rule = consent()) {
  let seq = 1000;
  const pages: SyncChange[][] = [[rule, ...first].map((c) => ({ ...c, seq: seq++ }))];
  const posted: string[] = [];
  /* The server's rows: a move or a triage write is answered with the row it left (the read-your-writes
     echo), a move spending its own pin, so a confirmed write stays on screen. */
  const rows = new Map(first.filter((c) => c.type === "message").map((c) => [c.id, c.entity as EngineMessage]));
  const echoOf = (m: { kind: string; messageId?: string; state?: string; folder?: string }): SyncChange[] => {
    const row = m.messageId === undefined ? undefined : rows.get(m.messageId);
    if (!row || (m.kind !== "move" && m.kind !== "triage_set")) return [];
    const at = new Date(AT).toISOString();
    const next = m.kind === "move"
      ? { ...row, folder: m.folder as EngineMessage["folder"], ...(row.triage?.state === "resurfaced" ? { triage: { ...row.triage, state: "none" } as never } : {}) }
      : { ...row, triage: { messageId: row.id, state: m.state, bubbleUpAt: null, setAt: at, updatedAt: at } as never };
    rows.set(row.id, next);
    return [{ ...create("message", row.id, next), seq: seq++ }];
  };
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: new Date(AT).toISOString(),
    }),
    mutate: async (m: { kind: string; messageId?: string; messageIds?: string[]; state?: string; unread?: boolean; folder?: string }) => {
      posted.push(`${m.kind}:${m.messageId ?? (m.messageIds ?? []).join(",")}${m.state ? `:${m.state}` : ""}${m.unread === true ? ":unread" : ""}`);
      return { ok: true as const, changes: echoOf(m) };
    },
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  const engine = new OhmailEngine({ adapter, store, storePolicy: { mode: "full" } });
  await engine.start();
  const projector = createProjector();
  const inputs = (): ProjectionInputs => ({
    engine, worldKey: "rig", standalone: false, bearer: null, images: "direct" as never, zone: "UTC", locale: "en",
    now: new Date(AT + 3_600_000), foldersOn: false, foldersPending: false, foldersStorable: true, walker: null, searchWalker: null,
    openOffMirror: () => undefined, scopes: {}, leavingWaiting: [], heldDeletes: new Set<string>(), heldPlaces: new Map() as never,
    ownAddresses: [ME.address], posture: SCREENING_UNSUPPLIED, actions: {} as WorldActions, onPresented: () => undefined,
    account: () => ({ name: "rig", email: "" }), setFoldersEnabled: async () => true, folderSummary: async () => null,
    rememberResurfaceTime: () => undefined, signatures: null, resurfaceTime: null, screenerServer: null, relayed: null, mailboxes: null,
  } as unknown as ProjectionInputs);
  const world = (): Projected => projector.project(inputs());
  /** Every Undo a press offered, newest last. */
  const offers: ToastOpts[] = [];
  const toast = (_m: unknown, o?: ToastOpts) => { if (o?.undo) offers.push(o); };
  const actions = liveActions({ engine, toast, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" });
  return { engine, store, world, actions, posted, offers };
}

/** The Ohbox row a press on `member`'s conversation is made on: its own id, which is its target. */
function rowOf(w: Projected, member: string): string | null {
  const rows: WorldMail[] = [...w.ohbox.resurfaced, ...w.ohbox.fresh, ...w.ohbox.seen];
  return rows.find((r) => r.id === member || (r.memberIds ?? []).includes(member))?.id ?? null;
}
/** The engine's own row for thread T, as the Ohbox folds it now. */
function threadRow(engine: OhmailEngine): { members: string[]; target: string } | null {
  const row = Object.values(ohboxRows(engine.read())).flat().find((r) => r.members.some((m) => m.threadId === "T"));
  return row ? { members: row.members.map((m) => m.id), target: row.openTarget.id } : null;
}

/** The reader's three verbs that take the opened message out of its row, as the reader calls them. */
const VERBS: Record<string, (p: Awaited<ReturnType<typeof phone>>, w: Projected, id: string) => Promise<unknown>> = {
  Later: (p, _w, id) => p.actions.pileToggle(id, "replyLater"),
  "Set aside": (p, _w, id) => p.actions.pileToggle(id, "setAside"),
  Junk: (p, w, id) => p.actions.move(w.message(id)!, "spam"),
};
const SETUPS: Record<string, () => SyncChange[]> = {
  "our own reply x2 newer than a1": () => [create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["our own reply"]))],
  "an older read a0 before a1": () => [create("message", "a0", msg("a0", AT - 3_600_000)), create("message", "a1", rowA1())],
};

/** A press on the Ohbox row holding `member`, as the Ohbox tab makes it: the id the open carries. */
function press(w: Projected, member: string): string {
  const row = rowOf(w, member);
  expect(row, `an Ohbox row holds ${member}`).not.toBeNull();
  return w.rowOpenTarget(row!);
}
/** What a reader mounted at `id` shows and acts on: the message its route or pane names. */
function mount(w: Projected, id: string): string {
  return w.message(id)?.id ?? "(nothing)";
}
/** Every mount an open makes as the window loses or gains its second pane, with the id each carries. */
function remounts(w: Projected, open: string): Record<string, string> {
  const unfold = paneRouteFor(w.message(open)!);
  return {
    "the transition frame as the pane goes": open,
    "the pushed route once folded": open,
    "the pane the route lands in once unfolded": unfold?.params.open ?? open,
  };
}
const shownAt = (w: Projected, ids: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(ids).map(([at, id]) => [at, mount(w, id)]));
const all = (ids: Record<string, string>, id: string): Record<string, string> =>
  Object.fromEntries(Object.keys(ids).map((at) => [at, id]));

describe("a conversation opened from its Ohbox row on the phone", () => {
  for (const [label, over] of Object.entries(laterX2)) {
    it(`with ${label} newer than a1, the press opens a1 and the reader shows and acts on a1`, async () => {
      const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, over))]);
      const w = p.world();
      const open = press(w, "a1");
      expect(open).toBe("a1");
      expect(mount(w, open)).toBe("a1");
    });
  }

  it("a Resurfaced conversation ending in our own reply: the reader is on the original, and its Done releases the pin", async () => {
    const pinnedAt = new Date(AT + 7_200_000).toISOString();
    const pin = { messageId: "a1", state: "resurfaced", bubbleUpAt: null, setAt: pinnedAt, updatedAt: pinnedAt };
    const p = await phone([
      create("message", "a1", msg("a1", AT, { hasAttachments: true, attachmentCount: 1, triage: pin as never })),
      create("message", "r2", msg("r2", AT + 3_600_000, laterX2["our own reply"])),
    ]);
    const w = p.world();
    expect(w.ohbox.resurfaced.map((r) => r.id), "the Resurfaced row opens at its focus").toEqual(["a1"]);
    const shown = mount(w, press(w, "a1"));
    expect(shown).toBe("a1");
    expect(w.message(shown)?.pile, "Done is offered on what the reader shows").toBe("resurfaced");
    await p.actions.resurfaceDone(shown);
    expect(p.world().ohbox.resurfaced, "Done in the reader left the conversation Resurfaced").toEqual([]);
  });

  /** The letter and our own reply, both pinned: a conversation Resurface booked whole, back. */
  const bothPinned = () => {
    const pinnedAt = new Date(AT + 7_200_000).toISOString();
    const pin = (id: string) => ({ messageId: id, state: "resurfaced", bubbleUpAt: null, setAt: pinnedAt, updatedAt: pinnedAt }) as never;
    return phone([
      create("message", "a1", msg("a1", AT, { triage: pin("a1") })),
      create("message", "r2", msg("r2", AT + 3_600_000, { ...laterX2["our own reply"], triage: pin("r2") })),
    ]);
  };
  it("the letter and our reply both pinned: the reader's Done releases both, and the row leaves", async () => {
    const p = await bothPinned();
    const w = p.world();
    await p.actions.resurfaceDone(mount(w, press(w, "a1")));
    expect(p.posted).toEqual(["mark_seen:a1,r2"]);
    expect(p.world().ohbox.resurfaced).toEqual([]);
  });
  it("the letter and our reply both pinned: the row swipe's Done, with its members, spends our reply's pin too", async () => {
    const p = await bothPinned();
    const row = p.world().ohbox.resurfaced[0]!;
    await p.actions.resurfaceDone(row.id, row.memberIds);
    expect(p.posted).toEqual(["mark_seen:a1,r2"]);
    expect(p.world().ohbox.resurfaced).toEqual([]);
  });
  it("the letter and our reply both pinned: the row swipe's Junk moves the letter and spends our reply's pin", async () => {
    const p = await bothPinned();
    const row = p.world().ohbox.resurfaced[0]!;
    expect(await p.actions.move(row, "spam", row.memberIds)).toBe(true);
    expect(p.posted).toContain("triage_set:r2:none");
    expect(p.posted.some((x) => x.startsWith("move:r2")), "our reply stays where it is").toBe(false);
    expect(p.world().ohbox.resurfaced).toEqual([]);
  });
  it("the letter and our reply both pinned: deleting the letter spends our reply's pin", async () => {
    const p = await bothPinned();
    expect(await p.actions.deleteMessage("a1", { quiet: true })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.posted).toEqual(["message_delete:a1", "triage_set:r2:none"]);
    expect(p.world().ohbox.resurfaced).toEqual([]);
  });
  it("the letter and our reply both pinned: the sheet's Move it too files the letter and spends our reply's pin", async () => {
    const p = await bothPinned();
    expect(await p.actions.moveStayed(["a1"], "receipts")).toBe(true);
    for (let i = 0; i < 20 && p.posted.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    expect(p.posted).toEqual(["move:a1", "triage_set:r2:none"]);
    expect(p.world().ohbox.resurfaced).toEqual([]);
  });
  it("CONTROL: one pin, our reply unpinned: Junk spends nothing more", async () => {
    const pinnedAt = new Date(AT + 7_200_000).toISOString();
    const p = await phone([
      create("message", "a1", msg("a1", AT, { triage: { messageId: "a1", state: "resurfaced", bubbleUpAt: null, setAt: pinnedAt, updatedAt: pinnedAt } as never })),
      create("message", "r2", msg("r2", AT + 3_600_000, laterX2["our own reply"])),
    ]);
    const row = p.world().ohbox.resurfaced[0]!;
    await p.actions.move(row, "spam", row.memberIds);
    expect(p.posted.filter((x) => x.startsWith("triage_set"))).toEqual([]);
  });

  it("the reader reads a2 and the row's own target stays on it while the older a1 waits: every remount stays on a2", async () => {
    const p = await phone([create("message", "a1", rowA1()), create("message", "a2", msg("a2", AT + 3_600_000, { unread: true }))]);
    const open = press(p.world(), "a2");
    expect(open).toBe("a2");
    await p.actions.openMessage(open);
    await p.actions.markGlanced([open]);   // the reader's rule, with a2 on screen
    expect(threadRow(p.engine)?.target, "the row stands for its newest").toBe("a2");
    const w1 = p.world();
    expect(shownAt(w1, remounts(w1, open))).toEqual(all(remounts(w1, open), "a2"));
  });

  /** The four-message reopen case: a reopen opened the newest UNREAD member (t3) and read it unseen. */
  it("four members: the first press and every press after the newest is read open t4", async () => {
    const p = await phone([1, 2, 3, 4].map((i) => create("message", `t${i}`, msg(`t${i}`, AT + i * 60_000, { unread: true }))));
    const open = press(p.world(), "t1");
    expect(open, "the first press").toBe("t4");
    await p.actions.openMessage(open);
    await p.actions.markGlanced([open]);
    p.actions.leaveMessage(open);
    expect(press(p.world(), "t1"), "the press after t4 is read").toBe("t4");
    expect(threadRow(p.engine)?.target).toBe("t4");
  });

  it("the press's answer for a message its row does not hold is the row's own target", async () => {
    const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["our away answer"]))]);
    const w = p.world();
    expect(w.rowOpenTarget("x2")).toBe("a1");
    expect(w.rowOpenTarget("nowhere"), "a message nothing holds answers itself").toBe("nowhere");
  });

  it("a held message answers itself: its place is the gate or Junk, never the row it was threaded into", async () => {
    for (const label of ["a stranger's reply held in the Screener", "a member filed to Junk"]) {
      const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2[label]))]);
      expect(p.world().rowOpenTarget("x2"), label).toBe("x2");
    }
  });
});

describe("the shown message is decided once per open: every remount after the row changed shows it", () => {
  for (const [setup, make] of Object.entries(SETUPS)) {
    for (const [verb, act] of Object.entries(VERBS)) {
      it(`${setup}: a press opens a1, ${verb} in the reader, then every mount a fold or an unfold makes`, async () => {
        const p = await phone(make());
        const w0 = p.world();
        const open = press(w0, "a1");
        expect(open).toBe("a1");
        await p.actions.openMessage(open);
        await act(p, w0, open);
        const w1 = p.world();
        const row = threadRow(p.engine);
        // Set aside parks the whole row (a0 with a1), so no row is left to ask.
        expect(row?.members.includes("a1") ?? false, "the premise: the verb took a1 out of its row").toBe(false);
        expect(row?.target, "the premise: asked again, the row would open at another member").not.toBe("a1");
        expect(shownAt(w1, remounts(w1, open))).toEqual(all(remounts(w1, open), "a1"));
      });
    }
  }

  it("a small tablet turned across the two-pane threshold: the turn's mounts show a1", async () => {
    const shape = (width: number, height: number): PostureInput =>
      ({ platform: "android", width, height, folds: null, hasFold: false, isPad: false, windowBounds: null });
    const panes = (s: PostureInput) => scaffoldPlan(derivePosture(s), s.platform).panes;
    expect([panes(shape(960, 600)), panes(shape(600, 960))], "the premise: the turn crosses the threshold").toEqual([2, 1]);
    const p = await phone(SETUPS["our own reply x2 newer than a1"]!());
    const w0 = p.world();
    const open = press(w0, "a1");
    await p.actions.openMessage(open);
    await VERBS.Later!(p, w0, open);
    const w1 = p.world();
    expect(shownAt(w1, remounts(w1, open))).toEqual(all(remounts(w1, open), "a1"));
  });
});

describe("an open that is not a row press shows the message it names", () => {
  it("a deep link carrying ?as=conversation shows the linked message", async () => {
    const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["a member filed to Junk"]))]);
    const w = p.world();
    expect(threadRow(p.engine), "the premise: x2's conversation opens at a1, without x2").toEqual({ members: ["a1"], target: "a1" });
    const link = { id: "x2", as: "conversation" };
    expect(mount(w, link.id)).toBe("x2");
    expect(routeParams("app/message/[id].tsx"), "the route reads nothing from the link but its id").toEqual(["id"]);
  });

  it("CONTROL: a search hit or a plain link shows itself", async () => {
    const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["a member filed to Junk"]))]);
    const w = p.world();
    expect(mount(w, "x2")).toBe("x2");
    expect(mount(w, "a1")).toBe("a1");
  });
});

describe("an answered conversation, all read: the row stands for the letter", () => {
  const answered = () => [create("message", "a1", msg("a1", AT)), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["our own reply"]))];

  it("the row's id and its open target are the letter; the row still wears our reply", async () => {
    const p = await phone(answered());
    const w = p.world();
    const rows: WorldMail[] = [...w.ohbox.resurfaced, ...w.ohbox.fresh, ...w.ohbox.seen];
    const row = rows.find((r) => r.id === "a1" || (r.memberIds ?? []).includes("a1"));
    expect(row?.id).toBe("a1");
    expect(w.rowOpenTarget(row!.id)).toBe("a1");
    expect(threadRow(p.engine)?.target).toBe("a1");
  });

  // Later and Set aside (Park) take the whole row, our reply too, so the row leaves the Ohbox;
  // the pile holds it as one row facing the letter.
  for (const [verb, ids, pile] of [
    ["Later", ["a1", "x2"], "replyLater"],
    ["Set aside", ["a1", "x2"], "setAside"],
    ["Junk", null, null],
  ] as const) {
    it(`the reader's ${verb}, pressed on what the row opened, acts on ${ids?.length === 2 ? "the row" : "the letter"}`, async () => {
      const p = await phone(answered());
      const w0 = p.world();
      const open = press(w0, "a1");
      await p.actions.openMessage(open);
      p.posted.length = 0;
      await VERBS[verb]!(p, w0, open);
      if (pile) {
        const state = pile === "replyLater" ? "reply_later" : "set_aside";
        expect([...p.posted].sort()).toEqual(ids!.map((id) => `triage_set:${id}:${state}`));
        expect(triagePiles(p.engine.read())[pile].map((e) => [e.messageId, [...(e.memberIds ?? [])].sort()])).toEqual([["a1", [...ids!]]]);
      } else {
        expect(p.posted.some((x) => x.includes("x2")), `nothing acts on our reply: ${p.posted.join(" ")}`).toBe(false);
        expect(p.posted.some((x) => x.includes("a1")), `the letter moved: ${p.posted.join(" ")}`).toBe(true);
      }
    });
  }

  it("the row draws the letter's tags, not our reply's, as the web row does", async () => {
    const tag = create("tag", "tag_1", { id: "tag_1", name: "Keepme", hue: "blue", createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString() });
    for (const [on, want] of [["a1", ["Keepme"]], ["x2", []]] as const) {
      const p = await phone([
        tag,
        create("message", "a1", msg("a1", AT, { labels: on === "a1" ? ["tag_1"] : [] })),
        create("message", "x2", msg("x2", AT + 3_600_000, { ...laterX2["our own reply"], labels: on === "x2" ? ["tag_1"] : [] })),
      ]);
      const row = [...p.world().ohbox.fresh, ...p.world().ohbox.seen].find((r) => (r.memberIds ?? []).includes("a1"))!;
      expect((row.tags ?? []).map((t) => t.name), `the tag on ${on}`).toEqual(want);
    }
  });

  it("the row's swipe Later, with its members, files the row, our reply too", async () => {
    const p = await phone(answered());
    const w = p.world();
    const row = [...w.ohbox.fresh, ...w.ohbox.seen].find((r) => (r.memberIds ?? []).includes("a1"))!;
    await p.actions.pileToggle(row.id, "replyLater", row.memberIds);
    expect([...p.posted].sort()).toEqual(["triage_set:a1:reply_later", "triage_set:x2:reply_later"]);
    expect([...p.world().ohbox.fresh, ...p.world().ohbox.seen], "the row left the Ohbox").toEqual([]);
  });
});

describe("an answered conversation marked unread from its row still stands for the letter", () => {
  const ours = laterX2["our own reply"];
  const rowHolding = (w: Projected, member: string): WorldMail => {
    const row = [...w.ohbox.resurfaced, ...w.ohbox.fresh, ...w.ohbox.seen].find((r) => r.id === member || (r.memberIds ?? []).includes(member));
    expect(row, `an Ohbox row holds ${member}`).toBeTruthy();
    return row!;
  };
  /** The row's read slot as MailRow presses it: the verb its sheet shows, over the row's members. */
  const swipeReadSlot = async (p: Awaited<ReturnType<typeof phone>>, row: WorldMail): Promise<void> => {
    const face = readFaceOf({ pile: row.pile ?? null, unread: !!row.unread });
    await p.actions.markRowSeen(row.id, face === "markUnread", row.memberIds);
  };
  /** The press, the open, and the reader's Later: what it posts and what the Reply Run then lists. */
  const pressThenLater = async (p: Awaited<ReturnType<typeof phone>>): Promise<{ open: string; posted: string[]; pile: Array<string | undefined> }> => {
    const w = p.world();
    const open = press(w, "a1");
    await p.actions.openMessage(open);
    p.posted.length = 0;
    await VERBS.Later!(p, w, open);
    return { open, posted: [...p.posted].sort(), pile: triagePiles(p.engine.read()).replyLater.map((e) => e.messageId) };
  };

  it("the swipe's Mark unread marks the letter alone; the press opens the letter and the reader's Later files the row", async () => {
    const p = await phone([create("message", "a1", msg("a1", AT)), create("message", "x2", msg("x2", AT + 3_600_000, ours))]);
    const row = rowHolding(p.world(), "a1");
    expect(readFaceOf({ pile: row.pile ?? null, unread: !!row.unread }), "the premise: the all-read row's read slot").toBe("markUnread");
    await swipeReadSlot(p, row);
    expect(p.posted, "our own reply stays read").toEqual(["mark_seen:a1:unread"]);
    expect(rowHolding(p.world(), "a1").id).toBe("a1");
    expect(await pressThenLater(p)).toEqual({ open: "a1", posted: ["triage_set:a1:reply_later", "triage_set:x2:reply_later"], pile: ["a1"] });
  });

  it("our reply left unread beside the read letter (an earlier Mark unread): the press opens the letter and Later files the row", async () => {
    const p = await phone([create("message", "a1", msg("a1", AT)), create("message", "x2", msg("x2", AT + 3_600_000, { ...ours, unread: true }))]);
    expect(rowHolding(p.world(), "a1").id).toBe("a1");
    expect(await pressThenLater(p)).toEqual({ open: "a1", posted: ["triage_set:a1:reply_later", "triage_set:x2:reply_later"], pile: ["a1"] });
  });

  it("the letter and our reply both unread (as another device's Mark unread left them): the letter", async () => {
    const p = await phone([create("message", "a1", msg("a1", AT, { unread: true })), create("message", "x2", msg("x2", AT + 3_600_000, { ...ours, unread: true }))]);
    expect(rowHolding(p.world(), "a1").id).toBe("a1");
    expect(await pressThenLater(p)).toEqual({ open: "a1", posted: ["triage_set:a1:reply_later", "triage_set:x2:reply_later"], pile: ["a1"] });
  });

  it("CONTROL: the read slot's Mark read still marks every member, our reply included", async () => {
    const p = await phone([create("message", "a1", msg("a1", AT, { unread: true })), create("message", "x2", msg("x2", AT + 3_600_000, { ...ours, unread: true }))]);
    const row = rowHolding(p.world(), "a1");
    expect(readFaceOf({ pile: row.pile ?? null, unread: !!row.unread }), "the premise: the unread row's read slot").toBe("markRead");
    await swipeReadSlot(p, row);
    expect(p.posted).toHaveLength(1);
    const [kind, ids, direction] = p.posted[0]!.split(":");
    expect([kind, ids!.split(",").sort(), direction]).toEqual(["mark_seen", ["a1", "x2"], undefined]);
  });
});

describe("Answer later, Parked and Resurface hold a conversation as one row", () => {
  const IDS = ["m1", "m2", "m3", "m4", "m5", "m6", "x7"];
  const filedAt = new Date(AT).toISOString();
  const seven = (state: string) => IDS.map((id, i) => create("message", id, msg(id, AT + i * 60_000, {
    ...(id === "x7" ? laterX2["our own reply"] : {}),
    triage: { messageId: id, state, bubbleUpAt: null, setAt: filedAt, updatedAt: filedAt } as EngineMessage["triage"],
  })));
  const pile = (w: Projected, kind: string) => w.piles.find((p) => p.kind === kind)!.items;

  it("a parked seven-message conversation is one item, carrying every id; the More count and the meta say 1", async () => {
    const p = await phone(seven("set_aside"));
    const w = p.world();
    expect(pile(w, "setAside").map((i) => [i.messageId, i.memberIds])).toEqual([["m6", ["x7", "m6", "m5", "m4", "m3", "m2", "m1"]]]);
    expect(w.pilesMeta).toBe("1 item");
  });

  it("a booked seven-message conversation is one Resurface item, carrying every id", async () => {
    const w = (await phone(seven("bubbled_up"))).world();
    expect(pile(w, "resurface").map((i) => [i.messageId, i.memberIds])).toEqual([["m6", ["x7", "m6", "m5", "m4", "m3", "m2", "m1"]]]);
    expect(w.pilesMeta).toBe("1 item");
  });

  it("the reader's Park on the parked row takes all seven out; Later moves all seven; Resurface Now brings all seven back", async () => {
    for (const [verb, state] of [["setAside", "none"], ["replyLater", "reply_later"]] as const) {
      const p = await phone(seven("set_aside"));
      await p.actions.pileToggle("m6", verb);
      expect([...p.posted].sort()).toEqual(IDS.map((id) => `triage_set:${id}:${state}`));
    }
    const p = await phone(seven("reply_later"));
    await p.actions.resurfaceNow("m3");
    expect([...p.posted].sort()).toEqual(IDS.map((id) => `triage_set:${id}:resurfaced`));
  });

  const triaged = (p: Awaited<ReturnType<typeof phone>>, state: string) =>
    p.posted.filter((x) => x.startsWith("triage_set:") && x.endsWith(`:${state}`)).sort();
  /** Filed m6, and every other pin of the row spent beside it, my reply's too. */
  const spentBeside = async (p: Awaited<ReturnType<typeof phone>>): Promise<void> => {
    for (let i = 0; i < 20 && triaged(p, "none").length < 6; i++) await new Promise((r) => setTimeout(r, 0));
    expect(p.posted.filter((x) => x.startsWith("move:"))).toEqual(["move:m6"]);
    expect(triaged(p, "none")).toEqual(IDS.filter((id) => id !== "m6").map((id) => `triage_set:${id}:none`));
    expect(p.world().ohbox.resurfaced).toEqual([]);
  };

  it("a booked seven back pinned whole: the sheet's Receipts files the letter and spends every other pin; its Undo puts every pin back", async () => {
    const p = await phone(seven("resurfaced"));
    // The window `world.tsx` opens, long enough that the press is still held at the Undo.
    openRoutingSession({ windowMs: 60_000, journal: p.store, plan: (i) => planHeldRouting(p.engine.read(), i), dispatch: async () => true });
    try {
      expect(await p.actions.screenSender("m6", "receipts", "sender")).toBe(true);
      await spentBeside(p);
      p.offers.at(-1)!.undo!();
      for (let i = 0; i < 20 && triaged(p, "resurfaced").length < 7; i++) await new Promise((r) => setTimeout(r, 0));
      expect(triaged(p, "resurfaced")).toEqual(IDS.map((id) => `triage_set:${id}:resurfaced`));
      expect(p.world().ohbox.resurfaced.map((r) => r.id)).toEqual(["m6"]);
    } finally { closeRoutingSession(); }
  });

  it("a booked seven back pinned whole, let in by Lena's domain: the sheet's Receipts for the domain, sent at once, spends every other pin too", async () => {
    const p = await phone(seven("resurfaced"), consent("domain"));
    expect(await p.actions.screenSender("m6", "receipts", "domain")).toBe(true);
    await spentBeside(p);
  });

  it("a booked seven back pinned whole, Lena let in at the gate and a newer letter of hers waiting there: the sheet's Receipts decides her, files the letter and spends every other pin", async () => {
    const someoneElse = create("rule", "rule_other", {
      id: "rule_other", kind: "sender", match: "someone@else.test", destination: "INBOX", priority: 0, provenance: "seeded-from-sent",
      enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: filedAt, updatedAt: filedAt,
    });
    const admitted = seven("resurfaced").map((c) => (c.id === "x7" ? c : { ...c, entity: { ...(c.entity as EngineMessage), placeDecided: true } }));
    const waiting = create("message", "k8", msg("k8", AT + 30 * 60_000, { threadId: "K", subject: "Another thing", folder: "ohmail/Screener" as EngineMessage["folder"], unread: true }));
    const p = await phone([...admitted, waiting], someoneElse);
    expect(await p.actions.screenSender("m6", "receipts", "sender")).toBe(true);
    await spentBeside(p);
  });

  it("a booked seven back pinned whole: the row's move to Receipts files its letters and spends my reply's pin; its Undo puts every pin back once", async () => {
    const p = await phone(seven("resurfaced"));
    openRoutingSession({ windowMs: 60_000, journal: p.store, plan: (i) => planHeldRouting(p.engine.read(), i), dispatch: async () => true });
    try {
      const row = p.world().ohbox.resurfaced[0]!;
      expect(await p.actions.move(row, "receipts", row.memberIds)).toBe(true);
      for (let i = 0; i < 20 && triaged(p, "none").length < 1; i++) await new Promise((r) => setTimeout(r, 0));
      expect(p.posted.filter((x) => x.startsWith("move:")).sort()).toEqual(IDS.filter((id) => id !== "x7").map((id) => `move:${id}`));
      expect(triaged(p, "none")).toEqual(["triage_set:x7:none"]);
      expect(p.world().ohbox.resurfaced).toEqual([]);
      p.offers.at(-1)!.undo!();
      for (let i = 0; i < 20 && triaged(p, "resurfaced").length < 7; i++) await new Promise((r) => setTimeout(r, 0));
      expect(triaged(p, "resurfaced")).toEqual(IDS.map((id) => `triage_set:${id}:resurfaced`));
      expect(p.world().ohbox.resurfaced.map((r) => r.id)).toEqual(["m6"]);
    } finally { closeRoutingSession(); }
  });
});

/* ── the wiring, read in source: the row is asked at the press, and a link carries only an id ── */
const MOBILE = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => readFileSync(`${MOBILE}${rel}`, "utf8");
function sourcesUnder(dir: string): string[] {
  return (readdirSync(`${MOBILE}${dir}`, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `${dir}/${f}`);
}
/** The params a screen reads from its URL: the keys of every `useLocalSearchParams<{…}>()` it calls. */
function routeParams(rel: string): string[] {
  const src = withoutComments(read(rel));
  const calls = [...src.matchAll(/useLocalSearchParams\s*[<(]/g)].length;
  const typed = [...src.matchAll(/useLocalSearchParams\s*<\s*\{([^}]*)\}\s*>\s*\(/g)];
  expect(typed.length, `${rel}: every useLocalSearchParams call names its params`).toBe(calls);
  return typed.flatMap((m) => [...m[1]!.matchAll(/(\w+)\??\s*:/g)].map((k) => k[1]!));
}

describe("the row is asked at the press and nowhere else", () => {
  it("one call in the screens and the reader: the Ohbox tab's row press", () => {
    const UI = ["app", "src/ui"].flatMap(sourcesUnder);
    expect(UI.length, "the census reads the screens and the reader").toBeGreaterThan(50);
    const asked = UI.flatMap((f) => {
      const n = [...withoutCommentsAndLiterals(read(f)).matchAll(/\b(?:liveR|r)owOpenTarget\s*\(/g)].length;
      return n > 0 ? [[f, n]] : [];
    });
    expect(asked, "a mount, a fold or an unfold that asks the row again moves the reader").toEqual([["app/(tabs)/index.tsx", 1]]);
    expect(withoutCommentsAndLiterals(read("app/(tabs)/index.tsx"))).toMatch(/openRow\(\s*w\.rowOpenTarget\(\s*m\.id\s*\)\s*\)/);
  });

  it("the message route reads only its id; CONTROL: a list reads its own open param", () => {
    expect(routeParams("app/message/[id].tsx")).toEqual(["id"]);
    expect(routeParams("src/ui/list-detail.tsx")).toEqual(["open"]);
  });
});
