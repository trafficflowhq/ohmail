import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  MutationRejectedError,
  FOLDER_OF_VIEW,
  messagesIn,
  ohboxView,
  receiptsByDay,
  screenerSegments,
  tagsCrossView,
  triagePiles,
  feedPartition,
  readsPartition,
  type EngineAdapter,
  type EntityReader,
  type EngineDraft,
  type EngineMessage,
  type MutationOutcome,
  type RuleDTO,
  type SyncChange,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/** Optimistic mutations against the FixturesAdapter (the ?demo backend). */

async function demoEngine(adapter?: EngineAdapter): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter: adapter ?? new FixturesAdapter(), now: () => DEMO_NOW });
  await engine.start();
  return engine;
}

/** Unread rows of one stream FOLDER — the deleted `unreadCounts` bundle's live derivation (deleted for having no production caller). */
const unreadIn = (r: EntityReader, view: "ohbox" | "reads" | "receipts"): number =>
  messagesIn(r, FOLDER_OF_VIEW[view]).filter((m) => m.unread).length;

describe("screener decisions", () => {
  it("Yes files the held mail; '&read' lands it previously-seen; a promoted rule appears", async () => {
    const engine = await demoEngine();
    const before = ohboxView(engine.read());
    expect(before.previouslySeen).toHaveLength(8);

    const res = await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    expect(res.status).toBe("confirmed");

    const r = engine.read();
    expect(screenerSegments(r, DEMO_NOW).waiting.map((s) => s.id)).toEqual(["paperbird", "jackpot"]);
    const after = ohboxView(r);
    // 2 held mails filed into the Ohbox ALREADY SEEN (the &read semantics). "New for you" is the
    // fixture's three unread rows and nothing this decision did changes it; the demo's two PARKED
    // rows (nadja, jonas — Answer Later) are read, and in no Ohbox group either way.
    expect(after.newForYou).toHaveLength(3); // unchanged
    expect(after.previouslySeen).toHaveLength(10); // +2, unread=false
    expect(after.previouslySeen.some((m) => m.subject === "Werkstatt-Besuch nächste Woche?")).toBe(true);

    const rule = r.list<RuleDTO>("rule").find((x) => x.match === "lena@atelier-eichspan.example");
    expect(rule).toMatchObject({ kind: "sender", destination: "INBOX", provenance: "promoted", enabled: true });
  });

  it("Yes WITHOUT &read lands the held mail in new-for-you", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes" });
    const after = ohboxView(engine.read());
    expect(after.newForYou).toHaveLength(5); // +2 unread, over the fixture's 3 unread rows
    expect(after.previouslySeen).toHaveLength(8);
  });

  it("No (scope: domain) screens the sender out and promotes a domain rule to Screened", async () => {
    const engine = await demoEngine();
    const res = await engine.mutate({ kind: "screener_decide", senderId: "jackpot", decision: "no", scope: "domain" });
    expect(res.status).toBe("confirmed");

    const r = engine.read();
    const seg = screenerSegments(r, DEMO_NOW);
    expect(seg.waiting.map((s) => s.id)).toEqual(["lena", "paperbird"]);
    expect(seg.screenedOut.some((s) => s.from.address === "win@jackpotjodel-alerts.example")).toBe(true);
    const rule = r.list<RuleDTO>("rule").find((x) => x.match === "jackpotjodel-alerts.example");
    expect(rule).toMatchObject({ kind: "domain", destination: "ohmail/Screened", provenance: "promoted" });
  });
});

describe("move / triage / tags / feed / draft", () => {
  it("move refiles across views instantly and stays after the echo", async () => {
    const engine = await demoEngine();
    const res = await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" });
    expect(res.status).toBe("confirmed");
    expect(res.seq).toBeGreaterThan(0);

    const r = engine.read();
    expect(r.get<EngineMessage>("message", "giulia")?.folder).toBe("ohmail/Receipts");
    // `giulia` left the Ohbox because its FOLDER changed; the other two unread rows stand.
    expect(ohboxView(r).newForYou.map((m) => m.id)).toEqual([
      "petra",
      "ben",
    ]);
    const receiptIds = receiptsByDay(r, DEMO_NOW).flatMap((g) => g.items.map((m) => m.id));
    expect(receiptIds).toContain("giulia");

    await engine.syncOnce(); // the delta must not disagree with the echo
    expect(engine.read().get<EngineMessage>("message", "giulia")?.folder).toBe("ohmail/Receipts");
  });

  it("triage set adds to a pile; state none removes", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "triage_set", messageId: "cinderlock", state: "reply_later" });
    // In the pile's own order (arrival, newest first), not at the end: `triage-pile-order.test.ts`.
    expect(triagePiles(engine.read()).replyLater.map((e) => e.messageId)).toEqual(["cinderlock", "nadja", "jonas"]);

    await engine.mutate({ kind: "triage_set", messageId: "cinderlock", state: "none" });
    expect(triagePiles(engine.read()).replyLater.map((e) => e.messageId)).toEqual(["nadja", "jonas"]);
  });

  it("tag assign/unassign updates the cross-view instantly", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "tag_assign", messageId: "alpenbahn", tagId: "buch", assigned: true });
    let buch = tagsCrossView(engine.read()).find((g) => g.tag.id === "buch")!;
    expect(buch.messages.map((m) => m.id).sort()).toEqual(["alpenbahn", "erdton", "pigment"]);

    await engine.mutate({ kind: "tag_assign", messageId: "alpenbahn", tagId: "buch", assigned: false });
    buch = tagsCrossView(engine.read()).find((g) => g.tag.id === "buch")!;
    expect(buch.messages.map((m) => m.id).sort()).toEqual(["erdton", "pigment"]);
  });

  it("feed mark-seen without an anchor sweeps \\Seen and leaves the waterline ALONE", async () => {
    // The line is "new since last visit": it moves exactly once, on the leave commit, and a
    // sweep that passes no `upToId` may not drag it around mid-visit. (It used to default the
    // anchor to the newest message, which re-partitioned the pile under the reader on every
    // dwell-mark.)
    const engine = await demoEngine();
    expect(unreadIn(engine.read(), "reads")).toBe(12);
    const res = await engine.mutate({ kind: "feed_mark_seen" });
    expect(res.status).toBe("confirmed");
    const r = engine.read();
    expect(unreadIn(r, "reads")).toBe(0);
    expect(readsPartition(r).waterline?.newestSeenId).toBe("f13"); // the fixture's line, untouched
  });

  it("an ANCHORED feed mark-seen commits the line ABOVE the anchor — leave-at-top ⇒ nothing fresh", async () => {
    // The leave commit: the anchor is the newest message that was on screen, and the cut is
    // exclusive — the anchor was SEEN, so it may not present as "new since last visit". A
    // visit that saw the top of the pile therefore leaves the line above everything.
    const engine = await demoEngine();
    const res = await engine.mutate({ kind: "feed_mark_seen", view: "reads", upToId: "f1" });
    expect(res.status).toBe("confirmed");
    const part = readsPartition(engine.read());
    expect(part.waterline?.newestSeenId).toBe("f1");
    expect(part.fresh).toEqual([]); // the line stands above the whole pile
    expect(part.seen.map((m) => m.id)[0]).toBe("f1");
  });

  /**
   * THE PER-VIEW CONTRACT — the successor to the old "Reads-only by construction" comment.
   * One widened verb, two independent waterlines: a Receipts leave writes
   * `receipts_waterline` and flips Receipts mail, and Reads' line and Reads' unread mail do
   * not move a hair. Collapse the `view` parameter inside `mutationEffects` (hard-code the
   * folder or the meta id) and both halves of this go red.
   */
  it("a Receipts commit moves RECEIPTS' waterline and never Reads' (view independence)", async () => {
    const engine = await demoEngine();
    const readsBefore = readsPartition(engine.read());
    const receipts = feedPartition(engine.read(), "receipts");
    expect(receipts.waterline).toBeNull(); // no line until a first leave commits one
    const newestReceipt = receipts.fresh[0]!;

    const res = await engine.mutate({
      kind: "feed_mark_seen",
      view: "receipts",
      upToId: newestReceipt.id,
      messageIds: [newestReceipt.id],
    });
    expect(res.status).toBe("confirmed");

    const r = engine.read();
    const receiptsAfter = feedPartition(r, "receipts");
    expect(receiptsAfter.waterline?.newestSeenId).toBe(newestReceipt.id);
    expect(receiptsAfter.fresh).toEqual([]);
    // Reads: same line, same unread count — the other stream's leave is not this stream's.
    expect(readsPartition(r).waterline?.newestSeenId).toBe(readsBefore.waterline?.newestSeenId);
    expect(unreadIn(r, "reads")).toBe(12);
  });

  /**
   * THE LINE SURVIVES ITS OWN MUTATION CONFIRMING — the wire modelled truthfully.
   *
   * On a live account `feed_mark_seen`'s wire side is per-message PATCHes and nothing else:
   * `/sync` has no `view_meta` entity type, so no drain will ever deliver the waterline back.
   * Until the engine persisted `view_meta` effects past the overlay (`dispatch` → `putLocal`),
   * the line existed only while its mutation was in flight and evaporated on confirm — which
   * is why "seen up to here" never held still outside the demo. This adapter strips
   * `view_meta` from every sync page and echoes no changes, exactly the live shape; the line
   * must still be there after the confirm and its reconciling drain. Delete the `putLocal`
   * loop in `dispatch` and this goes red.
   */
  it("an anchored commit's waterline OUTLIVES the overlay on a wire that never echoes it", async () => {
    const inner = new FixturesAdapter();
    const strip = (arr: SyncChange[]): SyncChange[] => arr.filter((c) => c.type !== "view_meta");
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      async sync(p: SyncParams): Promise<SyncResponse> {
        const resp = await inner.sync(p);
        return {
          ...resp,
          changes: {
            creates: strip(resp.changes.creates),
            updates: strip(resp.changes.updates),
            moves: strip(resp.changes.moves),
            deletes: strip(resp.changes.deletes),
          },
        };
      },
      async mutate(m, o): Promise<MutationOutcome> {
        const out = await inner.mutate(m, o); // the server commits the flips…
        return { changes: [], seq: out.seq };  // …and echoes nothing, like the live routes
      },
    };
    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();
    expect(readsPartition(engine.read()).waterline).toBeNull(); // stripped — the live posture

    const res = await engine.mutate({ kind: "feed_mark_seen", view: "reads", upToId: "f1", messageIds: ["f1"] });
    expect(res.status).toBe("confirmed");
    // The overlay is gone and the drain carried no view_meta; the MIRROR must hold the line.
    expect(readsPartition(engine.read()).waterline?.newestSeenId).toBe("f1");
  });

  it("a Reads id handed to a RECEIPTS commit is dropped by construction — the mutation rejects", async () => {
    // The wire-parity rule, per view: the optimistic effect filters to the view's folder, so
    // an id from another pile produces no effect at all and the engine rejects locally
    // instead of letting the wire flip a row the overlay did not.
    const engine = await demoEngine();
    const readsId = readsPartition(engine.read()).fresh[0]!.id;
    const res = await engine.mutate({ kind: "feed_mark_seen", view: "receipts", messageIds: [readsId] });
    expect(res.status).toBe("rolled_back");
    expect(unreadIn(engine.read(), "reads")).toBe(12);
  });

  it("mark_seen flips read-state ANYWHERE — Ohbox and Receipts, not just Reads", async () => {
    // What `feed_mark_seen` cannot do. Its optimistic effect filters to `ohmail/News`, so an
    // Ohbox id passed to it produces no local effect at all while its wire side PATCHes the
    // message anyway. This asserts the folder-agnostic behaviour directly.
    const engine = await demoEngine();
    expect(unreadIn(engine.read(), "ohbox")).toBe(3);

    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["petra", "ben"], unread: false });
    expect(res.status).toBe("confirmed");

    const r = engine.read();
    // Both halves of the batch flip: on the entity, and in the view they leave. The unread
    // row this batch did not name stays put, so an effect that swept the folder rather than
    // the named ids would show up here as an empty group.
    expect(r.get<EngineMessage>("message", "petra")?.unread).toBe(false);
    expect(ohboxView(r).newForYou.map((m) => m.id)).toEqual(["giulia"]);
    expect(unreadIn(r, "ohbox")).toBe(1);
  });

  it("mark_seen puts a message BACK to unread — the `u` key is the same mutation", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(engine.read().get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true });
    expect(engine.read().get<EngineMessage>("message", "giulia")?.unread).toBe(true);
  });

  it("draft accept flips the stored draft", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "draft_accept", draftId: "draft-compose" });
    expect(engine.read().get<EngineDraft>("draft", "draft-compose")?.accepted).toBe(true);
  });
});

describe("failure semantics (user-always-wins until a hard verdict)", () => {
  it("a hard rejection rolls the optimistic overlay back", async () => {
    const inner = new FixturesAdapter();
    const rejecting: EngineAdapter = {
      sync: (p) => inner.sync(p),
      mutate: async () => {
        throw new MutationRejectedError("nope", { status: 422, code: "unprocessable", retryable: false });
      },
    };
    const engine = await demoEngine(rejecting);

    const res = await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("unprocessable");
    expect(engine.read().get<EngineMessage>("message", "giulia")?.folder).toBe("INBOX");
    expect(engine.pendingMutations()).toHaveLength(0);
  });

  it("an unknown target rejects without leaving an overlay", async () => {
    const engine = await demoEngine();
    const res = await engine.mutate({ kind: "move", messageId: "no-such-id", folder: "ohmail/News" });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("not_found");
  });

  it("a network failure keeps the optimistic state queued; the retry replays the SAME key without double-applying", async () => {
    const inner = new FixturesAdapter();
    let dropResponse = true;
    const flaky: EngineAdapter = {
      sync: (p) => inner.sync(p),
      mutate: async (m, o) => {
        // The request REACHES the server (it applies), but the response is lost.
        const out = await inner.mutate(m, o);
        if (dropResponse) {
          dropResponse = false;
          throw new MutationRejectedError("socket closed", { code: "network", retryable: true });
        }
        return out;
      },
    };
    const engine = await demoEngine(flaky);

    const res = await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    expect(res.status).toBe("queued");
    // User-always-wins: the decision stays visible while queued.
    expect(screenerSegments(engine.read(), DEMO_NOW).waiting.map((s) => s.id)).toEqual(["paperbird", "jackpot"]);
    expect(engine.pendingMutations()).toHaveLength(1);

    const [retry] = await engine.flushPending();
    expect(retry?.status).toBe("confirmed");
    expect(retry?.key).toBe(res.key); // SAME Idempotency-Key on the wire

    // The idempotent replay did NOT mint the held mail twice.
    const lenaMail = engine.read().list<EngineMessage>("message")
      .filter((m) => m.from.address === "lena@atelier-eichspan.example");
    expect(lenaMail).toHaveLength(2);
    expect(engine.pendingMutations()).toHaveLength(0);
  });
});

/**
 * THE RESURFACE PIN'S OVERLAY PARITY — the same server rules, painted at press time.
 *
 * The server pins on the resurface event WITHOUT touching read state (`TriageService.setState`
 * since the 2026-08-26 ruling — placement is the signal, the message keeps its genuine read
 * state) and spends the pin when the row is deliberately read or re-filed (`spendResurface`,
 * all routes). Wire parity demands the overlay agree on every one of these, or the pin
 * flickers: painted differently at press time than after the drain.
 */
describe("the resurface pin — overlay parity", () => {
  it("resurface_now pins WITHOUT touching read state — a read message stays read", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    const before = engine.read().get<EngineMessage>("message", "giulia")!;
    expect(before.unread).toBe(false);
    expect(before.lastReadAt).not.toBeNull();

    const res = await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "resurfaced" });
    expect(res.status).toBe("confirmed");
    const r = engine.read();
    // GENUINE state kept: no artificial unread, the reading is not disowned (owner, 2026-08-26).
    expect(r.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    expect(r.get<EngineMessage>("message", "giulia")?.lastReadAt).toBe(before.lastReadAt);
    expect(ohboxView(r).resurfaced.map((m) => m.id)).toEqual(["giulia"]);
  });

  it("marking a pinned row READ spends the pin and files it under Earlier — in one gesture", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "resurfaced" });
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });

    const view = ohboxView(engine.read());
    expect(view.resurfaced).toEqual([]);
    expect(view.previouslySeen.map((m) => m.id)).toContain("giulia");
  });

  it("marking a pinned row UNREAD leaves the pin exactly where it is", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "resurfaced" });
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true });
    expect(ohboxView(engine.read()).resurfaced.map((m) => m.id)).toEqual(["giulia"]);
  });

  it("re-filing a pinned row spends the pin — the state, not the folder, is what ends it", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "resurfaced" });
    await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" });

    const r = engine.read();
    expect(ohboxView(r).resurfaced).toEqual([]);
    expect(r.get<EngineMessage>("message", "giulia")?.triage?.state).toBe("none");
    expect(r.get<EngineMessage>("message", "giulia")?.folder).toBe("ohmail/News");
  });

  it("a SNOOZE (bubbled_up) does not touch read state either", async () => {
    const engine = await demoEngine();
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    await engine.mutate({
      kind: "triage_set", messageId: "giulia", state: "bubbled_up", bubbleUpAt: "2026-09-04T09:00:00.000Z",
    });
    expect(engine.read().get<EngineMessage>("message", "giulia")?.unread).toBe(false);
  });
});
