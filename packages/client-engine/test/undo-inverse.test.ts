import { describe, expect, it } from "vitest";
import { MemoryMirrorStore } from "../src/store.js";
import { inverseMutations, UNDO_CLASS } from "../src/undo.js";
import { mutationEffects } from "../src/mutations.js";
import {
  MUTATION_KINDS,
  type EngineMessage,
  type EngineMutation,
  type MessageStateDTO,
  type MutationKind,
} from "../src/types.js";

/**
 * THE VERB-UNDO CENSUS (the 0.20 review's undo finding). Every mutation kind is driven
 * through `inverseMutations` over a mirror where its target RESOLVES and the press CHANGES
 * state; the answer must be non-empty exactly for the kinds `UNDO_CLASS` declares "inverse".
 * A verb added without an undo arm cannot pass: the `Record` forces a class at compile time
 * and this census refuses an "inverse" kind whose arm answers nothing — "a mis-key silently
 * moves mail" made unrepresentable. The behavior half round-trips each inverse through
 * `mutationEffects` and asserts the visible fields come back.
 */

const NOW = new Date("2026-09-19T12:00:00.000Z");
const CTX = { now: () => NOW, uuid: () => "u-undo" };
const iso = NOW.toISOString();

function msg(id: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb-1",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    date: iso,
    folder: "INBOX",
    snippet: "snippet",
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: iso,
    ...over,
  };
}

const pin = (messageId: string, state: MessageStateDTO["state"], bubbleUpAt: string | null = null): MessageStateDTO =>
  ({ messageId, state, bubbleUpAt, setAt: iso, updatedAt: iso });

async function seeded(rows: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  for (const r of rows) await store.putLocal("message", r.id, r);
  return store;
}

describe("the undo census — every kind classified, every 'inverse' kind answers", () => {
  it("non-empty inverse exactly for the kinds classified 'inverse'", async () => {
    const reader = await seeded([
      msg("m1"), // INBOX, unread, no labels, no triage — every inverse kind can change it
    ]);
    /* One resolvable, state-changing mutation per kind. `Record` means a NEW kind does not
       compile until it appears here AND in UNDO_CLASS — the census interrogates it from birth. */
    const DRIVE: Record<MutationKind, EngineMutation> = {
      move: { kind: "move", messageId: "m1", folder: "ohmail/Screened" },
      message_delete: { kind: "message_delete", messageId: "m1" },
      triage_set: { kind: "triage_set", messageId: "m1", state: "reply_later" },
      screener_decide: { kind: "screener_decide", senderId: "m1", decision: "yes" },
      tag_assign: { kind: "tag_assign", messageId: "m1", tagId: "t2", assigned: true },
      tag_create: { kind: "tag_create", tagId: "tx", name: "X" },
      tag_rename: { kind: "tag_rename", tagId: "t1", name: "Y" },
      tag_recolor: { kind: "tag_recolor", tagId: "t1", hue: "moss" },
      tag_delete: { kind: "tag_delete", tagId: "t1" },
      folder_create: { kind: "folder_create", folderId: "f9", mailboxId: "mb-1", name: "N" },
      folder_rename: { kind: "folder_rename", folderId: "f1", name: "Renamed" },
      folder_delete: { kind: "folder_delete", folderId: "f1" },
      folder_op_dismiss: { kind: "folder_op_dismiss", folderId: "f1" },
      feed_mark_seen: { kind: "feed_mark_seen", view: "reads" },
      mark_seen: { kind: "mark_seen", messageIds: ["m1"], unread: false },
      mail_send: { kind: "mail_send", inReplyTo: null, body: "hi", to: [{ name: null, address: "a@b.test" }], mailboxId: "mb-1" },
      draft_accept: { kind: "draft_accept", draftId: "d1" },
      draft_schedule_cancel: { kind: "draft_schedule_cancel", draftId: "d1" },
      draft_save: { kind: "draft_save", draftId: "d1", subject: "s", body: "b", to: [], cc: [], bcc: [] },
      draft_discard: { kind: "draft_discard", draftId: "d1" },
      draft_resolve: { kind: "draft_resolve", draftId: "d1", outcome: "arrived" },
      rule_delete: { kind: "rule_delete", ruleId: "r1" },
      rule_update: { kind: "rule_update", ruleId: "r1", destination: "INBOX" },
      rule_create: { kind: "rule_create", ruleKind: "sender", match: "a@b.test", destination: "INBOX" },
    };
    for (const kind of MUTATION_KINDS) {
      const inverse = inverseMutations(reader, DRIVE[kind]);
      if (UNDO_CLASS[kind] === "inverse") {
        expect(inverse.length, `'${kind}' is classified 'inverse' but its arm answered nothing`).toBeGreaterThan(0);
      } else {
        expect(inverse, `'${kind}' is classified '${UNDO_CLASS[kind]}' yet built an inverse`).toEqual([]);
      }
    }
  });
});

/** Apply a mutation's local effects, so a round-trip can be read off the store. */
async function apply(store: MemoryMirrorStore, m: EngineMutation): Promise<void> {
  for (const fx of mutationEffects(store, m, CTX)) {
    await store.putLocal(fx.type, fx.id, fx.entity);
  }
}

const visible = (store: MemoryMirrorStore, id: string) => {
  const row = store.get<EngineMessage>("message", id)!;
  return {
    folder: row.folder, unread: row.unread, labels: row.labels, triage: row.triage?.state ?? null,
    // The row's place in Earlier: an Undo that loses either stamp moves the row.
    openReadAt: row.openReadAt ?? null, lastReadAt: row.lastReadAt ?? null,
  };
};

describe("move", () => {
  it("moves back to the folder the row was in", async () => {
    const reader = await seeded([msg("m1")]);
    const inv = inverseMutations(reader, { kind: "move", messageId: "m1", folder: "ohmail/Screened" });
    expect(inv).toEqual([{ kind: "move", messageId: "m1", folder: "INBOX" }]);
  });

  it("a rule press's move is taken back as that press's (`pressRule`): no correction of the route", async () => {
    const reader = await seeded([msg("m1")]);
    expect(inverseMutations(reader, { kind: "move", messageId: "m1", folder: "ohmail/Receipts", pressRule: true }))
      .toEqual([{ kind: "move", messageId: "m1", folder: "INBOX", pressRule: true }]);
  });

  it("a move that changes nothing offers nothing", async () => {
    const reader = await seeded([msg("m1")]);
    expect(inverseMutations(reader, { kind: "move", messageId: "m1", folder: "INBOX" })).toEqual([]);
    expect(inverseMutations(reader, { kind: "move", messageId: "ghost", folder: "INBOX" })).toEqual([]);
  });

  it("re-pins a resurfaced row AFTER the move back — the pin the move spent", async () => {
    const reader = await seeded([msg("m1", { triage: pin("m1", "resurfaced") })]);
    const inv = inverseMutations(reader, { kind: "move", messageId: "m1", folder: "ohmail/Screened" });
    expect(inv).toEqual([
      { kind: "move", messageId: "m1", folder: "INBOX" },
      { kind: "triage_set", messageId: "m1", state: "resurfaced" },
    ]);
  });

  it("a pinned letter of a Resurfaced row: the row's other pins go back up after the move back, our reply's too", async () => {
    const T = { threadId: "T" };
    const reader = await seeded([
      msg("m1", { ...T, triage: pin("m1", "resurfaced") }),
      msg("m2", { ...T, triage: pin("m2", "resurfaced") }),
      msg("r3", { ...T, folder: "Sent" as EngineMessage["folder"], triage: pin("r3", "resurfaced") }),
      msg("b4", { ...T, triage: pin("b4", "bubbled_up", "2026-09-26T09:00:00.000Z") }),
    ]);
    const inv = inverseMutations(reader, { kind: "move", messageId: "m1", folder: "ohmail/Receipts" });
    expect(inv.slice(0, 2)).toEqual([
      { kind: "move", messageId: "m1", folder: "INBOX" },
      { kind: "triage_set", messageId: "m1", state: "resurfaced" },
    ]);
    expect(inv.slice(2).map((mu) => (mu.kind === "triage_set" ? `${mu.messageId}:${mu.state}` : mu.kind)).sort(), "a booking is never spent")
      .toEqual(["m2:resurfaced", "r3:resurfaced"]);
    // Any place but the Ohbox takes the row; a letter moved back into the Ohbox goes back up alone.
    expect(inverseMutations(reader, { kind: "move", messageId: "m1", folder: "Archive" as EngineMessage["folder"] }).length).toBe(4);
    const filed = await seeded([msg("m1", { ...T, folder: "ohmail/Receipts", triage: pin("m1", "resurfaced") }), msg("m2", { ...T, triage: pin("m2", "resurfaced") })]);
    expect(inverseMutations(filed, { kind: "move", messageId: "m1", folder: "INBOX" })).toEqual([
      { kind: "move", messageId: "m1", folder: "ohmail/Receipts" },
      { kind: "triage_set", messageId: "m1", state: "resurfaced" },
    ]);
  });

  it("round-trips through the real effects", async () => {
    const store = await seeded([msg("m1", { triage: pin("m1", "resurfaced") })]);
    const before = visible(store, "m1");
    const m: EngineMutation = { kind: "move", messageId: "m1", folder: "ohmail/Screened" };
    const inv = inverseMutations(store, m);
    await apply(store, m);
    for (const u of inv) await apply(store, u);
    expect(visible(store, "m1")).toEqual(before);
  });
});

describe("triage_set", () => {
  it("a row with no pile state goes back to none", async () => {
    const reader = await seeded([msg("m1")]);
    expect(inverseMutations(reader, { kind: "triage_set", messageId: "m1", state: "reply_later" }))
      .toEqual([{ kind: "triage_set", messageId: "m1", state: "none" }]);
  });

  it("a parked row goes back to its pile; a booking keeps its own date", async () => {
    const when = "2026-09-26T09:00:00.000Z";
    const reader = await seeded([
      msg("m1", { triage: pin("m1", "set_aside") }),
      msg("m2", { triage: pin("m2", "bubbled_up", when) }),
      msg("m3", { triage: pin("m3", "resurfaced") }),
    ]);
    expect(inverseMutations(reader, { kind: "triage_set", messageId: "m1", state: "none" }))
      .toEqual([{ kind: "triage_set", messageId: "m1", state: "set_aside" }]);
    expect(inverseMutations(reader, { kind: "triage_set", messageId: "m2", state: "none" }))
      .toEqual([{ kind: "triage_set", messageId: "m2", state: "bubbled_up", bubbleUpAt: when }]);
    /* `resurfaced` takes no `bubbleUpAt` — the server forces it null; the key must be absent. */
    const inv = inverseMutations(reader, { kind: "triage_set", messageId: "m3", state: "none" });
    expect(inv).toEqual([{ kind: "triage_set", messageId: "m3", state: "resurfaced" }]);
    expect("bubbleUpAt" in inv[0]!).toBe(false);
  });

  it("a row in Earlier with an open read carries it back on the Undo; no other inverse does", async () => {
    const read = "2026-09-19T11:00:00.000Z";
    const reader = await seeded([
      msg("m1", { unread: false, openReadAt: read }),
      msg("m2", { unread: false, openReadAt: null }),
      msg("m3", { unread: false, openReadAt: read, triage: pin("m3", "set_aside") }),
    ]);
    expect(inverseMutations(reader, { kind: "triage_set", messageId: "m1", state: "set_aside" }))
      .toEqual([{ kind: "triage_set", messageId: "m1", state: "none", restoreOpenReadAt: read }]);
    expect(inverseMutations(reader, { kind: "triage_set", messageId: "m2", state: "set_aside" })[0]!)
      .not.toHaveProperty("restoreOpenReadAt");
    expect(inverseMutations(reader, { kind: "triage_set", messageId: "m3", state: "none" })[0]!)
      .not.toHaveProperty("restoreOpenReadAt");
  });

  for (const state of ["set_aside", "reply_later", "muted", "resurfaced", "bubbled_up"] as const) {
    it(`round-trips ${state} on a row in Earlier: the open read and the reading stamp come back`, async () => {
      const store = await seeded([msg("m1", {
        unread: false, date: "2026-09-10T08:00:00.000Z", lastReadAt: "2026-09-19T11:00:00.000Z", openReadAt: "2026-09-19T11:00:00.000Z",
      })]);
      const before = visible(store, "m1");
      const m: EngineMutation = { kind: "triage_set", messageId: "m1", state, ...(state === "bubbled_up" ? { bubbleUpAt: "2026-09-26T09:00:00.000Z" } : {}) };
      const inv = inverseMutations(store, m);
      await apply(store, m);
      expect(visible(store, "m1").openReadAt, "the press ended the open read").toBeNull();
      for (const u of inv) await apply(store, u);
      expect(visible(store, "m1")).toEqual(before);
    });
  }

  it("the overlay's restore is never later than now and lands only on a read row without an open read", async () => {
    const store = await seeded([msg("m1", { unread: false }), msg("m2", { unread: true }), msg("m3", { unread: false, openReadAt: "2026-09-19T11:30:00.000Z" })]);
    const undo = (id: string, at: string) => apply(store, { kind: "triage_set", messageId: id, state: "none", restoreOpenReadAt: at });
    await undo("m1", "2099-01-01T00:00:00.000Z");
    await undo("m2", "2026-09-19T11:00:00.000Z");
    await undo("m3", "2026-09-19T11:00:00.000Z");
    expect(["m1", "m2", "m3"].map((id) => visible(store, id).openReadAt)).toEqual([iso, null, "2026-09-19T11:30:00.000Z"]);
  });

  it("round-trips a Later press on a booked row", async () => {
    const when = "2026-09-26T09:00:00.000Z";
    const store = await seeded([msg("m1", { triage: pin("m1", "bubbled_up", when) })]);
    await store.putLocal("message_state", "m1", pin("m1", "bubbled_up", when));
    const before = visible(store, "m1");
    const m: EngineMutation = { kind: "triage_set", messageId: "m1", state: "reply_later" };
    const inv = inverseMutations(store, m);
    await apply(store, m);
    for (const u of inv) await apply(store, u);
    expect(visible(store, "m1")).toEqual(before);
  });
});

describe("mark_seen", () => {
  it("flips back only the ids the press flipped", async () => {
    const reader = await seeded([msg("m1", { unread: true }), msg("m2", { unread: false })]);
    expect(inverseMutations(reader, { kind: "mark_seen", messageIds: ["m1", "m2"], unread: false }))
      .toEqual([{ kind: "mark_seen", messageIds: ["m1"], unread: true }]);
  });

  it("a deliberate read re-pins the resurfaced row it spent; a glance does not", async () => {
    const rows = [msg("m1", { unread: false, triage: pin("m1", "resurfaced") })];
    const reader = await seeded(rows);
    expect(inverseMutations(reader, { kind: "mark_seen", messageIds: ["m1"], unread: false }))
      .toEqual([{ kind: "triage_set", messageId: "m1", state: "resurfaced" }]);
    expect(inverseMutations(reader, { kind: "mark_seen", messageIds: ["m1"], unread: false, via: "glance" }))
      .toEqual([]);
  });

  it("marking unread never touches the pin, and a no-op set answers nothing", async () => {
    const reader = await seeded([msg("m1", { unread: true, triage: pin("m1", "resurfaced") })]);
    expect(inverseMutations(reader, { kind: "mark_seen", messageIds: ["m1"], unread: true })).toEqual([]);
  });
});

describe("tag_assign", () => {
  it("an assign is undone by the unassign, and vice versa", async () => {
    const reader = await seeded([msg("m1", { labels: ["t1"] })]);
    expect(inverseMutations(reader, { kind: "tag_assign", messageId: "m1", tagId: "t2", assigned: true }))
      .toEqual([{ kind: "tag_assign", messageId: "m1", tagId: "t2", assigned: false }]);
    expect(inverseMutations(reader, { kind: "tag_assign", messageId: "m1", tagId: "t1", assigned: false }))
      .toEqual([{ kind: "tag_assign", messageId: "m1", tagId: "t1", assigned: true }]);
  });

  it("a press that changes nothing offers nothing — an Undo over it would CHANGE state", async () => {
    const reader = await seeded([msg("m1", { labels: ["t1"] })]);
    expect(inverseMutations(reader, { kind: "tag_assign", messageId: "m1", tagId: "t1", assigned: true })).toEqual([]);
    expect(inverseMutations(reader, { kind: "tag_assign", messageId: "ghost", tagId: "t1", assigned: true })).toEqual([]);
  });
});

/**
 * THE PLAN-LEVEL CLASS. Move, File and Junk are not one mutation but a screening PLAN, and its
 * undo class is not any member's: every rule mutation is `"none"` because none of them has a wire
 * inverse, while the PLAN is `"window"` because it is HELD before it is sent. Both live in the one
 * table, so a surface asks once and cannot grow a second opinion about the same press.
 */
describe("routing_plan — the one table answers about a plan too", () => {
  it("the plan is a window, and every member of it offers no reversal of its own", () => {
    expect(UNDO_CLASS.routing_plan).toBe("window");
    /* The members a routing plan is built from (`sender-screening.ts#planScreeningChange`).
       If any of these ever became "inverse", the window would be a second way back over a press
       that already had one — two undos for one act. */
    for (const kind of ["rule_create", "rule_update", "screener_decide"] as const) {
      expect(UNDO_CLASS[kind], `'${kind}' now claims its own reversal`).not.toBe("inverse");
    }
    /* And the MAIL half is the half the engine does reverse — the split the press rests on. */
    expect(UNDO_CLASS.move).toBe("inverse");
  });

  it("the plan's key is not a mutation kind — a plan cannot be dispatched as one", () => {
    expect(MUTATION_KINDS as readonly string[]).not.toContain("routing_plan");
  });
});
