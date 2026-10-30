import { describe, expect, it } from "vitest";
import {
  FixturesAdapter,
  OhmailEngine,
  arrivalMs,
  ohboxView,
  resurfacedThreads,
  type EngineMessage,
  type EntityReader,
  type MessageStateDTO,
} from "@ohmail/client-engine";

/** The fixture's ids, built from their numbers. */
const tid = (n: number): string => `T${n}`;

/**
 * ONE ROW PER CONVERSATION UNDER RESURFACED, and the badge that says somebody wrote since.
 *
 * The pin is per message, so a conversation parked as five messages came back as FIVE rows and
 * the reply that arrived while it was away stood a sixth time under "New for you".
 * `resurfacedThreads` folds the pin to the conversation without touching the wire.
 */

/*
 * Measured here: the row, what opening it lands on, how many messages it claims, when the pin went
 * up, what arrived since, the second way in (a `bubbled_up` conversation standing here because
 * somebody wrote into it), and that the fold takes its members out of the groups below — which is
 * exactly-once judged on what is rendered. Every `it` carries the mutation that reddens it.
 */

const OHBOX = "INBOX";
/* Both cast: `Folder` is the product's own list of places, and the second of these is
   deliberately OUTSIDE it — an IMAP Sent folder whose name the canonical regex does not know,
   which is the residual `isOwnSent` names and the only case that measures the auto-reply arm. */
const SENT = "Sent" as EngineMessage["folder"];
const UNRESOLVED_SENT = "Enviados" as EngineMessage["folder"];

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${p.id}`, from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", arrivedAt: "2026-08-01T09:00:00.000Z",
    folder: OHBOX, snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    ...p,
  } as EngineMessage;
}

const stateOf = (messageId: string, state: string, setAt: string): MessageStateDTO => ({
  messageId,
  state: state as MessageStateDTO["state"],
  bubbleUpAt: state === "bubbled_up" ? "2026-09-30T09:00:00.000Z" : null,
  setAt,
  updatedAt: setAt,
});

/** A hand-built reader over a flat entity list — the shape `triage-disjoint.test.ts` uses. */
function readerOf(byType: Record<string, unknown[]>): EntityReader {
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) =>
      (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({
      id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i,
    })),
    version: () => 1,
  } as unknown as EntityReader;
}

/** Messages carrying their own claim, the way the server emits it and the overlay writes it. */
function worldOf(
  messages: EngineMessage[],
  claims: MessageStateDTO[],
  threads: unknown[] = [],
): EntityReader {
  const withTriage = messages.map((m) => {
    const c = claims.find((x) => x.messageId === m.id);
    return c ? { ...m, triage: c } : m;
  });
  return readerOf({ message: withTriage, message_state: claims, thread: threads });
}

describe("a resurfaced conversation is ONE row", () => {
  /**
   * CONTROL (a). MUTATION WATCHED: key the fold by `m.id` instead of `m.threadId ?? msg:` in
   * `resurfacedThreads` and this reports 3 rows instead of 1. Drop the `openTarget` scan and take
   * `group[0]` and the target is `t-old` (the date-desc order's head is the newest by `date`, and
   * here the newest arrival carries no `date` at all in the null-date case below).
   */
  it("three pinned members of one thread make one row, opening the newest, counting the thread", () => {
    const pinnedAt = "2026-09-02T08:00:00.000Z";
    const msgs = [
      mkMsg({ id: "t-old", threadId: tid(1), date: "2026-08-01T09:00:00.000Z" }),
      mkMsg({ id: "t-mid", threadId: tid(1), date: "2026-08-02T09:00:00.000Z" }),
      mkMsg({ id: "t-new", threadId: tid(1), date: "2026-08-03T09:00:00.000Z" }),
    ];
    const claims = msgs.map((m) => stateOf(m.id, "resurfaced", pinnedAt));
    // The server's thread row knows about a fourth message this windowed mirror does not hold.
    const reader = worldOf(msgs, claims, [
      { id: tid(1), messageIds: ["t-0", "t-old", "t-mid", "t-new"], lastMessageAt: "2026-08-03T09:00:00.000Z" },
    ]);

    const rows = resurfacedThreads(reader);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.key).toBe(tid(1));
    expect(row.threadId).toBe(tid(1));
    expect(row.openTarget.id).toBe("t-new");
    expect(row.members.map((m) => m.id).sort()).toEqual(["t-mid", "t-new", "t-old"]);
    expect(row.pinned).toHaveLength(3);
    expect(row.count).toBe(4);
    expect(row.countFromThread).toBe(true);
    expect(row.resurfacedAt).toBe(pinnedAt);
    expect(row.badge).toBe(false);
    expect(row.pulledForward).toBe(false);

    // ADDITIVE: the per-message list the contract test pins is untouched.
    expect(ohboxView(reader).resurfaced.map((m) => m.id).sort()).toEqual(["t-mid", "t-new", "t-old"]);
  });

  /**
   * CONTROL (a2). MUTATION WATCHED: drop the `thread` read and answer `group.length` always, and
   * `count` reads 3 with `countFromThread` true — a windowed mirror claiming to be the server.
   */
  it("counts the mirror's members, said so, when no thread row has synced", () => {
    const msgs = [
      mkMsg({ id: "u-1", threadId: tid(2), date: "2026-08-01T09:00:00.000Z" }),
      mkMsg({ id: "u-2", threadId: tid(2), date: "2026-08-02T09:00:00.000Z" }),
    ];
    const reader = worldOf(msgs, [stateOf("u-2", "resurfaced", "2026-09-02T08:00:00.000Z")]);
    const row = resurfacedThreads(reader)[0]!;
    expect(row.count).toBe(2);
    expect(row.countFromThread).toBe(false);
  });

  /**
   * CONTROL (e). MUTATION WATCHED: replace `arrivalMs` with `Date.parse(m.date ?? "")` and the
   * null-date member sorts as the epoch, so `openTarget` falls back to `n-dated` and the row opens
   * on mail four weeks older than the one that just came in.
   */
  it("a member with no Date: header is dated by its arrival", () => {
    const msgs = [
      mkMsg({ id: "n-dated", threadId: tid(3), date: "2026-08-01T09:00:00.000Z", arrivedAt: "2026-08-01T09:00:00.000Z" }),
      mkMsg({ id: "n-null", threadId: tid(3), date: null, arrivedAt: "2026-08-29T09:00:00.000Z" }),
    ];
    const reader = worldOf(msgs, [stateOf("n-dated", "resurfaced", "2026-08-02T08:00:00.000Z")]);
    expect(arrivalMs(msgs[1]!)).toBe(Date.parse("2026-08-29T09:00:00.000Z"));
    expect(resurfacedThreads(reader)[0]!.openTarget.id).toBe("n-null");
  });
});

describe("the badge says somebody wrote since the pin went up", () => {
  const PIN = "2026-09-02T08:00:00.000Z";
  const LATER = "2026-09-03T09:00:00.000Z";

  const withReply = (reply: Partial<EngineMessage>): EntityReader =>
    worldOf(
      [
        mkMsg({ id: "b-pin", threadId: tid(4), date: "2026-08-01T09:00:00.000Z" }),
        mkMsg({ id: "b-reply", threadId: tid(4), date: LATER, unread: true, ...reply }),
      ],
      [stateOf("b-pin", "resurfaced", PIN)],
    );

  /**
   * CONTROL (b). MUTATION WATCHED: compare `>=` to the pin instead of `>` and the pinned member
   * itself (whose own claim is stamped at the pin) joins `newSince`, so a conversation nobody has
   * written to wears the badge the moment it comes back.
   */
  it("a later unread reply from somebody raises the badge", () => {
    const row = resurfacedThreads(withReply({}))[0]!;
    expect(row.badge).toBe(true);
    expect(row.newSince.map((m) => m.id)).toEqual(["b-reply"]);
  });

  /**
   * THE BOUNDARY. MUTATION WATCHED: compare `>=` to the pin and a message that arrived in the same
   * millisecond as the flip counts as having come in SINCE it — the badge on a row nobody wrote to.
   * Without a member at the exact instant the two spellings are indistinguishable.
   */
  it("a message arriving at the pin's own instant is not new since it", () => {
    const reader = worldOf(
      [
        mkMsg({ id: "e-pin", threadId: tid(9), date: "2026-08-01T09:00:00.000Z" }),
        mkMsg({ id: "e-at", threadId: tid(9), date: PIN, unread: true }),
      ],
      [stateOf("e-pin", "resurfaced", PIN)],
    );
    const row = resurfacedThreads(reader)[0]!;
    expect(row.newSince).toEqual([]);
    expect(row.badge).toBe(false);
  });

  /**
   * CONTROL (b2). MUTATION WATCHED: drop `isOwnSent` from `isFromSomeone` and the account's own
   * reply raises the badge — the product telling the user that they wrote.
   */
  it("the account's own reply raises nothing", () => {
    const row = resurfacedThreads(withReply({ folder: SENT }))[0]!;
    expect(row.badge).toBe(false);
    expect(row.newSince).toEqual([]);
  });

  /**
   * CONTROL (b3). MUTATION WATCHED: drop the `autoReplyByUs !== true` arm and the away responder's
   * own answer pulls the thread forward as "new".
   *
   * The folder is a Sent folder the canonical regex does NOT recognise — the residual `isOwnSent`
   * names. With `folder: SENT` this test passes under that mutation, because own-sent already
   * answers it: two mechanisms covering one arm measure the pair and neither on its own.
   */
  it("an away responder's answer raises nothing", () => {
    const row = resurfacedThreads(withReply({ folder: UNRESOLVED_SENT, autoReplyByUs: true }))[0]!;
    expect(row.badge).toBe(false);
    expect(row.newSince).toEqual([]);
  });

  /**
   * CONTROL (b4). MUTATION WATCHED: drop the `!m.unread` arm from `newSince` and the badge never
   * clears — the reply is still there after it has been read, and the row would say "new" for ever.
   * The pin SURVIVES the read: only a deliberate mark_seen of a PINNED member spends it, and this
   * is the newest member, not the pinned one.
   *
   * Not `presentsUnread`: swapping the two is unobservable, because a resurfaced member's `setAt`
   * is stamped at or after its own arrival and so can never be newer than the row's `since`. The
   * reading here is `m.unread` because the 2026-08-31 ruling says counts read the flag.
   */
  it("reading the new message clears the badge and leaves the pin standing", () => {
    const reader = withReply({ unread: false });
    const row = resurfacedThreads(reader)[0]!;
    expect(row.badge).toBe(false);
    expect(row.pinned.map((m) => m.id)).toEqual(["b-pin"]);
    expect(ohboxView(reader).resurfaced.map((m) => m.id)).toEqual(["b-pin"]);
  });
});

describe("new mail pulls a conversation whose time has not come forward", () => {
  const PARKED_AT = "2026-09-01T08:00:00.000Z";
  const build = (reply: Partial<EngineMessage>): { reader: EntityReader; claims: MessageStateDTO[] } => {
    const claims = [stateOf("p-pin", "bubbled_up", PARKED_AT)];
    const reader = worldOf(
      [
        mkMsg({ id: "p-pin", threadId: tid(5), date: "2026-08-01T09:00:00.000Z" }),
        mkMsg({ id: "p-reply", threadId: tid(5), date: "2026-09-04T09:00:00.000Z", unread: true, ...reply }),
      ],
      claims,
    );
    return { reader, claims };
  };

  /**
   * CONTROL (c). MUTATION WATCHED: drop the `bubbled_up` arm from the `pinned` filter and the row
   * disappears — the conversation stays parked until its clock says otherwise while the person is
   * looking at a reply to it. NO STATE IS WRITTEN: the claim is still `bubbled_up` with its
   * `bubbleUpAt` intact after the read, which is what makes this a display rule and not a second
   * bubble-up pass on the client.
   */
  it("a bubbled_up conversation with a later reply stands under Resurfaced, badged, unwritten", () => {
    const { reader, claims } = build({});
    const rows = resurfacedThreads(reader);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.pulledForward).toBe(true);
    expect(row.badge).toBe(true);
    expect(row.openTarget.id).toBe("p-reply");

    // The wire is untouched: same state, same schedule, nothing spent.
    expect(claims).toEqual([stateOf("p-pin", "bubbled_up", PARKED_AT)]);
    expect(reader.list<MessageStateDTO>("message_state").map((s) => s.state)).toEqual(["bubbled_up"]);
  });

  /**
   * CONTROL (c2). MUTATION WATCHED: revert `held()` to `!pinned.has(m.id) && !parked.has(m.id)`
   * and `p-reply` stands in "New for you" while its conversation stands under Resurfaced — one
   * conversation, two claims on attention, which is the whole defect.
   */
  it("the reply leaves New for you — the row is where it is", () => {
    const { reader } = build({});
    const view = ohboxView(reader);
    expect(view.newForYou.map((m) => m.id)).toEqual([]);
    expect(view.previouslySeen.map((m) => m.id)).toEqual([]);
    // Still not a `resurfaced` row on the wire: the per-message list is unchanged.
    expect(view.resurfaced).toEqual([]);
  });

  /**
   * CONTROL (c3). MUTATION WATCHED: drop `isFromSomeone` from the pull-forward and the user's own
   * reply drags the conversation they just answered back to the top of the Ohbox.
   */
  it("the account's own reply does not pull it forward", () => {
    const { reader } = build({ folder: SENT });
    expect(resurfacedThreads(reader)).toEqual([]);
    // And with no row, the parked member is parked and its sent sibling files as usual.
    expect(ohboxView(reader).newForYou).toEqual([]);
  });

  /**
   * MUTATION WATCHED: drop the recorded folder from `isOwnSent` and the own reply filed in the
   * mailbox's 'Envoyés' brings the conversation back as if somebody wrote. Its own mailbox id, so
   * the 'Enviados' cases above keep meaning "a Sent name nobody recorded".
   */
  it("the account's own reply in the mailbox's recorded 'Envoyés' does not pull it forward", () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter() });
    const reply = { folder: "Envoyés" as EngineMessage["folder"], mailboxId: "mb-envoyes" };
    expect(resurfacedThreads(build(reply).reader)).toHaveLength(1);
    try {
      engine.setSentFolders([{ id: "mb-envoyes", sentFolder: "Envoyés" }]);
      expect(resurfacedThreads(build(reply).reader)).toEqual([]);
    } finally {
      engine.setSentFolders([]);
    }
  });

  /**
   * MUTATION WATCHED: compare the reply's arrival against `bubbleUpAt` instead of the pin's
   * `setAt` and a conversation parked for next week never pulls forward at all, because every
   * reply arrives before the date it is waiting for.
   */
  it("a reply older than the pin leaves it parked", () => {
    const { reader } = build({ date: "2026-08-15T09:00:00.000Z" });
    expect(resurfacedThreads(reader)).toEqual([]);
  });
});

describe("rows are ordered by the newest claim on attention", () => {
  /**
   * MUTATION WATCHED: sort by `resurfacedAt` alone and the pulled-forward conversation — written
   * to an hour ago — files below a pin raised days earlier, which is the feature not happening.
   */
  it("a conversation written to just now outranks an older pin", () => {
    const reader = worldOf(
      [
        mkMsg({ id: "o-pin", threadId: "TA", date: "2026-08-01T09:00:00.000Z" }),
        mkMsg({ id: "o-park", threadId: "TB", date: "2026-07-01T09:00:00.000Z" }),
        mkMsg({ id: "o-fresh", threadId: "TB", date: "2026-09-20T09:00:00.000Z", unread: true }),
      ],
      [
        stateOf("o-pin", "resurfaced", "2026-09-05T08:00:00.000Z"),
        stateOf("o-park", "bubbled_up", "2026-09-01T08:00:00.000Z"),
      ],
    );
    expect(resurfacedThreads(reader).map((r) => r.key)).toEqual(["TB", "TA"]);
  });

  /**
   * MUTATION WATCHED: key the fold by `m.threadId` alone and a message with no conversation keys
   * `undefined`, so every thread-less pin in the mirror collapses into ONE row.
   */
  it("a pinned message with no conversation is its own row", () => {
    const reader = worldOf(
      [
        mkMsg({ id: "s-1", threadId: null, date: "2026-08-01T09:00:00.000Z" }),
        mkMsg({ id: "s-2", threadId: null, date: "2026-08-02T09:00:00.000Z" }),
      ],
      [
        stateOf("s-1", "resurfaced", "2026-09-02T08:00:00.000Z"),
        stateOf("s-2", "resurfaced", "2026-09-02T08:00:00.000Z"),
      ],
    );
    const rows = resurfacedThreads(reader);
    expect(rows.map((r) => r.key).sort()).toEqual(["msg:s-1", "msg:s-2"]);
    expect(rows.every((r) => r.threadId === null && r.count === 1)).toBe(true);
  });
});

describe("a held message is no member of a resurfaced conversation", () => {
  /*
   * A stranger's reply carrying a member's In-Reply-To is threaded into the conversation, and is
   * held at the gate (or quarantined). It stands in the Ohbox by its PLACE: not the face, not the
   * target, not the badge, not a pull-forward and not a rank. MUTATION WATCHED: drop the `placed`
   * filter in `resurfacedFolds` and every case here goes red with the services parity case.
   */
  const PIN = "2026-09-02T08:00:00.000Z";
  const held = (folder: string) => mkMsg({
    id: "h-stranger", threadId: "TH", date: "2026-09-10T09:00:00.000Z", unread: true,
    folder: folder as EngineMessage["folder"], from: { name: "S", address: "stranger@example.invalid" },
  });

  it.each(["ohmail/Screener", "ohmail/Quarantine"])("a pinned original keeps its face when a reply is held at %s", (folder) => {
    const reader = worldOf(
      [mkMsg({ id: "h-orig", threadId: "TH", date: "2026-08-01T09:00:00.000Z" }), held(folder),
        mkMsg({ id: "h-other", threadId: "TO", date: "2026-09-05T09:00:00.000Z" })],
      [stateOf("h-orig", "resurfaced", PIN), stateOf("h-other", "resurfaced", "2026-09-04T08:00:00.000Z")],
    );
    const rows = resurfacedThreads(reader);
    const row = rows.find((r) => r.key === "TH")!;
    expect(row.openTarget.id).toBe("h-orig");
    expect(row.members.map((m) => m.id)).toEqual(["h-orig"]);
    expect(row.newSince).toEqual([]);
    expect(row.badge).toBe(false);
    // The held reply ranks nothing: the later pin stays first.
    expect(rows.map((r) => r.key)).toEqual(["TO", "TH"]);
  });

  /* MUTATION WATCHED: drop the pin exception from the `placed` filter and a gate row the person
     pinned (History pins it where it sits; a raw reader reads that folder) is no row at all. */
  it("a member the person pinned stays a member wherever it sits", () => {
    const pinned = { ...held("ohmail/Screener"), unread: false };
    const reader = worldOf([pinned], [stateOf(pinned.id, "resurfaced", PIN)]);
    expect(resurfacedThreads(reader).map((r) => r.openTarget.id)).toEqual(["h-stranger"]);
  });

  it.each(["ohmail/Screener", "ohmail/Quarantine"])("a parked conversation is not brought back by a reply held at %s", (folder) => {
    const reader = worldOf(
      [mkMsg({ id: "h-orig", threadId: "TH", date: "2026-08-01T09:00:00.000Z" }), held(folder)],
      [stateOf("h-orig", "bubbled_up", PIN)],
    );
    expect(resurfacedThreads(reader)).toEqual([]);
  });
});
