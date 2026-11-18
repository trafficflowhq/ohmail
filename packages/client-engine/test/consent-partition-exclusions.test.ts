import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentIndex,
  consentPartition,
  decidedDestination,
  presentationReader,
  rulesList,
  screenerSegments,
  senderKey,
  type ConsentOptions,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * WHY A SENDER WITH MAIL IN THE SCREENER FOLDER IS NOT OFFERED AS WAITING.
 *
 * The sibling file pins what the partition does to each MESSAGE. This one pins the complement,
 * per SENDER: the folder holds mail from N senders, the queue offers M, and every one of the
 * N − M has a name. That is not readable from a browser — a screen-OUT decision leaves the mail
 * exactly where it was, so the mirror's message rows record nothing — and a page script that
 * re-derives the queue as a date cutline gets three exclusions it cannot explain and calls it a
 * defect.
 *
 * The observable is the queue the product renders: `screenerSegments` over
 * `presentationReader(mirror, consentPartition(mirror))` — the web shell's own read
 * (`app/shell/screener-state.ts`), the same rule the server answers in SQL (pinned by
 * `services/test/consent-cutline.pg.test.ts`) and the phone's (`state/live.ts#presentedWorld`).
 *
 * Two properties, because either alone is passed by an accident:
 *
 *   · ATTRIBUTION — {@link why} names the arm from the PARTITION's output, never from the
 *     fixture, and its `offered` verdict is asserted equal to the rendered queue. A classifier
 *     that agreed with the fixture and not with the queue would prove nothing.
 *   · ONE INPUT — each arm's fixture differs from its neighbour's by exactly one field, and each
 *     names the flip of that one field that puts the sender back in the queue. Every arm below
 *     was watched both ways; a fixture that happened to line up with the arm it demonstrates
 *     cannot pass, because the flipped twin is measured in the same case.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
/** Inside the 60-day window from {@link NOW}. */
const RECENT = "2026-07-20T09:00:00.000Z";
/** Outside it, and before {@link BASELINE}. */
const OLD = "2024-03-02T09:00:00.000Z";
/** An account that finished screening its backlog on this day (`account_settings.screening_baseline_at`). */
const BASELINE = "2026-08-01T00:00:00.000Z";

const GATE: Folder = "ohmail/Screener";

let seq = 0;

function msg(o: {
  id: string;
  from: string;
  folder: string;
  /** `null` is a message with no `Date:` header, which the cutline can never call recent. */
  date?: string | null;
  unread?: boolean;
  threadId?: string;
  to?: string[];
}): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: o.threadId ?? null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: o.from },
    to: (o.to ?? []).map((address) => ({ name: null, address })),
    cc: [],
    date: o.date === undefined ? OLD : o.date,
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date ?? OLD,
  };
}

function rule(o: {
  id: string;
  kind: RuleDTO["kind"];
  match: string;
  destination: Folder;
  enabled?: boolean;
}): RuleDTO {
  return {
    id: o.id,
    kind: o.kind,
    match: o.match,
    destination: o.destination,
    priority: 0,
    provenance: "seeded-from-sent",
    enabled: o.enabled ?? true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: OLD,
    updatedAt: OLD,
  };
}

async function mirrorOf(messages: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  return store;
}

/** The senders the product offers a decision on, as the page renders them. */
function offeredSenders(store: MemoryMirrorStore, opts: ConsentOptions): string[] {
  const part = consentPartition(store, opts);
  // `ownAddresses` rides in because the queue reads ONE own-address answer with the partition:
  // the grouping holds out the account's own mail wherever it sits, gate-physical included.
  return screenerSegments(presentationReader(store, part), opts.now ?? NOW, "en", "UTC", opts.ownAddresses)
    .waiting.map((row) => senderKey(row.from.address)).sort();
}

/** Every sender holding at least one message physically in the Screener folder. */
function sendersAtTheGate(store: MemoryMirrorStore): string[] {
  const keys = new Set<string>();
  for (const m of store.list<EngineMessage>("message")) {
    if (m.folder === GATE) keys.add(senderKey(m.from.address));
  }
  return [...keys].sort();
}

type Arm =
  | "offered"
  /** A rule files them into Screened or Quarantine. The mail does not move. */
  | "screened-out-by-a-decision"
  /**
   * A rule lets them through AND the cutline has retired them: since ARCH-R902 their unmoved gate
   * mail stays at the gate, and they are not asked about again — standing, not placement. An
   * ACTIVE sender in the same state is OFFERED: the mail is held and the server still asks.
   */
  | "decided-in"
  /** No decision, nothing inside the cutline: their mail presents in History. */
  | "retired-to-history"
  /** No decision, retired — but a consented thread pulled the row out of History. */
  | "rescued-by-its-thread"
  /** One of the account's own addresses. Never weighed as a correspondent at all. */
  | "the-account-itself";

const CONSENTING: ReadonlySet<string> = new Set(["INBOX", "ohmail/News", "ohmail/Receipts"]);

/**
 * The arm the PARTITION applied to this sender's gate mail. Read from its output — `placeOf`,
 * `activity`, and the rule index — so that a case which agrees with this also agrees with the
 * program. Its `offered` verdict is asserted against the rendered queue everywhere below.
 */
function why(store: MemoryMirrorStore, opts: ConsentOptions, key: string): Arm {
  const part = consentPartition(store, opts);
  const index = consentIndex(rulesList(store));
  const rows = store.list<EngineMessage>("message")
    .filter((m) => m.folder === GATE && senderKey(m.from.address) === key);
  if (rows.length === 0) throw new Error(`${key} holds nothing in ${GATE}`);
  const places = rows.map((m) => part.placeOf.get(m.id));
  // `senderActivity` skips the account's own addresses outright, so they have no standing here —
  // and this arm is read BEFORE the gate arm because an own row KEEPS its gate place and is still
  // not offered: the grouping holds it out by the same predicate the partition used.
  if (!part.activity.has(key)) return "the-account-itself";
  // A retired DECIDED sender is held out by standing, wherever the rows sit (ARCH-R902).
  if (part.retiredDecided.has(key)) return "decided-in";
  // The queue groups on the PRESENTED folder, so one gate-placed row is the whole of "offered".
  if (places.some((p) => p === GATE)) return "offered";
  const decided = decidedDestination(index, rows[0]!.from.address);
  if (decided !== null) return CONSENTING.has(decided) ? "decided-in" : "screened-out-by-a-decision";
  if (places.every((p) => p === null)) return "retired-to-history";
  return "rescued-by-its-thread";
}

/** Both properties at once: the arm, and the queue agreeing with it. */
function armOf(store: MemoryMirrorStore, opts: ConsentOptions, key: string): Arm {
  const arm = why(store, opts, key);
  expect(offeredSenders(store, opts).includes(key), `queue vs classifier for ${key}`)
    .toBe(arm === "offered");
  return arm;
}

/** Nothing in this file moves mail. Every case ends here. */
function physicalFolders(store: MemoryMirrorStore): Array<[string, string]> {
  return store.list<EngineMessage>("message").map((m) => [m.id, m.folder] as [string, string]).sort();
}

const S = "them@example.com";
const windowOpts: ConsentOptions = { now: NOW };
const baselinedOpts: ConsentOptions = { now: NOW, baselineAt: BASELINE };

describe("a decision is an exclusion, and it leaves the mail where it was", () => {
  /**
   * ARM 1. The blind spot behind a withdrawn verdict: a screen-OUT moves nothing, so from a
   * page script this sender is indistinguishable from one the queue dropped for no reason.
   * ONE INPUT from ARM 2: the rule's destination.
   */
  it("SCREENED OUT — the sender is in the screened-out segment, the mail is still at the gate", async () => {
    const messages = [msg({ id: "m1", from: S, folder: GATE, date: RECENT, unread: true })];
    const out = await mirrorOf(messages, [rule({ id: "r1", kind: "sender", match: S, destination: "ohmail/Screened" })]);

    expect(armOf(out, windowOpts, S)).toBe("screened-out-by-a-decision");
    expect(offeredSenders(out, windowOpts)).toEqual([]);
    const seg = screenerSegments(presentationReader(out, consentPartition(out, windowOpts)), NOW);
    expect(seg.screenedOut.map((r) => senderKey(r.from.address))).toEqual([S]);
    expect(consentPartition(out, windowOpts).placeOf.get("m1")).toBe("ohmail/Screened");
    expect(physicalFolders(out)).toEqual([["m1", GATE]]);

    // THE FLIP: the same rule switched off is not a decision, and the sender is back.
    const off = await mirrorOf(messages, [rule({ id: "r1", kind: "sender", match: S, destination: "ohmail/Screened", enabled: false })]);
    expect(armOf(off, windowOpts, S)).toBe("offered");
    expect(offeredSenders(off, windowOpts)).toEqual([S]);
  });

  /** A domain rule and a Quarantine rule are the same arm — they exclude, and nothing moves. */
  it("the arm is the DECISION, not its spelling — domain rules and Quarantine land here too", async () => {
    for (const [label, r] of [
      ["domain → Screened", rule({ id: "r1", kind: "domain", match: "example.com", destination: "ohmail/Screened" })],
      ["sender → Quarantine", rule({ id: "r1", kind: "sender", match: S, destination: "ohmail/Quarantine" })],
    ] as const) {
      const store = await mirrorOf([msg({ id: "m1", from: S, folder: GATE, date: RECENT, unread: true })], [r]);
      expect(armOf(store, windowOpts, S), label).toBe("screened-out-by-a-decision");
      expect(physicalFolders(store), label).toEqual([["m1", GATE]]);
    }
  });

  /**
   * ARM 2, AND THE ASYMMETRY BETWEEN THE TWO HALVES OF A DECISION.
   *
   * A screen-OUT is an answer: the person put this sender behind the gate, their mail presents in
   * Screened or Quarantine, and the screened-out shelf is where they are. An ADMISSION that
   * nobody has carried out is not an answer yet — the mail is still physically at the gate and the
   * mail server is still holding it for exactly that decision, so the queue asks. `GET /screener`
   * consults no rules and has always asked; this is the client agreeing with it.
   * ONE INPUT from ARM 1: the rule's destination. ONE INPUT from its own flip below: the date.
   */
  it("DECIDED IN BUT STILL HELD — an admission nobody carried out is a question still open", async () => {
    const messages = [msg({ id: "m1", from: S, folder: GATE, date: RECENT, unread: true })];
    const inn = await mirrorOf(messages, [rule({ id: "r1", kind: "sender", match: S, destination: "INBOX" })]);

    expect(armOf(inn, windowOpts, S)).toBe("offered");
    expect(offeredSenders(inn, windowOpts)).toEqual([S]);
    expect(consentPartition(inn, windowOpts).placeOf.get("m1")).toBe(GATE);
    // The rule is still on record — the sender is consented, and only the PLACE is the gate's.
    expect(consentPartition(inn, windowOpts).counts.consentedSenders).toBe(1);
    // …and the count of senders still owed a decision does not include them: that is the
    // cutline's question, the one `cutlineCounts` answers in SQL, and a rule is an answer to it.
    expect(consentPartition(inn, windowOpts).counts.activeUndecidedSenders).toBe(0);
    expect(physicalFolders(inn)).toEqual([["m1", GATE]]);

    // THE FLIP: the same rule over a RETIRED sender — still not offered: the server's queue
    // retires the same sender. Its PLACE is INVERTED by ARCH-R902: this pinned the
    // backlog in the Ohbox with nothing moved; a rule that moved nothing leaves it at the gate.
    const retired = await mirrorOf(
      [msg({ id: "m1", from: S, folder: GATE, date: OLD, unread: false })],
      [rule({ id: "r1", kind: "sender", match: S, destination: "INBOX" })],
    );
    expect(armOf(retired, windowOpts, S)).toBe("decided-in");
    expect(offeredSenders(retired, windowOpts)).toEqual([]);
    expect(consentPartition(retired, windowOpts).placeOf.get("m1")).toBe(GATE);
    expect(physicalFolders(retired)).toEqual([["m1", GATE]]);
  });

  /**
   * THE OTHER FLIP, kept from ARM 2's old shape: a rule pointing AT the gate is the absence of a
   * decision written down, and reads as no rule at all.
   */
  it("a rule pointing AT the gate is not a decision — the sender waits like any stranger", async () => {
    const held = await mirrorOf(
      [msg({ id: "m1", from: S, folder: GATE, date: RECENT, unread: true })],
      [rule({ id: "r1", kind: "sender", match: S, destination: GATE })],
    );
    expect(armOf(held, windowOpts, S)).toBe("offered");
    expect(offeredSenders(held, windowOpts)).toEqual([S]);
    expect(consentPartition(held, windowOpts).counts.activeUndecidedSenders).toBe(1);
  });
});

describe("the cutline is an exclusion, and the window has three settings", () => {
  /**
   * ARM 3. No decision, nothing recent, nothing unread — their mail is History.
   * ONE INPUT from its own flip: `unread`.
   */
  it("RETIRED — old and read presents in History, old and unread is back in the queue", async () => {
    const retired = await mirrorOf([msg({ id: "m1", from: S, folder: GATE, date: OLD, unread: false })]);
    expect(armOf(retired, windowOpts, S)).toBe("retired-to-history");
    const part = consentPartition(retired, windowOpts);
    expect(part.placeOf.get("m1")).toBe(null);
    expect(part.history.map((m) => m.id)).toEqual(["m1"]);
    expect(part.counts.dormantUndecidedSenders).toBe(1);
    expect(physicalFolders(retired)).toEqual([["m1", GATE]]);

    // THE FLIP: unread outranks age when the account has never decided anything.
    const unread = await mirrorOf([msg({ id: "m1", from: S, folder: GATE, date: OLD, unread: true })]);
    expect(armOf(unread, windowOpts, S)).toBe("offered");
  });

  /**
   * ARM 4. The baseline's own arm, and the exclusion no date comparison explains: the sender's
   * newest mail predates the point the account finished screening, so unread stops counting.
   * ONE INPUT from ARM 3's flip (old + unread, offered): `baselineAt`.
   */
  it("BASELINED — pre-baseline mail cannot resurrect a sender, not even unread", async () => {
    const messages = [msg({ id: "m1", from: S, folder: GATE, date: OLD, unread: true })];
    const under = await mirrorOf(messages);

    expect(armOf(under, baselinedOpts, S)).toBe("retired-to-history");
    expect(consentPartition(under, baselinedOpts).history.map((m) => m.id)).toEqual(["m1"]);
    expect(physicalFolders(under)).toEqual([["m1", GATE]]);

    // THE FLIP: drop the baseline and the same unread mail speaks again.
    expect(armOf(under, windowOpts, S)).toBe("offered");
    expect(offeredSenders(under, windowOpts)).toEqual([S]);
  });

  /**
   * ARM 5. The mode, not a window value — the arm an browser cell could not run. `all_time`
   * removes the cutoff, so every retired sender is back and still nothing has moved.
   * ONE INPUT from ARM 4: `screeningScope`.
   */
  it("ALL TIME — the exclusion is the WINDOW's, and the mode hands every retired sender back", async () => {
    const store = await mirrorOf([
      msg({ id: "m1", from: S, folder: GATE, date: OLD, unread: true }),
      msg({ id: "m2", from: "other@example.com", folder: GATE, date: OLD, unread: false }),
    ]);
    const allTime: ConsentOptions = { ...baselinedOpts, screeningScope: "all_time" };

    expect(offeredSenders(store, baselinedOpts)).toEqual([]);
    expect(armOf(store, allTime, S)).toBe("offered");
    expect(offeredSenders(store, allTime)).toEqual([S, "other@example.com"].sort());
    expect(consentPartition(store, allTime).history).toEqual([]);
    expect(physicalFolders(store)).toEqual([["m1", GATE], ["m2", GATE]]);

    // An unrecognised stored value is the WINDOW, never the wider mode — a bad value must fail
    // narrow, because screening everything is a lot of moved mail to undo by hand.
    expect(offeredSenders(store, { ...baselinedOpts, screeningScope: "all times" })).toEqual([]);
    // And the dial is still a dial: widening it past the mail's age offers them without the mode.
    expect(offeredSenders(store, { now: NOW, dormancyDays: 1000 })).toEqual([S, "other@example.com"].sort());
  });

  /**
   * ARM 6. A message with no `Date:` is never recent, so a read one retires its sender — an
   * exclusion with no timestamp to read it off, and the reason a date-cutline re-derivation
   * cannot close. ONE INPUT from ARM 3: the `Date:` header.
   */
  it("NO DATE HEADER — never recent, so read mail retires and unread mail waits", async () => {
    const undated = await mirrorOf([msg({ id: "m1", from: S, folder: GATE, date: null, unread: false })]);
    expect(armOf(undated, windowOpts, S)).toBe("retired-to-history");
    expect(consentPartition(undated, windowOpts).history.map((m) => m.id)).toEqual(["m1"]);
    expect(physicalFolders(undated)).toEqual([["m1", GATE]]);

    // THE FLIP: unread, with no baseline, and they are owed a decision again.
    const unread = await mirrorOf([msg({ id: "m1", from: S, folder: GATE, date: null, unread: true })]);
    expect(armOf(unread, windowOpts, S)).toBe("offered");
  });
});

describe("two arms that are neither a decision nor the cutline", () => {
  /**
   * ARM 7. A retired sender's row on a thread holding consented mail, with our own outbound
   * naming them, leaves History with the thread — excluded from the queue AND absent from
   * History, which is the one exclusion no History reading finds either.
   * ONE INPUT from its own flip: `unread` on the gate row.
   */
  it("RESCUED BY ITS THREAD — the row follows the conversation, and the queue still holds no row", async () => {
    const thread = (unread: boolean) => [
      msg({ id: "anchor", from: "ben@example.com", folder: "INBOX", date: RECENT, threadId: "th" }),
      msg({ id: "ours", from: "me@example.com", folder: "INBOX/Sent", date: RECENT, threadId: "th", to: [S] }),
      msg({ id: "m1", from: S, folder: GATE, date: OLD, unread, threadId: "th" }),
    ];
    const rules = [rule({ id: "r1", kind: "sender", match: "ben@example.com", destination: "INBOX" })];
    const opts: ConsentOptions = { now: NOW, ownAddresses: ["me@example.com"] };

    const rescued = await mirrorOf(thread(false), rules);
    expect(armOf(rescued, opts, S)).toBe("rescued-by-its-thread");
    const part = consentPartition(rescued, opts);
    expect(part.placeOf.get("m1")).toBe("INBOX");
    expect(part.history).toEqual([]);
    expect(part.activity.get(senderKey(S))).toBe("dormant");
    expect(physicalFolders(rescued)).toEqual([["anchor", "INBOX"], ["m1", GATE], ["ours", "INBOX/Sent"]]);

    // Without our own outbound there is no corroboration, and the same row stays in History: a
    // stranger who names a Message-ID we hold does not join a decided conversation.
    const unanswered = await mirrorOf([thread(false)[0]!, thread(false)[2]!], rules);
    expect(armOf(unanswered, opts, S)).toBe("retired-to-history");

    // THE FLIP: unread makes them active, and the thread rule deliberately does not rescue a
    // gate-placed row — the queue exists to ask for the decision it would skip.
    const active = await mirrorOf(thread(true), rules);
    expect(armOf(active, opts, S)).toBe("offered");
    expect(consentPartition(active, opts).placeOf.get("m1")).toBe(GATE);
  });

  /**
   * ARM 8. The account's own address is never weighed as a correspondent — not in the partition's
   * reckoning and not in the queue's rows, wherever the mail sits. Its INBOX mail is never
   * presented at the gate, and a row already PHYSICALLY at the gate presents in the INBOX (ruling
   * 2026-09-25) — so it mints no waiting row, and the queue and `activeUndecidedSenders` cannot
   * differ by one, which they did while the guard reached only INBOX mail. ONE INPUT from its own
   * flip: `ownAddresses`.
   */
  it("THE ACCOUNT ITSELF — own mail is never a queue row, in the INBOX or at the gate", async () => {
    const own = "me@example.com";
    const opts: ConsentOptions = { now: NOW, ownAddresses: [own] };
    const inbox = await mirrorOf([msg({ id: "m1", from: own, folder: "INBOX", date: RECENT, unread: true })]);

    expect(offeredSenders(inbox, opts)).toEqual([]);
    const part = consentPartition(inbox, opts);
    expect(part.placeOf.get("m1")).toBe("INBOX");
    expect(part.activity.has(own)).toBe(false);
    expect(part.counts.activeUndecidedSenders).toBe(0);

    // THE FLIP: not declared, and the account appears in its own Screener queue.
    expect(offeredSenders(inbox, { now: NOW })).toEqual([own]);
    expect(consentPartition(inbox, { now: NOW }).placeOf.get("m1")).toBe(GATE);

    // GATE-PHYSICAL — the row this arm used to miss. The mail presents in the INBOX with nothing
    // moved on the server, the queue holds no row for it, and the two numbers agree at zero.
    const atTheGate = await mirrorOf([msg({ id: "m2", from: own, folder: GATE, date: RECENT, unread: true })]);
    expect(armOf(atTheGate, opts, own)).toBe("the-account-itself");
    expect(offeredSenders(atTheGate, opts)).toEqual([]);
    const gatePart = consentPartition(atTheGate, opts);
    expect(gatePart.placeOf.get("m2")).toBe("INBOX");
    expect(gatePart.activity.has(own)).toBe(false);
    expect(gatePart.counts.activeUndecidedSenders).toBe(0);
    expect(physicalFolders(atTheGate)).toEqual([["m2", GATE]]);

    // THE CONTRARY STATE: the same message from a foreign address is one row.
    const stranger = await mirrorOf([msg({ id: "m2", from: S, folder: GATE, date: RECENT, unread: true })]);
    expect(armOf(stranger, opts, S)).toBe("offered");
    expect(offeredSenders(stranger, opts)).toEqual([S]);
  });
});

/**
 * THE S4-2 SHAPE — ten senders at the gate, five offered, five exclusions each with a name.
 *
 * The managed-web cell read rail = header = rows = 4 over a full folder from 9
 * senders and could classify only 2 of the 5 exclusions, because three of them were decisions
 * that move no mail. This is that arithmetic with every exclusion attributed, and it is the
 * closure the browser could not reach: no gate sender is unaccounted for, in either direction.
 *
 * The tenth sender arrived with the gate rule: an ADMISSION the mail never followed is not an
 * exclusion, and the same rule over a RETIRED sender still is — by standing; since ARCH-R902 its
 * rows stay at the gate. Both are in the fixture so the arms stay distinguishable.
 */
describe("the S4-2 arithmetic, closed", () => {
  const offeredSet = [
    "fresh@example.com", "read-recently@example.com", "held-by-a-rule@example.com",
    "rule-switched-off@example.com", "ruled-but-still-held@example.com",
  ];

  async function ninesenders(): Promise<MemoryMirrorStore> {
    return mirrorOf(
      [
        // OFFERED (5) — the queue's own rows.
        msg({ id: "o1", from: "fresh@example.com", folder: GATE, date: RECENT, unread: true }),
        msg({ id: "o2", from: "read-recently@example.com", folder: GATE, date: RECENT, unread: false }),
        msg({ id: "o3", from: "held-by-a-rule@example.com", folder: GATE, date: RECENT, unread: false }),
        msg({ id: "o4", from: "rule-switched-off@example.com", folder: GATE, date: RECENT, unread: false }),
        // Ruled to the INBOX, and the mail is still at the gate. The server asks; so does this.
        msg({ id: "o5", from: "ruled-but-still-held@example.com", folder: GATE, date: RECENT, unread: true }),
        // EXCLUDED (5) — one per arm, and the retired arm reached twice by two different inputs.
        msg({ id: "x1", from: "screened-out@example.com", folder: GATE, date: RECENT, unread: true }),
        msg({ id: "x2", from: "ruled-and-retired@example.com", folder: GATE, date: OLD, unread: false }),
        msg({ id: "x3", from: "retired@example.com", folder: GATE, date: OLD, unread: false }),
        msg({ id: "x4", from: "pre-baseline@example.com", folder: GATE, date: OLD, unread: true }),
        msg({ id: "x5", from: "on-a-thread@example.com", folder: GATE, date: OLD, unread: false, threadId: "th" }),
        // The thread the last one rides, and our own outbound that corroborates the join. The
        // anchor is a consented sender's INBOX mail — mail already PAST the gate, which is the
        // half of the projection this change leaves alone.
        msg({ id: "t1", from: "ruled-but-still-held@example.com", folder: "INBOX", date: RECENT, threadId: "th" }),
        msg({ id: "t2", from: "me@example.com", folder: "INBOX/Sent", date: RECENT, threadId: "th", to: ["on-a-thread@example.com"] }),
      ],
      [
        rule({ id: "r1", kind: "sender", match: "screened-out@example.com", destination: "ohmail/Screened" }),
        rule({ id: "r2", kind: "sender", match: "ruled-but-still-held@example.com", destination: "INBOX" }),
        rule({ id: "r3", kind: "sender", match: "held-by-a-rule@example.com", destination: GATE }),
        rule({ id: "r4", kind: "sender", match: "rule-switched-off@example.com", destination: "INBOX", enabled: false }),
        rule({ id: "r5", kind: "sender", match: "ruled-and-retired@example.com", destination: "ohmail/News" }),
      ],
    );
  }

  const opts: ConsentOptions = { now: NOW, baselineAt: BASELINE, ownAddresses: ["me@example.com"] };

  it("five offered, five excluded, and every exclusion attributed to a named arm", async () => {
    const store = await ninesenders();
    const gate = sendersAtTheGate(store);
    expect(gate).toHaveLength(10);

    const attributed = Object.fromEntries(gate.map((key) => [key, why(store, opts, key)]));
    expect(attributed).toEqual({
      "fresh@example.com": "offered",
      "read-recently@example.com": "offered",
      "held-by-a-rule@example.com": "offered",
      "rule-switched-off@example.com": "offered",
      "ruled-but-still-held@example.com": "offered",
      "screened-out@example.com": "screened-out-by-a-decision",
      "ruled-and-retired@example.com": "decided-in",
      "retired@example.com": "retired-to-history",
      "pre-baseline@example.com": "retired-to-history",
      "on-a-thread@example.com": "rescued-by-its-thread",
    });

    const offered = offeredSenders(store, opts);
    expect(offered).toEqual([...offeredSet].sort());
    expect(Object.values(attributed).filter((a) => a === "offered")).toHaveLength(5);

    /*
     * AND THE COUNT IS FOUR, WHICH IS NOT A DISAGREEMENT. The queue answers "whose mail is the
     * mailbox holding"; `activeUndecidedSenders` answers "who is still owed a decision", and a
     * rule is an answer to the second whether or not anybody carried it out. The server splits
     * the same way and always has — `heldSenderPage` consults no rules while `cutlineCounts`
     * counts a ruled sender as decided — so this is the two ends agreeing, not one drifting.
     */
    expect(consentPartition(store, opts).counts.activeUndecidedSenders).toBe(4);

    // CLOSURE, both directions: every gate sender is offered or attributed, and nothing the
    // queue offers is missing from the gate.
    expect(gate.filter((k) => attributed[k] === "offered")).toEqual(offered);
    expect(offered.every((k) => gate.includes(k))).toBe(true);

    // Nothing moved. All ten senders' mail is still in the Screener folder.
    expect(store.list<EngineMessage>("message").filter((m) => m.folder === GATE)).toHaveLength(10);
  });

  it("all time hands back everything the CUTLINE held out, and nothing a DENIAL did", async () => {
    const store = await ninesenders();
    const allTime: ConsentOptions = { ...opts, screeningScope: "all_time" };
    // Four come back, and the fourth is the one a reading of the arms would miss: the thread
    // rescue acts on History rows, so with no cutoff there is nothing to rescue and that sender
    // is an ordinary undecided-active row again. `ruled-and-retired@` comes back too — the only
    // thing holding it out was the cutline, and its mail is at the gate like everybody else's.
    expect(offeredSenders(store, allTime)).toEqual(
      [...offeredSet, "ruled-and-retired@example.com", "retired@example.com",
        "pre-baseline@example.com", "on-a-thread@example.com"].sort(),
    );
    // The DENIAL is the one exclusion no window can undo: a decision is not a window.
    expect(why(store, allTime, "screened-out@example.com")).toBe("screened-out-by-a-decision");
    expect(offeredSenders(store, allTime)).not.toContain("screened-out@example.com");
    expect(consentPartition(store, allTime).history).toEqual([]);
    expect(store.list<EngineMessage>("message").filter((m) => m.folder === GATE)).toHaveLength(10);
  });

  /**
   * THE ADMISSION ARM — the ordinary case is offered. Over each single-input variation of one
   * plain gate sender, the sender waits unless one of the named arms applies; this is what makes
   * the five exclusions above a property rather than the shape of the fixture.
   */
  it("a gate sender with no arm against them is always offered", async () => {
    for (const [label, m, o] of [
      ["recent and unread", msg({ id: "m1", from: S, folder: GATE, date: RECENT, unread: true }), windowOpts],
      ["recent and read", msg({ id: "m1", from: S, folder: GATE, date: RECENT, unread: false }), windowOpts],
      ["old and unread, no baseline", msg({ id: "m1", from: S, folder: GATE, date: OLD, unread: true }), windowOpts],
      ["undated and unread", msg({ id: "m1", from: S, folder: GATE, date: null, unread: true }), windowOpts],
      ["post-baseline and read, under a baseline", msg({ id: "m1", from: S, folder: GATE, date: RECENT, unread: false }), baselinedOpts],
      ["pre-baseline and unread, all time", msg({ id: "m1", from: S, folder: GATE, date: OLD, unread: true }), { ...baselinedOpts, screeningScope: "all_time" }],
    ] as const) {
      const store = await mirrorOf([m]);
      expect(armOf(store, o, S), label).toBe("offered");
      expect(offeredSenders(store, o), label).toEqual([S]);
    }
  });
});
