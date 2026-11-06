import { describe, expect, it } from "vitest";
import { managedDomain } from "../../../test/support/fixture-credentials.js";
import {
  DEMO_NOW,
  FixturesAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  OPTIMISTIC_SENT_TTL_MS,
  consentPartition,
  ohboxView,
  presentationReader,
  readsPartition,
  receiptsByDay,
  screenerSegments,
  type EngineAdapter,
  type EngineMessage,
  type Folder,
  type MutationOutcome,
  type SyncChange,
  type SyncParams,
} from "@ohmail/client-engine";

/**
 * ═══ SENT MAIL LIVES IN THE OHBOX, AND IT IS THERE THE MOMENT YOU PRESS SEND ═════════════
 *
 * Three separate claims, each of which was false in its own way and each of which is a
 * different mechanism:
 *
 *  1. ORDER. "Earlier" once sorted by reading stamp, and an own-sent row carries no
 *     `lastReadAt` — nothing stamps one (the pipeline creates the ingested Sent row with
 *     `unread: false` and no read instant, `packages/core/src/pipeline.ts`). First that filed
 *     every sent message BELOW everything ever opened; then its own-instant fallback stacked
 *     the whole sent history above the unstamped received history as a second chronology.
 *     Since the arrival ruling (owner 2026-09-18) "Earlier" is ONE chronology by
 *     `sortAt ?? date`, and a sent row's slot is its send instant.
 *
 *  2. TIME. The optimistic Sent copy is minted from the server's `{status:"sent"}` answer, and
 *     that call sat BELOW `await this.syncFresh()` in `OhmailEngine.dispatch` — a whole
 *     reconciliation drain, which for a send can never carry the thing being waited for: the
 *     only `change_log` row a send writes is the draft's flip to `sent`
 *     (`send-service.ts#finalizeSent`). The real Sent row arrives minutes later, from the
 *     worker's Sent-folder watch. So the mechanism built to show the message instantly was
 *     gated behind a drain that is unbounded on a mailbox mid-backfill.
 *
 *  3. VOLUME. The cutline files a dormant stranger's pre-baseline mail into History and left
 *     own-sent mail alone at any age — the first branch of `consentPartition` returned before
 *     the cutline was consulted. An account with ten years of Sent mail poured all of it into
 *     "Earlier", which is the "thousands unread" backlog this product exists to refuse, wearing a
 *     different label.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
/** Inside the 60-day window. */
const RECENT = "2026-07-20T09:00:00.000Z";
/** Outside it — the backlog the baseline says is finished. */
const OLD = "2024-03-02T09:00:00.000Z";

let seq = 0;

function msg(o: {
  id: string;
  folder: string;
  from?: string;
  date?: string;
  unread?: boolean;
  lastReadAt?: string | null;
  threadId?: string | null;
  messageIdHeader?: string | null;
  local?: true;
}): EngineMessage {
  const m: EngineMessage = {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: o.threadId ?? null,
    messageIdHeader: o.messageIdHeader ?? null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: o.from ?? `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date ?? RECENT,
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date ?? RECENT,
  };
  if ("lastReadAt" in o) m.lastReadAt = o.lastReadAt;
  if (o.local) m.local = true;
  return m;
}

/**
 * CONSENT FOR EVERY INBOUND SENDER NAMED HERE, because otherwise the fixture is about the
 * Screener rather than about the Ohbox: an undecided sender's INBOX mail is presented at the
 * gate, not in "Earlier", however read it is. The rule is the record of a decision — which is
 * exactly what the cutline reads — so the mail this file compares sent rows against has to have
 * one behind it.
 */
function consentRule(address: string): RuleDTO {
  return {
    id: `rule-${address}`,
    kind: "sender",
    match: address,
    destination: "INBOX",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: OLD,
    updatedAt: OLD,
  };
}

async function mirrorOf(messages: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    ...rules.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r,
    })),
  ] as SyncChange[]);
  return store;
}

/** The Ohbox exactly as the shell reads it: piles over the PRESENTED mirror. */
async function presentedOhbox(
  messages: EngineMessage[],
  opts: { baselineAt?: string | null; rules?: RuleDTO[] } = {},
): Promise<{ earlier: string[]; history: string[]; newForYou: string[] }> {
  // Every inbound sender in the fixture is consented, so nothing under test is confounded by a
  // Screener placement. Own-sent rows are not senders and are skipped.
  const rules = opts.rules ?? [
    ...new Set(
      messages
        .filter((m) => m.folder === "INBOX" || m.folder.startsWith("ohmail/"))
        .map((m) => m.from.address),
    ),
  ].map(consentRule);
  const store = await mirrorOf(messages, rules);
  const part = consentPartition(store, {
    now: NOW,
    ...(opts.baselineAt === undefined ? {} : { baselineAt: opts.baselineAt }),
    ownAddresses: ["me@example.com"],
  });
  const view = ohboxView(presentationReader(store, part));
  return {
    earlier: view.previouslySeen.map((m) => m.id),
    newForYou: view.newForYou.map((m) => m.id),
    history: part.history.map((m) => m.id),
  };
}

/* ═══ 1 · ORDER ══════════════════════════════════════════════════════════════════════════ */

describe("a sent message is at the TOP of Earlier, not at the bottom of it", () => {
  /**
   * THE HEADLINE. Press Send and the message is the first row under "Earlier" — its send
   * instant is the newest arrival in the pile.
   *
   * Mutation that proves this bites: key the pile's sort on the reading stamp again and read
   * mail floats above the unstamped `just-sent` row — the pile stops being one chronology.
   */
  it("ranks own-sent mail by WHEN IT WAS SENT — its arrival slot in the one chronology", async () => {
    const { earlier } = await presentedOhbox([
      // Read through the product an hour ago.
      msg({ id: "read-recent", folder: "INBOX", date: RECENT, lastReadAt: "2026-08-04T11:00:00.000Z" }),
      // Read yesterday.
      msg({ id: "read-older", folder: "INBOX", date: RECENT, lastReadAt: "2026-08-03T11:00:00.000Z" }),
      // Just sent — no `lastReadAt`, because nothing stamps one on outbound mail.
      msg({ id: "just-sent", folder: "Sent", date: "2026-08-04T11:59:00.000Z" }),
    ]);
    expect(earlier).toEqual(["just-sent", "read-recent", "read-older"]);
  });

  it("and a reading stamp does NOT lift read mail above it — arrival decides, never the read", async () => {
    // The reversal (owner 2026-09-18): `read-today` was READ this morning but ARRIVED weeks
    // ago, and the read is state, not a position. Under the reading-order rule it outranked
    // Monday's sent mail — the first brick of the stacked-chronology batches.
    const { earlier } = await presentedOhbox([
      msg({ id: "read-today", folder: "INBOX", date: RECENT, lastReadAt: "2026-08-04T11:00:00.000Z" }),
      msg({ id: "sent-monday", folder: "Sent", date: "2026-08-01T09:00:00.000Z" }),
    ]);
    expect(earlier).toEqual(["sent-monday", "read-today"]);
  });

  it("an own-sent row that DOES carry a reading stamp keeps its send-instant slot", async () => {
    // Re-reading your own sent mail never moves it — the stamp here is the newest instant in
    // the fixture, and the row still sits below mail that arrived after it was sent.
    const { earlier } = await presentedOhbox([
      msg({ id: "sent-restamped", folder: "Sent", date: "2026-08-01T09:00:00.000Z", lastReadAt: "2026-08-04T11:59:00.000Z" }),
      msg({ id: "read-newer", folder: "INBOX", date: "2026-08-02T09:00:00.000Z", lastReadAt: "2026-08-04T11:00:00.000Z" }),
    ]);
    expect(earlier).toEqual(["read-newer", "sent-restamped"]);
  });

  it("sent mail stands in New only with a conversation that has something new", async () => {
    const { newForYou, earlier } = await presentedOhbox([
      msg({ id: "unread-in", folder: "INBOX", unread: true }),
      msg({ id: "sent", folder: "Sent Items", date: "2026-08-04T11:59:00.000Z" }),
    ]);
    expect(newForYou).toEqual(["unread-in"]);
    expect(earlier).toEqual(["sent"]);
  });

  it("a reply to a waiting conversation rides its New row (owner 2026-09-28)", async () => {
    // The conversation is the unit of place: the reply joins the unread mail it answers in New,
    // never a second row under Earlier. The unrelated read row stays where it was.
    const { newForYou, earlier } = await presentedOhbox([
      msg({ id: "unread-in", folder: "INBOX", unread: true, threadId: "T", date: "2026-08-04T10:00:00.000Z" }),
      msg({ id: "reply", folder: "Sent Items", threadId: "T", date: "2026-08-04T11:59:00.000Z" }),
      msg({ id: "read-other", folder: "INBOX", date: "2026-08-04T11:00:00.000Z" }),
    ]);
    expect(newForYou).toEqual(["reply", "unread-in"]);
    expect(earlier).toEqual(["read-other"]);
  });
});

/* ═══ 2 · THE CUTLINE ════════════════════════════════════════════════════════════════════ */

describe("own-sent mail meets the same cutline as inbound mail", () => {
  /**
   * Mutation that proves this bites: restore the unconditional
   * `if (!KNOWN_FOLDERS.has(m.folder)) { placeOf.set(m.id, m.folder); continue; }` first branch
   * in `consentPartition` and `sent-ancient` reappears in Earlier — an account's whole Sent
   * backlog with it.
   */
  it("sent mail from BEFORE the cutline is History, exactly as a dormant stranger's mail is", async () => {
    const { earlier, history } = await presentedOhbox([
      msg({ id: "sent-recent", folder: "Sent", date: RECENT }),
      msg({ id: "sent-ancient", folder: "Sent", date: OLD }),
    ], { baselineAt: "2026-08-01T00:00:00.000Z" });

    expect(earlier).toEqual(["sent-recent"]);
    expect(history).toEqual(["sent-ancient"]);
  });

  it("THE BASELINE MOVES THE LINE — the same sent message lands either side of it", async () => {
    // Symmetry with inbound: the cutoff is `baselineAt - dormancyDays` and stops moving, so which
    // side of it a message falls on is a property of when the account finished screening, not of
    // today's date. `sent-may` sits between the two cutoffs below.
    const both = [msg({ id: "sent-may", folder: "Sent", date: "2026-05-01T09:00:00.000Z" })];

    // Baseline 2026-08-04 ⇒ cutoff 2026-06-05. May is beyond it.
    expect((await presentedOhbox(both, { baselineAt: "2026-08-04T00:00:00.000Z" })).history)
      .toEqual(["sent-may"]);
    // Baseline 2026-06-04 ⇒ cutoff 2026-04-05. The same message is inside it.
    expect((await presentedOhbox(both, { baselineAt: "2026-06-04T00:00:00.000Z" })).earlier)
      .toEqual(["sent-may"]);
  });

  it("a pre-cutline sent reply on a CONSENTED thread follows its thread, never splits from it", async () => {
    // The thread rule already says a conversation is one thing. Outbound mail is half of every
    // conversation, so it has to be inside that rule rather than exempt from it: the user's own
    // old reply may not sit in History while the message it answers sits in the Ohbox.
    const { earlier, history } = await presentedOhbox([
      msg({ id: "their-mail", folder: "INBOX", from: "lena@example.com", date: OLD, threadId: "t1" }),
      msg({ id: "my-old-reply", folder: "Sent", date: OLD, threadId: "t1" }),
      // …and an unrelated old sent message still goes to History.
      msg({ id: "my-old-note", folder: "Sent", date: OLD }),
    ], { baselineAt: "2026-08-01T00:00:00.000Z" });

    expect(history).toEqual(["my-old-note"]);
    expect(earlier).toContain("my-old-reply");
  });

  /**
   * …AND THE RESCUE PUTS IT IN "EARLIER", NEVER IN THE ANCHOR'S STREAM.
   *
   * A consented sender's mail can be filed in Reads or Receipts, and those are the anchor places
   * the thread rule hands out. Following an anchor literally would file the user's own sent mail
   * into a reading stream, where it is counted and rendered as an issue.
   *
   * Since ARCH-R902 a rule no longer presents an unmoved INBOX letter in News, so
   * the anchor below is the INBOX and the case pins the inverted fact: both rows in Earlier.
   */
  it("a rescued sent row lands in Earlier, not in the Reads stream its thread is anchored to", async () => {
    // Physically in the INBOX with a rule filing the sender into Reads — the shape that makes
    // `ohmail/News` a thread ANCHOR place (an explicitly-filed message is never an anchor; a
    // rule-placed one is).
    const store = await mirrorOf(
      [
        msg({ id: "their-issue", folder: "INBOX", from: "lena@example.com", date: OLD, threadId: "t1" }),
        msg({ id: "my-old-reply", folder: "Sent", date: OLD, threadId: "t1" }),
      ],
      [{ ...consentRule("lena@example.com"), destination: "ohmail/News" as Folder }],
    );
    const part = consentPartition(store, {
      now: NOW, baselineAt: "2026-08-01T00:00:00.000Z", ownAddresses: ["me@example.com"],
    });
    const r = presentationReader(store, part);

    expect(part.history.map((m) => m.id)).toEqual([]);
    expect(ohboxView(r).previouslySeen.map((m) => m.id)).toEqual(["their-issue", "my-old-reply"]);
    const reads = readsPartition(r);
    expect([...reads.fresh, ...reads.seen].map((m) => m.id)).toEqual([]);
  });

  it("an UNDATED sent row is never assumed historical", async () => {
    // `messageMs` answers null for a row with no legal date, and a row nobody can place in time
    // must not be filed as finished with. It keeps its place, like every other undated row.
    const undated = msg({ id: "sent-undated", folder: "Sent" });
    (undated as { date: string | null }).date = null;
    const { earlier, history } = await presentedOhbox([undated], { baselineAt: "2026-08-01T00:00:00.000Z" });
    expect(history).toEqual([]);
    expect(earlier).toEqual(["sent-undated"]);
  });
});

/* ═══ 3 · THE STREAMS AND THE SCREENER ═══════════════════════════════════════════════════ */

describe("sent mail belongs to the Ohbox and to nothing else", () => {
  it("is absent from Reads, Receipts and every Screener segment", async () => {
    const store = await mirrorOf([
      msg({ id: "sent", folder: "Sent", date: "2026-08-04T11:59:00.000Z" }),
      msg({ id: "sent-exchange", folder: "Sent Items", date: "2026-08-04T11:58:00.000Z" }),
      msg({ id: "an-issue", folder: "ohmail/News", unread: true }),
    ]);
    const part = consentPartition(store, { now: NOW, ownAddresses: ["me@example.com"] });
    const r = presentationReader(store, part);

    expect(readsPartition(r).fresh.concat(readsPartition(r).seen).map((m) => m.id)).toEqual(["an-issue"]);
    expect(receiptsByDay(r, NOW).flatMap((g) => g.items.map((m) => m.id))).toEqual([]);
    const seg = screenerSegments(r, NOW);
    expect([...seg.waiting, ...seg.screenedOut, ...seg.spam]).toEqual([]);
  });
});

/* ═══ 4 · ONE ROW, WHENEVER THE REAL ONE LANDS ═══════════════════════════════════════════ */

describe("the optimistic copy and the ingested row are never both in the list", () => {
  /**
   * `reconcileOptimisticSent` retires the copy at the END of a drain. A backfill drain is many
   * pages, and `applyResponse` notifies after EVERY page — so between the page that lands the
   * real Sent row and the end of the drain, both rows are in the mirror and the list renders
   * the just-sent message twice. `threadOf` has collapsed this since the Exchange twin slice;
   * the pile had no such rule.
   *
   * Mutation that proves this bites: drop the `collapseTwins` call from `ohboxView` and this
   * list has two rows.
   */
  it("collapses twins sharing a Message-ID, and the REAL row is the one that stands", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "optimistic", folder: "Sent", date: "2026-08-04T11:59:00.000Z", messageIdHeader: `<x@${managedDomain()}>`, local: true }),
      msg({ id: "ingested", folder: "Sent Items", date: "2026-08-04T11:59:00.000Z", messageIdHeader: `x@${managedDomain()}` }),
    ]);
    expect(earlier).toEqual(["ingested"]);
  });

  it("a provider that re-files its own submission — two Sent paths, one id — is one row", async () => {
    const { earlier, newForYou } = await presentedOhbox([
      msg({ id: "appended", folder: "Sent", from: "me@example.com", date: "2026-08-04T11:59:00.000Z", messageIdHeader: `s@${managedDomain()}` }),
      msg({ id: "refiled", folder: "Sent Items", from: "me@example.com", date: "2026-08-04T11:59:00.000Z", messageIdHeader: `s@${managedDomain()}` }),
    ]);
    expect(newForYou).toEqual([]);
    expect(earlier).toHaveLength(1);
  });

  /**
   * The collapse key is the sender's own writing, so it may only group OUR OWN outbound copies
   * (`@trafficflow/core/sender-headers`). A delivered row that reuses a Message-ID this pile
   * already carries used to take the survivor's place — the mail was still stored and no longer
   * rendered — and a `From` naming the account's own address is not evidence either, because a
   * sender writes that too.
   */
  it("a delivered row reusing a Message-ID does not displace the pile's own row", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "ours", folder: "Sent", from: "me@example.com", date: "2026-08-04T11:59:00.000Z", messageIdHeader: `s@${managedDomain()}` }),
      msg({ id: "delivered", folder: "INBOX", from: "me@example.com", date: "2026-08-04T11:58:00.000Z", messageIdHeader: `s@${managedDomain()}` }),
    ]);
    expect(earlier.slice().sort()).toEqual(["delivered", "ours"]);
  });

  it("rows with NO Message-ID never collapse — absence is not a shared identity", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "sent-a", folder: "Sent", date: "2026-08-04T11:59:00.000Z" }),
      msg({ id: "sent-b", folder: "Sent", date: "2026-08-04T11:58:00.000Z" }),
    ]);
    expect(earlier).toEqual(["sent-a", "sent-b"]);
  });
});

/* ═══ 5 · THE INSTANT ════════════════════════════════════════════════════════════════════ */

/** Let every pending microtask AND the macrotask queue run. */
const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

/**
 * The real wire's shape for a send: the server commits, answers NO echo body, and carries the
 * minted `providerMessageId` — while `/sync` is a separate request that can be stalled. That
 * separation is the whole subject here: the send's own answer is enough to show the message,
 * and nothing about it should be hostage to a drain.
 */
function stalledSyncAdapter(inner: FixturesAdapter): {
  adapter: EngineAdapter;
  stallNextSync: () => () => void;
  syncCount: () => number;
} {
  let stall: { release: () => void; gate: Promise<void> } | null = null;
  let syncCount = 0;
  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: () => inner.fetchBody(),
    async sync(params: SyncParams) {
      syncCount++;
      const resp = await inner.sync(params);
      const held = stall;
      if (held) { stall = null; await held.gate; }
      return resp;
    },
    async mutate(m, o): Promise<MutationOutcome> {
      const out = await inner.mutate(m, o);
      return m.kind === "mail_send"
        ? { changes: [], seq: out.seq, providerMessageId: `<minted@${managedDomain()}>` }
        : { changes: [], seq: out.seq };
    },
  };
  return {
    adapter,
    syncCount: () => syncCount,
    stallNextSync: () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      stall = { release, gate };
      return release;
    },
  };
}

describe("the sent message is in the Ohbox before any drain settles", () => {
  /**
   * THE MINUTE, held down. Reported from production: "I see my sent message now in the ohbox,
   * but it took a minute!"
   *
   * Mutation that proves this bites: put `materializeSentOverlay` back below
   * `await this.syncFresh()` in `OhmailEngine.dispatch` and this hangs on the stalled drain —
   * neither the row nor the confirmation arrives while `/sync` is held.
   */
  it("the row is in Earlier, and the send has CONFIRMED, with /sync still held open", async () => {
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = new OhmailEngine({ adapter: h.adapter, now: () => DEMO_NOW });
    await engine.start();

    const release = h.stallNextSync();
    const sending = engine.mutate({ kind: "mail_send", inReplyTo: "giulia", body: "Gerne — Donnerstag?" });
    await tick();

    // The row, while the drain is still hanging.
    const sent = ohboxView(engine.read()).previouslySeen.filter((m) => m.local === true);
    expect(sent, "no Sent row reached the Ohbox before the reconciliation drain returned")
      .toHaveLength(1);
    expect(sent[0]!.messageIdHeader).toBe(`<minted@${managedDomain()}>`);
    expect(sent[0]!.folder).toBe("Sent");

    // …and it is at the TOP of Earlier, which is where the person who just wrote it looks.
    expect(ohboxView(engine.read()).previouslySeen[0]!.local).toBe(true);

    // The confirmation, too — the surface that navigates on it may not wait for a drain that
    // cannot carry this message in the first place.
    const settled = await Promise.race([
      sending.then((r) => r.status),
      new Promise<string>((r) => { setTimeout(() => r("STILL WAITING ON /sync"), 50); }),
    ]);
    expect(settled).toBe("confirmed");

    release();
    await sending;
  });

  it("the settle leaves ONE row, with the same identity — no duplicate, no second entry", async () => {
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = new OhmailEngine({ adapter: h.adapter, now: () => DEMO_NOW });
    await engine.start();

    await engine.mutate({ kind: "mail_send", inReplyTo: "giulia", body: "Gerne — Donnerstag?" });
    const before = ohboxView(engine.read()).previouslySeen;
    const optimisticId = before.find((m) => m.local === true)!.id;

    // The worker's Sent-folder watch, a minute later: the real row lands under the same header,
    // bracket-stripped exactly as ingest normalises it.
    const real = { ...before.find((m) => m.local === true)!, id: "real-row", local: undefined, messageIdHeader: `minted@${managedDomain()}` };
    await engine.store.applyChanges([
      { type: "message", op: "create", id: real.id, seq: 9999, updatedAt: real.updatedAt, entity: real },
    ] as SyncChange[]);

    // BEFORE the reconcile has run — the mirror holds both rows and the list must still show one.
    const mid = ohboxView(engine.read()).previouslySeen;
    expect(mid.filter((m) => m.id === optimisticId || m.id === "real-row"), "the just-sent message doubled")
      .toHaveLength(1);
    expect(mid[0]!.id).toBe("real-row");

    await engine.syncOnce();
    const after = ohboxView(engine.read()).previouslySeen;
    expect(after.filter((m) => m.local === true)).toHaveLength(0);
    expect(after[0]!.id).toBe("real-row");
  });
});

describe("a sent copy landing in a folder this client does not know as Sent asks for the mailboxes again", () => {
  /** Send, then land the real row in `folder` (none: let the copy age out), then drain twice. */
  async function landIn(folder: string | null, recorded?: string) {
    let at = DEMO_NOW.getTime();
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = new OhmailEngine({ adapter: h.adapter, now: () => new Date(at) });
    await engine.start();
    await engine.mutate({ kind: "mail_send", inReplyTo: "giulia", body: "Gerne — Donnerstag?" });
    const copy = ohboxView(engine.read()).previouslySeen.find((m) => m.local === true)!;
    if (recorded) engine.setSentFolders([{ id: copy.mailboxId, sentFolder: recorded }]);
    if (folder === null) at += OPTIMISTIC_SENT_TTL_MS + 1;
    else {
      const real = { ...copy, id: "real-row", local: undefined, folder: folder as Folder, messageIdHeader: `minted@${managedDomain()}` };
      await engine.store.applyChanges([
        { type: "message", op: "create", id: real.id, seq: 9999, updatedAt: real.updatedAt, entity: real },
      ] as SyncChange[]);
    }
    await engine.syncOnce();
    const first = engine.sentFolderAsks();
    await engine.syncOnce();
    const retired = ohboxView(engine.read()).previouslySeen.every((m) => m.local !== true);
    return { first, second: engine.sentFolderAsks(), retired };
  }

  it("once for a copy landing in 'Envoyés' that no mailbox read named, and not again on the next drain", async () => {
    const r = await landIn("Envoyés");
    expect(r.retired).toBe(true);
    expect([r.first, r.second]).toEqual([1, 1]);
  });

  it("CONTROLS: never for a Sent-shaped folder, a recorded one, or a copy retired by its time limit", async () => {
    expect((await landIn("Sent")).second).toBe(0);
    expect((await landIn("Envoyés", "Envoyés")).second).toBe(0);
    const aged = await landIn(null);
    expect(aged.retired, "the copy did not age out; the case measures nothing").toBe(true);
    expect(aged.second).toBe(0);
  });
});
