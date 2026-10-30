import { describe, expect, it } from "vitest";
import { getFixtures } from "@ohmail/fixtures";
import {
  DEMO_NOW,
  FOLDER_OF_VIEW,
  FixturesAdapter,
  OhmailEngine,
  isFromSomeone,
  isOwnSent,
  messagesIn,
  ohboxView,
  feedPartition,
  readsPartition,
  receiptsByDay,
  screenerSegments,
  tagsCrossView,
  threadParticipants,
  threadParticipantsIndex,
  triagePiles,
  type EngineMessage,
  type EntityReader,
} from "@ohmail/client-engine";

/** Selector correctness against the fixture world (counts match the prototype). */

async function demoEngine(): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
  await engine.start();
  return engine;
}

const fx = getFixtures();

describe("selectors over the fixture mirror", () => {
  /**
   * PARKED MAIL IS NOT HERE, and that is why the two groups hold nine of the fixture's eleven.
   *
   * `nadja` and `jonas` are the demo's Answer Later pile (`fixtures/data.ts#triage.replyLater`,
   * message-backed), so `parkedMessageIds` holds them out of every Ohbox group — see
   * `selectors.ts#OhboxView`. A message listed in a pile AND standing in the Ohbox is the double
   * presentation this file pins closed from the Ohbox side; `triage-disjoint.test.ts` pins it
   * structurally, over a synthetic mirror that does not depend on which ids the demo parks.
   *
   * THE PILE USED TO BE `giulia` AND `petra`, and the two assertions below are what that cost:
   * the Ohbox opened on `cinderlock` with seven rows, having dropped its first message and its
   * only attachment row. The fixture parks two mails written for the pile instead, so the nine
   * the demo means to show are all here — Giulia first — and the pile is still real, openable
   * mail rather than orphan rows.
   */
  it("ohbox splits new-for-you / previously-seen by unread, and PARKED mail is in neither", async () => {
    const r = (await demoEngine()).read();
    const view = ohboxView(r);
    // Three unread since the 2026-08-31 landing review (fixtures/data.ts#techcheck's note):
    // the demo opens with "Earlier" above the fold, and giulia keeps the visible thread.
    expect(view.newForYou.map((m) => m.id)).toEqual([
      "giulia",
      "petra",
      "ben",
    ]);
    // The read rows, by reading order (no lastReadAt in the fixture world, so send time
    // decides): the freshly-handled morning trio first, then yesterday's and Monday's mail.
    expect(view.previouslySeen.map((m) => m.id)).toEqual([
      "techcheck",
      "glazecall",
      "cinderlock",
      "anna",
      "reto",
      "flurina",
      "tim",
      "carla",
    ]);
    // Eleven rows on screen out of thirteen in the folder …
    expect(view.newForYou.length + view.previouslySeen.length).toBe(11);
    // … and the two that are missing are missing because they are in the pile.
    expect(triagePiles(r).replyLater.map((e) => e.messageId)).toEqual(["nadja", "jonas"]);
    for (const id of ["nadja", "jonas"]) {
      expect([...view.newForYou, ...view.previouslySeen, ...view.resurfaced].map((m) => m.id))
        .not.toContain(id);
    }
  });

  it("reads partitions around the waterline, preserving prototype order", async () => {
    // The cut is EXCLUSIVE: the anchor (f13, the newest issue seen on the last visit) sits
    // BELOW the line, so fresh is exactly the twelve that arrived since.
    const r = (await demoEngine()).read();
    const part = readsPartition(r);
    expect(part.waterline?.newestSeenId).toBe("f13");
    expect(part.waterline?.newestSeenId).toBe(fx.readsWaterline.newestSeenId);
    expect(part.fresh.map((m) => m.id)).toEqual(fx.reads.slice(0, 12).map((m) => m.id));
    expect(part.seen.map((m) => m.id)).toEqual(["f13", "f14", "f15"]);
  });

  it("receipts has its OWN partition slot, empty until a leave commits one", async () => {
    // `feedPartition(_, "receipts")` reads `view_meta` "receipts_waterline" — a row the demo
    // does not author — so everything is fresh and no line renders: the first-visit state.
    const r = (await demoEngine()).read();
    const part = feedPartition(r, "receipts");
    expect(part.waterline).toBeNull();
    expect(part.seen).toEqual([]);
    expect(part.fresh.map((m) => m.id)).toEqual(
      receiptsByDay(r, DEMO_NOW).flatMap((g) => g.items.map((m) => m.id)),
    );
  });

  it("receipts group by day exactly as the prototype (Today / Tuesday / Monday)", async () => {
    const r = (await demoEngine()).read();
    const groups = receiptsByDay(r, DEMO_NOW).map((g) => ({ label: g.label, items: g.items.map((m) => m.id) }));
    expect(groups).toEqual(fx.receiptsGroups.map((g) => ({ label: g.label, items: g.items })));
  });

  it("receipts dated today survive a runtime with no Intl.RelativeTimeFormat (Hermes): the caller's word, else the weekday", async () => {
    const r = (await demoEngine()).read();
    const intl = Intl as { RelativeTimeFormat?: unknown };
    const saved = intl.RelativeTimeFormat;
    try {
      intl.RelativeTimeFormat = undefined;
      // the phone's shape: its catalogue word, capitalised beside the weekday labels
      const own = receiptsByDay(r, DEMO_NOW, "en", "UTC", { today: "today" });
      expect(own[0]?.label).toBe("Today");
      // no word either: the weekday stands in, and nothing throws
      const bare = receiptsByDay(r, DEMO_NOW);
      expect(bare[0]?.label).toBe(new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(DEMO_NOW));
      expect(bare.map((g) => g.items.map((m) => m.id))).toEqual(own.map((g) => g.items.map((m) => m.id)));
    } finally {
      intl.RelativeTimeFormat = saved;
    }
    // the API back: the platform's word again, as before
    expect(receiptsByDay(r, DEMO_NOW)[0]?.label).toBe("Today");
  });

  it("screener segments mirror waiting / screened-out / spam", async () => {
    const r = (await demoEngine()).read();
    const seg = screenerSegments(r, DEMO_NOW);
    expect(seg.waiting.map((s) => s.id)).toEqual(fx.screener.waiting.map((w) => w.id));
    expect(seg.screenedOut).toHaveLength(fx.screener.screenedOut.length);
    expect(seg.spam).toHaveLength(fx.screener.spam.length);
    expect(seg.waiting[0]?.ai?.dest).toBe("ohbox");
    expect(seg.waiting[0]?.held).toHaveLength(2);
  });

  it("triage piles join message-backed states with orphan demo items", async () => {
    const r = (await demoEngine()).read();
    const piles = triagePiles(r);
    expect(piles.replyLater.map((e) => e.messageId)).toEqual(["nadja", "jonas"]);
    // Title/subtitle/preview come from the MESSAGE, not from the fixture's own copy of them —
    // `triagePiles` ignores those fields for a message-backed entry, so this is the join under
    // test. `nadja` is the fixture's second-to-last Ohbox row.
    expect(piles.replyLater[0]?.title).toBe("Nadja Lehner");
    expect(piles.replyLater[0]?.subtitle).toBe(fx.ohbox.at(-2)!.subject);
    expect(piles.replyLater[0]?.preview).toBe(fx.ohbox.at(-2)!.snippet);
    expect(piles.setAside.map((e) => e.title)).toEqual(["Alpenbahn"]);
    expect(piles.resurface).toEqual([
      expect.objectContaining({ title: "Domain renewal lichtgrat.example", resurfaceAt: "Fri 09:00" }),
    ]);
  });

  it("tags cut across views (labels on messages, tag entities for naming)", async () => {
    const r = (await demoEngine()).read();
    const groups = tagsCrossView(r);
    const byTag = Object.fromEntries(groups.map((g) => [g.tag.id, g.messages.map((m) => m.id)]));
    expect(byTag["pottery"]).toEqual(["giulia", "flurina"]); // ohbox only, date desc
    expect(byTag["buch"]?.sort()).toEqual(["erdton", "pigment"]); // cross-view: receipts
    expect(byTag["privat"]?.sort()).toEqual(["reto", "tim"]); // ohbox, seen rows
    expect(groups.find((g) => g.tag.id === "buch")?.tag.name).toBe("Paperwork");
  });

  it("unread counts match the fixture world — prototype numbers are fully derivable", async () => {
    // Counted off the live selectors: the `unreadCounts` bundle is deleted (no production
    // caller, and its folder-grouped `screenerWaiting` was wrong over a raw mirror).
    const r = (await demoEngine()).read();
    const unreadIn = (view: "ohbox" | "reads" | "receipts"): number =>
      messagesIn(r, FOLDER_OF_VIEW[view]).filter((m) => m.unread).length;
    expect(unreadIn("ohbox")).toBe(fx.counts.ohboxUnread); // 3
    // 13 — every mail is a real row. This counts the FOLDER, parked mail included, which is why
    // it is two more than the eleven `ohboxView` renders; see `fixtures/data.ts#counts`.
    const ohboxTotal = messagesIn(r, FOLDER_OF_VIEW.ohbox).length;
    expect(ohboxTotal).toBe(fx.counts.ohboxTotal);
    expect(ohboxTotal).toBe(13);
    expect(unreadIn("reads")).toBe(fx.counts.reads); // 12
    expect(unreadIn("receipts")).toBe(fx.counts.receipts); // 7
    expect(screenerSegments(r, DEMO_NOW).waiting).toHaveLength(fx.counts.screenerWaiting); // 3
    const piles = triagePiles(r);
    expect(piles.replyLater).toHaveLength(fx.counts.replyLater); // 2
    expect(piles.setAside).toHaveLength(fx.counts.setAside); // 1
    expect(piles.resurface).toHaveLength(fx.counts.resurface); // 1
  });
});

// ── Round-4 Ohbox slice: own-sent, resurfaced, participants ──────────────────

/** A hand-built reader over a flat entity list — a WHOLE {@link EntityReader}, all four members. */
function readerOf(byType: Record<string, unknown[]>): EntityReader {
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) =>
      (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    // `entries` and `version` are not optional members of the interface, and a partial fake is
    // not a reader: `winningStates` caches on the stamp, and these fixtures are frozen.
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({
      id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i,
    })),
    version: () => 1,
  };
}

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: p.id, from: { name: p.id, address: `${p.id}@ex.example` }, to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: "s", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
    ...p,
  };
}

describe("ohboxView — own-sent in Earlier", () => {
  it("files the account's own sent mail into previouslySeen, never newForYou, and marks it own-sent", () => {
    const sent = mkMsg({ id: "sent1", folder: "Sent", unread: false, date: "2026-08-03T10:00:00.000Z" });
    const inboxUnread = mkMsg({ id: "in-u", folder: "INBOX", unread: true });
    const inboxRead = mkMsg({ id: "in-r", folder: "INBOX", unread: false });
    const view = ohboxView(readerOf({ message: [sent, inboxUnread, inboxRead] }));

    expect(view.newForYou.map((m) => m.id)).toEqual(["in-u"]);
    expect(view.previouslySeen.map((m) => m.id)).toContain("sent1");
    expect(view.newForYou.map((m) => m.id)).not.toContain("sent1");
    // The predicate asks whether the row's folder is the mailbox's SENT folder; INBOX is not.
    expect(isOwnSent(sent)).toBe(true);
    expect(isOwnSent(inboxRead)).toBe(false);
  });

  it("even a no-reply own message (odd Sent folder name) sits read under Earlier", () => {
    const noReply = mkMsg({ id: "np", folder: "[Gmail]/Sent Mail", from: { name: "", address: "no-reply@ex.example" } });
    const view = ohboxView(readerOf({ message: [noReply] }));
    expect(view.previouslySeen.map((m) => m.id)).toEqual(["np"]);
    expect(view.newForYou).toHaveLength(0);
  });

  it("an Exchange-shaped sent row — folder 'Sent Items' — is own-sent and sits under Earlier", () => {
    // Every provider names its Sent folder differently and the row carries the server's own
    // name. The predicate is a POSITIVE test over exactly that family, so every one of these
    // spellings has to stay recognised: narrow it further and a sent message reads as lost.
    const exch = mkMsg({ id: "xs", folder: "Sent Items", unread: false, date: "2026-08-11T08:14:00.000Z" });
    const view = ohboxView(readerOf({ message: [exch] }));
    expect(isOwnSent(exch)).toBe(true);
    expect(view.previouslySeen.map((m) => m.id)).toEqual(["xs"]);
    expect(view.newForYou).toHaveLength(0);
  });

  it("recognises every Sent spelling a provider's resolver can produce", () => {
    for (const folder of [
      "Sent", "Sent Items", "Sent Messages", "Sent Mail",
      "INBOX/Sent", "INBOX/Sent Messages",
      "[Gmail]/Sent Mail", "[Google Mail]/Gesendet",
      "Gesendete Objekte", "Gesendete Elemente",
    ]) {
      expect(isOwnSent(mkMsg({ id: folder, folder })), folder).toBe(true);
    }
  });

  /* ── THE MAILBOX'S OWN FOLDERS ARE NOT THE ACCOUNT'S SENT MAIL ────────────────────────────
   *
   * `isOwnSent` used to be `!OHMAIL_FOLDERS.has(folder)` — every folder that is not one of the
   * six organised views — on the premise that Sent is the only other folder the worker mirrors.
   * The passive read mirrors the mailbox's WHOLE tree, with or without the "Use folders" flag,
   * so that premise made the account the author of every folder its mailbox has. Every such row
   * would then stand in "Earlier" as the account's own mail — the mailbox's whole filed history
   * flooding the one pile the person reads. The case below: the promotional row is old and
   * freshly stamped, the INBOX row is today's, and the Ohbox must show the INBOX row (the stamp
   * is state and positions nothing — the arrival ruling, 2026-09-18). */
  it("keeps the mailbox's own folders out of the Ohbox, however recently they were read", () => {
    const promo = mkMsg({
      id: "promo", folder: "Promotions", unread: false,
      date: "2026-05-08T17:17:40.000Z", lastReadAt: "2026-08-30T20:06:51.512Z",
    });
    const social = mkMsg({ id: "social", folder: "SocialNetworks", unread: false, date: "2026-06-12T09:10:57.000Z" });
    const filed = mkMsg({ id: "filed", folder: "INBOX/Random", unread: false, date: "2026-08-29T10:00:00.000Z" });
    const recent = mkMsg({ id: "recent", folder: "INBOX", unread: false, date: "2026-08-30T12:10:06.000Z" });
    const view = ohboxView(readerOf({ message: [promo, social, filed, recent] }));

    for (const m of [promo, social, filed]) expect(isOwnSent(m), m.folder).toBe(false);
    expect(view.previouslySeen.map((m) => m.id)).toEqual(["recent"]);
    // The symptom itself: the top of the Ohbox is not a message from May.
    expect(view.previouslySeen[0]?.date).toBe("2026-08-30T12:10:06.000Z");
  });
});

/* A Sent folder by another name ('Envoyés', 'INBOX.Verzonden'): the mailbox read states the
   recorded path (`setSentFolders`), and the predicate takes it beside the Sent-shaped names. */
describe("ohboxView — the mailbox's recorded Sent folder", () => {
  const own = (id: string, mailboxId: string, folder: string) =>
    mkMsg({ id, mailboxId, folder, unread: true, date: "2026-08-03T10:00:00.000Z" });

  it("own letters in a stated 'Envoyés' or 'INBOX.Verzonden' are own-sent and in Earlier", async () => {
    const engine = await demoEngine();
    try {
      expect(engine.setSentFolders([
        { id: "mb-own-fr", sentFolder: "Envoyés" }, { id: "mb-own-nl", sentFolder: "INBOX.Verzonden" },
        { id: "mb-own-nl2", sentFolder: "INBOX/Verzonden" },
      ])).toBe(true);
      const fr = own("fr", "mb-own-fr", "Envoyés");
      const nl = own("nl", "mb-own-nl", "INBOX.Verzonden");
      const nl2 = own("nl2", "mb-own-nl2", "INBOX/Verzonden");
      // The same path in a mailbox that stated none is somebody's folder, not Sent.
      const elsewhere = own("elsewhere", "mb-own-none", "Envoyés");
      const view = ohboxView(readerOf({ message: [fr, nl, nl2, elsewhere] }));
      for (const m of [fr, nl, nl2]) {
        expect(isOwnSent(m), m.folder).toBe(true);
        expect(isFromSomeone(m), m.folder).toBe(false);
      }
      expect(view.previouslySeen.map((m) => m.id).sort()).toEqual(["fr", "nl", "nl2"]);
      expect(view.newForYou).toEqual([]);
      expect(isOwnSent(elsewhere)).toBe(false);
    } finally {
      engine.setSentFolders([]);
    }
  });

  it("a stated INBOX is never Sent: an unread INBOX letter stays in New for you", async () => {
    const engine = await demoEngine();
    try {
      engine.setSentFolders([{ id: "mb-own-inbox", sentFolder: "INBOX" }]);
      const letter = mkMsg({ id: "in", mailboxId: "mb-own-inbox", folder: "INBOX", unread: true });
      expect(isOwnSent(letter)).toBe(false);
      expect(ohboxView(readerOf({ message: [letter] })).newForYou.map((m) => m.id)).toEqual(["in"]);
    } finally {
      engine.setSentFolders([]);
    }
  });

  it("restating null, or leaving the mailbox out, clears it", async () => {
    const engine = await demoEngine();
    try {
      const fr = own("fr", "mb-own-fr", "Envoyés");
      const nl = own("nl", "mb-own-nl", "INBOX.Verzonden");
      engine.setSentFolders([{ id: "mb-own-fr", sentFolder: "Envoyés" }, { id: "mb-own-nl", sentFolder: "INBOX.Verzonden" }]);
      expect(engine.setSentFolders([{ id: "mb-own-fr", sentFolder: null }, { id: "mb-own-nl", sentFolder: "INBOX.Verzonden" }])).toBe(true);
      expect(isOwnSent(fr)).toBe(false);
      expect(isOwnSent(nl)).toBe(true);
      expect(engine.setSentFolders([{ id: "mb-own-fr" }])).toBe(true);
      expect(isOwnSent(nl)).toBe(false);
    } finally {
      engine.setSentFolders([]);
    }
  });

  it("a statement re-derives the views; an identical one changes nothing", async () => {
    const engine = await demoEngine();
    try {
      const before = ohboxView(engine.read());
      const v0 = engine.read().version();
      expect(engine.setSentFolders([{ id: "mb-own-fr", sentFolder: "Envoyés" }])).toBe(true);
      // MUTATION WATCHED: without the overlay bump the memoized view of the old answer comes back.
      expect(ohboxView(engine.read())).not.toBe(before);
      const v1 = engine.read().version();
      expect(v1).not.toBe(v0);
      // MUTATION WATCHED: without the equality gate every poll re-derives the whole mirror.
      expect(engine.setSentFolders([{ id: "mb-own-fr", sentFolder: "Envoyés" }])).toBe(false);
      expect(engine.read().version()).toBe(v1);
      // A Sent-shaped name is no statement: names already decide it.
      expect(engine.setSentFolders([{ id: "mb-own-fr", sentFolder: "Envoyés" }, { id: "mb-own-en", sentFolder: "Sent" }])).toBe(false);
    } finally {
      engine.setSentFolders([]);
    }
  });
});

describe("ohboxView — resurfaced pinned at the top", () => {
  const resurfacedTriage = (id: string): EngineMessage["triage"] =>
    ({ messageId: id, state: "resurfaced", bubbleUpAt: null, setAt: "x", updatedAt: "x" } as unknown as EngineMessage["triage"]);

  it("pins resurfaced INBOX mail in its own group, out of newForYou and previouslySeen", () => {
    const res = mkMsg({ id: "r1", folder: "INBOX", unread: true, triage: resurfacedTriage("r1") });
    const fresh = mkMsg({ id: "n1", folder: "INBOX", unread: true });
    const older = mkMsg({ id: "e1", folder: "INBOX", unread: false });
    const view = ohboxView(readerOf({ message: [res, fresh, older] }));

    expect(view.resurfaced.map((m) => m.id)).toEqual(["r1"]);
    expect(view.newForYou.map((m) => m.id)).toEqual(["n1"]);
    expect(view.previouslySeen.map((m) => m.id)).toEqual(["e1"]);
  });

  /**
   * THE PIN IS STATE-DRIVEN, NEVER FOLDER-DRIVEN — the orphan guard.
   *
   * `resurfaced` has exactly one home in the product: this group. It is no bottom pile
   * (`triagePiles` ignores it by design), so a resurfaced row this group declines is a row NO
   * view files — which is precisely what happened on a live mailbox when the pin was computed
   * from the INBOX slice: a message whose presented folder was not the Ohbox's came due, left
   * the Resurface pile with the flip, and vanished from every list while staying reachable by
   * search. A mutation that re-scopes the pin to `inbox.filter(...)` turns BOTH of these red.
   */
  it("pins a resurfaced row REGARDLESS of folder — a row this group declines is filed nowhere", () => {
    const reads = mkMsg({ id: "r-reads", folder: "ohmail/News", unread: true, triage: resurfacedTriage("r-reads") });
    const screener = mkMsg({ id: "r-scr", folder: "ohmail/Screener", unread: false, triage: resurfacedTriage("r-scr") });
    const view = ohboxView(readerOf({ message: [reads, screener] }));

    expect(view.resurfaced.map((m) => m.id).sort()).toEqual(["r-reads", "r-scr"]);
    // …and exactly once: never doubled into the folder groups.
    expect(view.newForYou).toEqual([]);
    expect(view.previouslySeen).toEqual([]);
  });

  it("a READ resurfaced row STAYS pinned — the pin is spent by state change, not by the flag", () => {
    // Reading through the product clears the state server-side (`spendResurface`) and the row
    // leaves this group as a re-partition. A row that is resurfaced-and-read (e.g. read in
    // another client, pin not yet spent) belongs to the pin, not to "Earlier".
    const readPinned = mkMsg({ id: "rp", folder: "INBOX", unread: false, triage: resurfacedTriage("rp") });
    const view = ohboxView(readerOf({ message: [readPinned] }));
    expect(view.resurfaced.map((m) => m.id)).toEqual(["rp"]);
    expect(view.previouslySeen).toEqual([]);
  });

  it("a resurfaced row in a NON-ORGANISED folder is pinned, not filed as own-sent", () => {
    const oddFolder = mkMsg({ id: "os", folder: "Sent", unread: false, triage: resurfacedTriage("os") });
    const view = ohboxView(readerOf({ message: [oddFolder] }));
    expect(view.resurfaced.map((m) => m.id)).toEqual(["os"]);
    expect(view.previouslySeen).toEqual([]);
  });
});

describe("threadParticipants", () => {
  it("returns the distinct senders newest-first, capped at three, and [] for a single-sender or lone thread", () => {
    const msgs = [
      mkMsg({ id: "m1", threadId: "T", from: { name: "A", address: "a@ex.example" }, date: "2026-08-01T00:00:00Z" }),
      mkMsg({ id: "m2", threadId: "T", from: { name: "B", address: "b@ex.example" }, date: "2026-08-02T00:00:00Z" }),
      mkMsg({ id: "m3", threadId: "T", from: { name: "A", address: "a@ex.example" }, date: "2026-08-03T00:00:00Z" }),
      mkMsg({ id: "m4", threadId: "T", from: { name: "C", address: "c@ex.example" }, date: "2026-08-04T00:00:00Z" }),
      mkMsg({ id: "m5", threadId: "T", from: { name: "D", address: "d@ex.example" }, date: "2026-08-05T00:00:00Z" }),
      mkMsg({ id: "solo", threadId: "S", from: { name: "A", address: "a@ex.example" } }),
      mkMsg({ id: "sole", threadId: "S", from: { name: "A", address: "a@ex.example" } }),
    ];
    const r = readerOf({ message: msgs });
    // Newest voice first: D, C, A — capped at 3, and B never reached.
    expect(threadParticipants(r, "T").map((a) => a.address)).toEqual(["d@ex.example", "c@ex.example", "a@ex.example"]);
    // A thread of one distinct sender is not a conversation of people.
    expect(threadParticipants(r, "S")).toEqual([]);
    expect(threadParticipants(r, "none")).toEqual([]);
  });

  /**
   * THE INDEX AND THE PER-THREAD SELECTOR ARE ONE ANSWER.
   *
   * Every mail list draws these circles, so the shell reads them out of a map built once per
   * engine version rather than scanning the mirror once per row. Two implementations of "who is
   * in this conversation" would be two answers, and which one a row drew would depend on which
   * surface drew it — so both go through one core, and this is what says so.
   */
  it("indexes every thread in one pass, agreeing with the per-thread selector", () => {
    const msgs = [
      mkMsg({ id: "m1", threadId: "T", from: { name: "A", address: "a@ex.example" }, date: "2026-08-01T00:00:00Z" }),
      mkMsg({ id: "m2", threadId: "T", from: { name: "B", address: "b@ex.example" }, date: "2026-08-02T00:00:00Z" }),
      mkMsg({ id: "m3", threadId: "T", from: { name: "A", address: "a@ex.example" }, date: "2026-08-03T00:00:00Z" }),
      mkMsg({ id: "m4", threadId: "T", from: { name: "C", address: "c@ex.example" }, date: "2026-08-04T00:00:00Z" }),
      mkMsg({ id: "m5", threadId: "T", from: { name: "D", address: "d@ex.example" }, date: "2026-08-05T00:00:00Z" }),
      mkMsg({ id: "u1", threadId: "U", from: { name: "E", address: "e@ex.example" }, date: "2026-08-01T00:00:00Z" }),
      mkMsg({ id: "u2", threadId: "U", from: { name: "F", address: "f@ex.example" }, date: "2026-08-02T00:00:00Z" }),
      mkMsg({ id: "solo", threadId: "S", from: { name: "A", address: "a@ex.example" } }),
      mkMsg({ id: "sole", threadId: "S", from: { name: "A", address: "a@ex.example" } }),
      mkMsg({ id: "loose", threadId: null, from: { name: "G", address: "g@ex.example" } }),
    ];
    const r = readerOf({ message: msgs });
    const index = threadParticipantsIndex(r);
    for (const threadId of ["T", "U", "S", "none"])
      expect(index.get(threadId) ?? []).toEqual(threadParticipants(r, threadId));
    // A thread with no conversation of people in it is ABSENT, not present-and-empty: a lookup
    // needs no second check, and a threadless message contributes no key at all.
    expect([...index.keys()].sort()).toEqual(["T", "U"]);
  });

  /**
   * A held stranger is no voice of the conversation a header threaded them into: a reply held at
   * the gate or quarantined draws no circle on a placed row, in either form. MUTATION WATCHED: drop
   * the held filter and the stranger leads the stack. A pinned held row is the person's own act.
   */
  it("a held stranger is no participant, in the index or per thread", () => {
    const msgs = [
      mkMsg({ id: "m1", threadId: "T", from: { name: "A", address: "a@ex.example" }, date: "2026-08-01T00:00:00Z" }),
      mkMsg({ id: "m2", threadId: "T", from: { name: "B", address: "b@ex.example" }, date: "2026-08-02T00:00:00Z" }),
      mkMsg({ id: "h1", threadId: "T", folder: "ohmail/Screener", from: { name: "S", address: "s@ex.example" }, date: "2026-08-03T00:00:00Z" }),
      mkMsg({ id: "h2", threadId: "T", folder: "ohmail/Quarantine", from: { name: "Q", address: "q@ex.example" }, date: "2026-08-04T00:00:00Z" }),
    ];
    const r = readerOf({ message: msgs });
    expect(threadParticipants(r, "T").map((a) => a.address)).toEqual(["b@ex.example", "a@ex.example"]);
    expect(threadParticipantsIndex(r).get("T")?.map((a) => a.address)).toEqual(["b@ex.example", "a@ex.example"]);
    const pinned = readerOf({ message: msgs.map((m) => (m.id === "h1" ? { ...m, triage: { messageId: "h1", state: "resurfaced", bubbleUpAt: null, setAt: "2026-08-05T00:00:00Z", updatedAt: "2026-08-05T00:00:00Z" } } : m)) });
    expect(threadParticipants(pinned, "T").map((a) => a.address)).toEqual(["s@ex.example", "b@ex.example", "a@ex.example"]);
  });

  it("tracks the mirror — a new voice lands in the index the pass after it arrives", () => {
    const base = [
      mkMsg({ id: "m1", threadId: "T", from: { name: "A", address: "a@ex.example" }, date: "2026-08-01T00:00:00Z" }),
      mkMsg({ id: "m2", threadId: "T", from: { name: "A", address: "a@ex.example" }, date: "2026-08-02T00:00:00Z" }),
    ];
    // one voice so far: no conversation of people, so no key.
    expect(threadParticipantsIndex(readerOf({ message: base })).has("T")).toBe(false);
    const replied = [
      ...base,
      mkMsg({ id: "m3", threadId: "T", from: { name: "B", address: "b@ex.example" }, date: "2026-08-03T00:00:00Z" }),
    ];
    expect(
      threadParticipantsIndex(readerOf({ message: replied })).get("T")?.map((a) => a.address),
    ).toEqual(["b@ex.example", "a@ex.example"]);
  });
});
