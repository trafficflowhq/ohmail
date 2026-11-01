import { describe, expect, it } from "vitest";
import { getFixtures } from "@ohmail/fixtures";
import {
  DEMO_NOW,
  FixturesAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  mutationEffects,
  presentationReader,
  screenerSegments,
  type EngineMessage,
  type Folder,
  type RuleDTO,
  type ScreenerSenderDTO,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * THE SCREENER, DERIVED FROM THE MESSAGE MIRROR.
 *
 * A measurement on the hosted service produced this: two thirds of the messages sat in
 * `ohmail/Screener` from 72 distinct first-contact senders, and the Screener rendered
 * "all clear". `screener_sender` is a client-local entity — `/sync` never carried one —
 * so the product's signature feature did not exist on any Cloud account.
 *
 * The fix changes NO wire vocabulary: the server's own queue is already a derivation
 * ("DERIVED (no separate table)", `screener-service.ts:88-92`), so grouping the mirror
 * the same way reproduces it, and the representative message id a derived row carries is
 * exactly what `POST /screener/:id` resolves.
 *
 * These are unit guards over the selector and the optimistic effect. The proof that the
 * whole ruling holds against the REAL server is in `contract.test.ts`.
 */

const NOW = new Date("2026-08-02T12:00:00.000Z");

let seq = 0;

function msg(o: {
  id: string;
  from: string;
  name?: string;
  folder: Folder;
  subject?: string;
  snippet?: string;
  date?: string;
  unread?: boolean;
  /** The sensitivity flag the automatic classification reads — see the `noAi` case below. */
  noAi?: boolean;
}): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: o.subject ?? `Subject ${o.id}`,
    from: { name: o.name ?? null, address: o.from },
    to: [],
    cc: [],
    date: o.date ?? "2026-08-02T09:00:00.000Z",
    folder: o.folder,
    snippet: o.snippet ?? `snippet ${o.id}`,
    unread: o.unread ?? true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null,
      no_ai: o.noAi === true,
      no_forward: false, no_kb: false, priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

/** A mirror holding exactly these messages — no fixtures, i.e. a Cloud account. */
async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const changes: SyncChange[] = messages.map((m) => ({
    type: "message",
    op: "create",
    id: m.id,
    seq: ++seq,
    updatedAt: m.updatedAt,
    entity: m,
  }));
  await store.applyChanges(changes);
  return store;
}

/** 3 senders, 6 held messages — the production shape in miniature. */
const HELD: EngineMessage[] = [
  msg({ id: "m1", from: "lena@atelier.example", name: "Lena Roth", folder: "ohmail/Screener", date: "2026-08-02T08:00:00.000Z" }),
  msg({ id: "m2", from: "Lena@Atelier.Example", name: "Lena Roth", folder: "ohmail/Screener", date: "2026-08-02T09:30:00.000Z" }),
  msg({ id: "m3", from: "lena@atelier.example", name: "Lena Roth", folder: "ohmail/Screener", date: "2026-08-02T10:15:00.000Z" }),
  msg({ id: "m4", from: "hello@paperbird.example", folder: "ohmail/Screener", date: "2026-08-01T14:00:00.000Z" }),
  msg({ id: "m5", from: "hello@paperbird.example", folder: "ohmail/Screener", date: "2026-08-02T07:00:00.000Z" }),
  msg({ id: "m6", from: "win@jackpot.example", folder: "ohmail/Screener", date: "2026-08-02T06:00:00.000Z" }),
  // Not held: these three must not appear in the waiting segment at all.
  msg({ id: "i1", from: "known@friend.example", folder: "INBOX" }),
  msg({ id: "i2", from: "news@feed.example", folder: "ohmail/News" }),
  msg({ id: "i3", from: "shop@store.example", folder: "ohmail/Receipts" }),
];

describe("screenerSegments derives the queue from the message mirror", () => {
  it("N held messages from M senders yield M waiting rows covering all N", async () => {
    // THE GUARD. Widen or drop the folder predicate in `screenerSegments()` — e.g. let
    // any folder into the `waiting` bucket — and this goes red on both counts at once:
    // the row count becomes 6 (INBOX/Reads/Receipts senders join the queue) and the held
    // total stops matching the Screener population.
    const store = await mirrorOf(HELD);
    const seg = screenerSegments(store, NOW);

    const inScreener = HELD.filter((m) => m.folder === "ohmail/Screener");
    expect(inScreener).toHaveLength(6);
    expect(seg.waiting).toHaveLength(3);
    expect(seg.waiting.flatMap((s) => s.held)).toHaveLength(inScreener.length);
    expect(seg.screenedOut).toEqual([]);
    expect(seg.spam).toEqual([]);

    // The rail badge — 0 before this slice on every Cloud account. Counted straight off the
    // segments: the `unreadCounts` bundle is deleted (no production caller, and its
    // folder-grouped `screenerWaiting` was the wrong figure over a raw mirror).
    expect(screenerSegments(store, NOW).waiting).toHaveLength(3);

    // The row id IS the representative message id (the newest), which is what
    // `POST /screener/:id` resolves. Rows are newest-sender-first.
    expect(seg.waiting.map((s) => s.id)).toEqual(["m3", "m5", "m6"]);
    expect(seg.waiting[0]!.from.address).toBe("lena@atelier.example");
    expect(seg.waiting[0]!.derived).toBe(true);
    expect(seg.waiting[0]!.initial).toBe("L");
  });

  it("NO-COLLAPSE: held enumerates every message the sender holds, oldest first", async () => {
    // Invariant #6 (`types.ts:222-226`): there is deliberately no `heldCount` beside
    // `held`, because a count that is not `held.length` can drift and a "last body" is
    // how held mail becomes hidden mail. Truncate the held list in `screenerSegments()`
    // — `.slice(0, 1)`, `.slice(-1)`, anything — and this goes red.
    const store = await mirrorOf(HELD);
    const seg = screenerSegments(store, NOW);

    for (const row of seg.waiting) {
      const mine = HELD.filter(
        (m) => m.folder === "ohmail/Screener" && m.from.address.toLowerCase() === row.from.address.toLowerCase(),
      );
      expect(row.held).toHaveLength(mine.length);
      expect(new Set(row.held.map((h) => h.id))).toEqual(new Set(mine.map((m) => m.id)));
    }

    // Case-folded grouping: "Lena@Atelier.Example" is the same sender as
    // "lena@atelier.example" — the server lower-cases identically.
    const lena = seg.waiting.find((s) => s.from.address.toLowerCase() === "lena@atelier.example")!;
    expect(lena.held.map((h) => h.id)).toEqual(["m1", "m2", "m3"]); // oldest first

    // Every held message carries its own identity and readable content — never a slot.
    for (const h of lena.held) {
      expect(h.id).toBeTruthy();
      expect(h.subject).toBeTruthy();
      expect(h.body).toBeTruthy();
    }
  });

  it("screened-out and spam derive from ohmail/Screened and ohmail/Quarantine", async () => {
    const store = await mirrorOf([
      msg({ id: "s1", from: "cold@outreach.example", folder: "ohmail/Screened", date: "2026-07-21T09:00:00.000Z" }),
      msg({ id: "s2", from: "cold@outreach.example", folder: "ohmail/Screened", date: "2026-07-22T09:00:00.000Z" }),
      msg({ id: "q1", from: "win@jackpot.example", folder: "ohmail/Quarantine" }),
    ]);
    const seg = screenerSegments(store, NOW);
    expect(seg.waiting).toEqual([]);
    expect(seg.screenedOut.map((s) => s.id)).toEqual(["s2"]);
    expect(seg.screenedOut[0]!.held).toHaveLength(2);
    expect(seg.screenedOut[0]!.screenedOn).toBe("22 Jul");
    expect(seg.spam.map((s) => s.id)).toEqual(["q1"]);
  });

  it("DEGRADATION, stated: no AI suggestion on a derived row", async () => {
    // Not papered over: `apps/api-vercel` injects no classifier (`screener-service.ts:33`), so
    // a derived row has no suggestion and says so rather than showing a fabricated hint.
    const store = await mirrorOf([msg({ id: "m1", from: "x@y.example", folder: "ohmail/Screener", snippet: "the only text there is" })]);
    const row = screenerSegments(store, NOW).waiting[0]!;
    expect(row.ai).toBeNull();
  });

  it("A `no_ai` REPRESENTATIVE IS MARKED, so the row can say why nothing arrived by itself", async () => {
    /* `core/src/pipeline.ts` keeps `no_ai` mail out of the automatic classification on every door,
       so such a row is not waiting for a pass to reach it — it was never going to be reached. The
       flag rides the row because the surface has no other way to tell that apart from "nobody has
       asked yet", and the two want opposite sentences. Only ever `true`: absent means "not that".
       MUTATION: drop the derivation in `screenerSegments` and this reds. */
    const store = await mirrorOf([
      msg({ id: "s1", from: "bank@example.test", folder: "ohmail/Screener", noAi: true }),
      msg({ id: "s2", from: "ordinary@example.test", folder: "ohmail/Screener" }),
    ]);
    const rows = screenerSegments(store, NOW).waiting;
    const quiet = rows.find((r) => r.from.address === "bank@example.test")!;
    const plain = rows.find((r) => r.from.address === "ordinary@example.test")!;
    expect(quiet.noAi).toBe(true);
    expect(plain.noAi, "absent, never `false` — the field has one state and its absence").toBeUndefined();
  });

  it("THE BODY IS NO LONGER A DEGRADATION — it is a snippet that SAYS it is one", async () => {
    /**
     * CONVERTED, not deleted. This assertion used to read
     *
     *     expect(row.held[0]!.body).toBe("the only text there is");
     *
     * under a comment calling the snippet "a stated degradation" — and it was the assertion
     * that locked the defect in place. `held` promises "every held message, in full", and on
     * every live account (where every row is derived) it was one line, with a consent decision
     * hanging off it. The comment stated the degradation; the Screener did not.
     *
     * The snippet is still what a row carries UNTIL something asks for the body — a selector
     * must not fetch — so the text is unchanged. What is new is `bodyState`, which is what lets
     * the preview say "this is a preview" instead of presenting it as the mail.
     *
     * Red by having `heldOf` go back to `m.body ?? m.snippet`: `bodyState` becomes undefined,
     * and undefined means `full` to every surface — i.e. the exact claim this converts.
     */
    const store = await mirrorOf([msg({ id: "m1", from: "x@y.example", folder: "ohmail/Screener", snippet: "the only text there is" })]);
    const held = screenerSegments(store, NOW).waiting[0]!.held[0]!;
    expect(held.body).toBe("the only text there is");
    expect(held.bodyState).toBe("snippet");
  });

  it("a hydrated held message reports FULL, and its text is the endpoint's", async () => {
    // The other half of the conversion: the same derived row once `hydrateBody` has run.
    // `screenerSegments` reads the `message_body` record through `bodyOf` at derive time, so no
    // extra plumbing reaches the Screener.
    const store = await mirrorOf([msg({ id: "m1", from: "x@y.example", folder: "ohmail/Screener", snippet: "the only text there is" })]);
    await store.putLocal("message_body", "m1", {
      messageId: "m1", state: "ready", text: "Dear Mila,\n\nthere is rather more than one line.",
    });
    const held = screenerSegments(store, NOW).waiting[0]!.held[0]!;
    expect(held.bodyState).toBe("full");
    expect(held.body).toBe("Dear Mila,\n\nthere is rather more than one line.");
  });

  it("a FIXTURE row's held bodies stay FULL with no record — the demo world is unchanged", async () => {
    // `bodyState` is optional precisely so a `screener_sender` entity, which carries its held
    // bodies verbatim, needs no migration and reports nothing. Absent means full.
    const fx = getFixtures();
    const sender = fx.screener.waiting[0]!;
    const store = await mirrorOf([]);
    await store.applyChanges([{
      type: "screener_sender",
      op: "create",
      id: sender.id,
      seq: 900,
      updatedAt: NOW.toISOString(),
      entity: {
        id: sender.id, segment: "waiting", from: sender.from, initial: sender.initial,
        time: sender.time, scope: sender.scope, ai: sender.ai, held: sender.held,
        updatedAt: NOW.toISOString(),
      },
    }]);
    const held = screenerSegments(store, NOW).waiting[0]!.held;
    expect(held.length).toBeGreaterThan(0);
    for (const h of held) {
      expect(h.bodyState).toBeUndefined();
      expect(h.body.length).toBeGreaterThan(0);
    }
  });
});

describe("fixture precedence — the demo world does not regress", () => {
  it("a fixture screener_sender wins over the derived row for the same sender", async () => {
    // THE GUARD. Swap the union order in `screenerSegments()` (write the fixture rows
    // into the map BEFORE the derived ones, so derivation overwrites them) and this goes
    // red: `ai` becomes null and the rich held bodies collapse to snippets — i.e. the
    // demo loses its AI suggestions the moment a Cloud codepath exists.
    const fx = getFixtures();
    const fixtureSender = fx.screener.waiting[0]!;

    const store = await mirrorOf([
      msg({ id: "shadow-1", from: fixtureSender.from.address, folder: "ohmail/Screener" }),
      msg({ id: "shadow-2", from: fixtureSender.from.address, folder: "ohmail/Screener" }),
    ]);
    await store.applyChanges([
      {
        type: "screener_sender",
        op: "create",
        id: fixtureSender.id,
        seq: ++seq,
        updatedAt: NOW.toISOString(),
        entity: {
          id: fixtureSender.id,
          segment: "waiting",
          from: fixtureSender.from,
          initial: fixtureSender.initial,
          time: fixtureSender.time,
          scope: fixtureSender.scope,
          ai: fixtureSender.ai,
          held: fixtureSender.held,
          updatedAt: NOW.toISOString(),
        } satisfies ScreenerSenderDTO,
      },
    ]);

    const seg = screenerSegments(store, NOW);
    // ONE row for that sender, and it is the fixture's — richer DTO, fixture id.
    expect(seg.waiting).toHaveLength(1);
    expect(seg.waiting[0]!.id).toBe(fixtureSender.id);
    expect(seg.waiting[0]!.derived).toBeUndefined();
    expect(seg.waiting[0]!.ai).toEqual(fixtureSender.ai);
    expect(seg.waiting[0]!.ai?.dest).toBe("ohbox");
    expect(seg.waiting[0]!.held).toEqual(fixtureSender.held);
  });

  it("the demo world is unchanged end to end — same rows, same order, same suggestions", async () => {
    const fx = getFixtures();
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();
    const seg = screenerSegments(engine.read(), DEMO_NOW);
    expect(seg.waiting.map((s) => s.id)).toEqual(fx.screener.waiting.map((w) => w.id));
    expect(seg.screenedOut).toHaveLength(fx.screener.screenedOut.length);
    expect(seg.spam).toHaveLength(fx.screener.spam.length);
    expect(seg.waiting.every((s) => s.derived === undefined)).toBe(true);
  });
});

/**
 * ═══ #116 (A.i): AN ACTIVE-UNDECIDED SENDER WHOSE MAIL IS ALL IN THE INBOX STILL GETS A ROW ═══
 *
 * The live bug: messages from one sender were bulk-moved Screener→INBOX; unread, so the sender
 * is ACTIVE; no rule and no contact, so undecided. The cutline PRESENTS their INBOX mail in the
 * Screener (a decision is wanted), but the pre-fix selector minted the row only on a GATE-PHYSICAL
 * representative — of which there is none — so the sender was in no pile but search. They vanished.
 *
 * The row is now minted on `newestFirst[0]` and marked `gatePhysical:false`, which is the switch
 * the commit path reads to route the decision past the gate (a rule) instead of a decide that 404s.
 */
describe("#116 — the presented-in-Screener sender is not suppressed", () => {
  it("a waiting row exists over the projected reader, marked gatePhysical:false", async () => {
    // All of this sender's mail is physically in the INBOX, unread (⇒ active) and unruled
    // (⇒ undecided) — the exact bulk-moved shape. A second sender genuinely at the gate is here
    // so the row this mints cannot be confused for "the queue is just the held one".
    const store = await mirrorOf([
      msg({ id: "x1", from: "blasz.caroline@gmail.test", folder: "INBOX", date: "2026-08-02T08:00:00.000Z", unread: true }),
      msg({ id: "x2", from: "blasz.caroline@gmail.test", folder: "INBOX", date: "2026-08-02T09:30:00.000Z", unread: true }),
      msg({ id: "h1", from: "held@atelier.test", folder: "ohmail/Screener", date: "2026-08-02T07:00:00.000Z", unread: true }),
    ]);

    // Over the RAW mirror the presented sender is nowhere in the queue — their folder is INBOX.
    // This is the vanish, and the contrast that proves the projection is what surfaces them.
    expect(screenerSegments(store, NOW).waiting.map((s) => s.from.address)).toEqual(["held@atelier.test"]);

    const part = consentPartition(store, { now: NOW });
    const presented = presentationReader(store, part);
    // THE GUARD. Restore the gate-physical `find` WITHOUT the `?? newestFirst[0]` fallback in
    // `screenerSegments` and this goes red: the presented sender gets no row at all.
    const seg = screenerSegments(presented, NOW);

    const caroline = seg.waiting.find((s) => s.from.address === "blasz.caroline@gmail.test");
    expect(caroline, "the presented-in-Screener sender minted no waiting row").toBeTruthy();
    // Their whole bag is carried, both INBOX messages, oldest first — no-collapse holds.
    expect(caroline!.held.map((h) => h.id)).toEqual(["x1", "x2"]);
    // The flag that sends the commit past the gate: this rep is NOT physically at the gate.
    expect(caroline!.gatePhysical).toBe(false);
    // …and the genuinely-held sender is still gate-physical, decided the ordinary way.
    expect(seg.waiting.find((s) => s.from.address === "held@atelier.test")!.gatePhysical).toBe(true);
  });
});

describe("screener_decide on a DERIVED sender", () => {
  const ctx = { now: () => NOW, uuid: () => "rule-1" };

  it("yes moves every held message of that sender and promotes a rule", async () => {
    const store = await mirrorOf(HELD);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m3", decision: "yes" }, ctx);

    const moves = effects.filter((e) => e.type === "message");
    expect(moves.map((e) => e.id).sort()).toEqual(["m1", "m2", "m3"]);
    for (const e of moves) {
      expect((e.entity as EngineMessage).folder).toBe("INBOX");
      expect(e.move).toEqual({ from: "ohmail/Screener", to: "INBOX" });
    }
    // NOT a screener_sender tombstone — there is no such row to tombstone.
    expect(effects.some((e) => e.type === "screener_sender")).toBe(false);

    const rule = effects.find((e) => e.type === "rule")!.entity as RuleDTO;
    expect(rule).toMatchObject({
      kind: "sender",
      match: "lena@atelier.example",
      destination: "INBOX",
      provenance: "promoted",
    });
  });

  it("no files the held mail to ohmail/Screened; scope domain promotes a domain rule", async () => {
    const store = await mirrorOf(HELD);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m6", decision: "no", scope: "domain" }, ctx);
    expect(effects.filter((e) => e.type === "message").map((e) => e.id)).toEqual(["m6"]);
    expect((effects[0]!.entity as EngineMessage).folder).toBe("ohmail/Screened");
    expect(effects.find((e) => e.type === "rule")!.entity).toMatchObject({
      kind: "domain",
      match: "jackpot.example",
      destination: "ohmail/Screened",
    });
  });

  /**
   * ── SCR-READ INVERTED THIS TEST, AND THE REASON IT EXISTED IS THE REASON IT FLIPPED ──────
   *
   * It was *"`dest` is NOT honoured locally, because the wire has no such field"*, and it was
   * protecting a real invariant: the overlay must file where the wire files, or a row moves
   * once and then moves again under the cursor on the next drain (the `feed_mark_seen`
   * divergence). The premise — that `POST /screener/:id` takes only `{decision, scope}` — is
   * what changed. `dest` is on the wire, so honouring it locally is now what KEEPS the two
   * agreeing, and ignoring it is what would break them.
   *
   * Both sides read the same function: `decideFolder(m)` here, and
   * `dest ?? (decision === "yes" ? YES_FOLDER : NO_FOLDER)` in `screener-service.ts`.
   */
  it("`dest` IS honoured locally, because the wire carries it — all five of them", async () => {
    const store = await mirrorOf(HELD);
    const filedTo = (m: Parameters<typeof mutationEffects>[1]) =>
      (mutationEffects(store, m, ctx)[0]!.entity as EngineMessage).folder;

    // The three that ADMIT the sender.
    expect(filedTo({ kind: "screener_decide", senderId: "m6", decision: "yes", dest: "ohbox" })).toBe("INBOX");
    expect(filedTo({ kind: "screener_decide", senderId: "m6", decision: "yes", dest: "reads" })).toBe("ohmail/News");
    expect(filedTo({ kind: "screener_decide", senderId: "m6", decision: "yes", dest: "receipts" })).toBe("ohmail/Receipts");
    // …and the two that refuse them.
    expect(filedTo({ kind: "screener_decide", senderId: "m6", decision: "no", dest: "screened" })).toBe("ohmail/Screened");
    expect(filedTo({ kind: "screener_decide", senderId: "m6", decision: "no", dest: "spam" })).toBe("ohmail/Quarantine");

    // THE BACK-COMPAT HALF, and it is what lets an older client keep working: no `dest` is
    // still the two-folder default, byte for byte, on both sides of the wire.
    expect(filedTo({ kind: "screener_decide", senderId: "m6", decision: "yes" })).toBe("INBOX");
    expect(filedTo({ kind: "screener_decide", senderId: "m6", decision: "no" })).toBe("ohmail/Screened");
  });

  it("the promoted rule the overlay paints points at the SAME folder the mail went to", async () => {
    // The half that was wrong on the hosted service: the mail was moved to Reads by a follow-up
    // `move` and the rule said `INBOX`, so every later message from that sender went to the
    // Ohbox for ever — `evaluateRules` resolves user rules before the List-Unsubscribe
    // heuristic ever runs. One `destination` expression feeds both effects now.
    const store = await mirrorOf(HELD);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m6", decision: "yes", dest: "reads" }, ctx);
    const moved = effects.filter((e) => e.type === "message");
    expect(moved.length).toBeGreaterThan(0);
    for (const e of moved) expect((e.entity as EngineMessage).folder).toBe("ohmail/News");
    expect(effects.find((e) => e.type === "rule")!.entity).toMatchObject({
      destination: "ohmail/News",
      provenance: "promoted",
    });
  });

  it("`read` does NOT flip unread locally either — it is not a field on the endpoint", async () => {
    const store = await mirrorOf(HELD);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m6", decision: "yes", read: true }, ctx);
    expect((effects[0]!.entity as EngineMessage).unread).toBe(true);
  });

  it("a representative outside ohmail/Screener yields NO effect — the server would 404", async () => {
    // `heldRows` selects only `desiredFolder = 'ohmail/Screener'`
    // (`screener-service.ts:257`), so `decide` cannot resolve a screened-out or
    // quarantined representative. The local verdict matches instead of moving mail
    // optimistically and rolling it back a round-trip later.
    const store = await mirrorOf([
      msg({ id: "s1", from: "cold@outreach.example", folder: "ohmail/Screened" }),
      msg({ id: "q1", from: "win@jackpot.example", folder: "ohmail/Quarantine" }),
      msg({ id: "i1", from: "known@friend.example", folder: "INBOX" }),
    ]);
    for (const id of ["s1", "q1", "i1", "no-such-message"]) {
      expect(mutationEffects(store, { kind: "screener_decide", senderId: id, decision: "yes" }, ctx)).toEqual([]);
    }
  });

  it("the decided sender leaves the waiting segment and their mail is in the Ohbox", async () => {
    const store = await mirrorOf(HELD);
    // An adapter that echoes the effects as authoritative changes — the shape the real
    // server produces for this endpoint (per-message `move` + a `rule` create,
    // `screener-service.ts:167,:177-178`). The convergence proof against the real
    // backend is in `contract.test.ts`; this is the same assertion at unit speed.
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
        mutate: async (m) => {
          const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => "rule-echo" }).map((e) => ({
            type: e.type,
            op: e.move ? "move" : "update",
            id: e.id,
            seq: ++seq,
            updatedAt: NOW.toISOString(),
            entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          }));
          return { changes, seq: changes[changes.length - 1]?.seq ?? null };
        },
      },
      store,
      now: () => NOW,
    });
    await engine.start();
    expect(screenerSegments(engine.read(), NOW).waiting).toHaveLength(3);

    await engine.mutate({ kind: "screener_decide", senderId: "m3", decision: "yes" });
    const seg = screenerSegments(engine.read(), NOW);
    expect(seg.waiting.map((s) => s.id)).toEqual(["m5", "m6"]);
    for (const id of ["m1", "m2", "m3"]) {
      expect(engine.read().get<EngineMessage>("message", id)?.folder).toBe("INBOX");
    }
  });
});

describe("SCREENER-020 — the account-wide echo covers the second mailbox", () => {
  /**
   * ITEM 3'S CLIENT LEG. The optimistic claim covers EVERY held row of the sender
   * (`derivedScreenerEffects`, senderKey-filtered, mailbox-blind); the server now writes the same
   * set, so once the echo lands nothing is left in the mirror to re-mint the sender from. The
   * server here is modelled BY HAND (never via `mutationEffects`) so the two sides cannot align
   * by sharing code. Mutations watched red, both at the mid-flight read: (1) key the optimistic
   * claim by the representative's id (`x.id === m.senderId` in `mutations.ts`) and the first
   * mailbox's row re-mints while the echo is in transit; (2) retire the overlay at CONFIRM
   * (`if (!echoPending)` → `if (true)`, `engine.ts`) and the whole sender comes back there.
   */
  it("no row re-mints from the second mailbox — while the echo is in flight, or after it lands", async () => {
    const bag: EngineMessage[] = [
      msg({ id: "a1", from: "post@ledger.example", folder: "ohmail/Screener", date: "2026-08-02T08:00:00.000Z" }),
      { ...msg({ id: "a2", from: "post@ledger.example", folder: "ohmail/Screener", date: "2026-08-02T09:00:00.000Z" }), mailboxId: "mb2" },
    ];
    const store = await mirrorOf([...bag, msg({ id: "w1", from: "win@jackpot.example", folder: "ohmail/Screener" })]);

    // THE ACCOUNT-WIDE SERVER, BY HAND: its own copy of the bag, keyed by sender — one POST files
    // both mailboxes' rows, answers with NO echo body (the real route's contract), and the moves
    // arrive on the next drain. The drain READS at request time; only its response can stall.
    const serverBag = bag.map((m) => ({ id: m.id, address: m.from.address.toLowerCase(), folder: m.folder }));
    const pending: SyncChange[] = [];
    const serverFiled: string[] = [];
    let gate: Promise<void> | null = null;
    let release!: () => void;
    const engine = new OhmailEngine({
      adapter: {
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        sync: async () => {
          const moves = pending.splice(0);
          const held = gate;
          if (held) { gate = null; await held; }
          return { changes: { creates: [], updates: [], moves, deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() };
        },
        mutate: async (m) => {
          if (m.kind !== "screener_decide") throw new Error(`unexpected ${m.kind}`);
          const rep = serverBag.find((s) => s.id === m.senderId)!;
          for (const s of serverBag) {
            if (s.folder !== "ohmail/Screener" || s.address !== rep.address) continue;
            s.folder = "INBOX";
            serverFiled.push(s.id);
            const entity = { ...bag.find((b) => b.id === s.id)!, folder: "INBOX" as Folder, updatedAt: NOW.toISOString() };
            pending.push({ type: "message", op: "move", id: s.id, seq: ++seq, updatedAt: NOW.toISOString(), entity, move: { from: "ohmail/Screener", to: "INBOX" } });
          }
          return { changes: [], seq: pending[pending.length - 1]?.seq ?? null };
        },
      },
      store,
      now: () => NOW,
    });
    await engine.start();
    expect(new Set(screenerSegments(engine.read(), NOW).waiting.map((s) => s.id))).toEqual(new Set(["a2", "w1"]));

    gate = new Promise<void>((r) => { release = r; });
    const mutation = engine.mutate({ kind: "screener_decide", senderId: "a2", decision: "yes" });
    // Let the POST land and the follow-up drain go on the wire (stalled in transit).
    await new Promise((r) => { setTimeout(r, 0); });
    expect(
      screenerSegments(engine.read(), NOW).waiting.map((s) => s.id),
      "a held row re-minted the sender while the echo was in flight",
    ).toEqual(["w1"]);

    release();
    const res = await mutation;
    expect(res.status).toBe("confirmed");
    expect(new Set(serverFiled)).toEqual(new Set(["a1", "a2"]));

    // The MIRROR — not the overlay — carries both mailboxes' rows moved: a later drain has
    // nothing left to re-mint the sender from.
    await engine.syncOnce();
    for (const id of ["a1", "a2"]) {
      expect(engine.read().get<EngineMessage>("message", id)?.folder, `row ${id} stayed held`).toBe("INBOX");
    }
    expect(screenerSegments(engine.read(), NOW).waiting.map((s) => s.id)).toEqual(["w1"]);
  });
});

describe("failedAtGate — a held letter its provider failed, with no waiting row to decide it", () => {
  const ME = "me@example.com";
  const failed = (m: EngineMessage): EngineMessage => ({ ...m, authVerdict: "fail" });
  /** The store's whole queue, answered, listing `listed` alone. */
  const storePage = (listed: string): SyncChange[] => [
    { type: "screener_waiting", op: "create", id: "page", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { id: "page", kind: "page", total: 1, nextCursor: null, inFlight: [], ask: 1, rows: 1 } },
    { type: "screener_waiting", op: "create", id: `sender:${listed}`, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { id: `sender:${listed}`, kind: "sender", order: 0, messageId: "stranger", address: listed, name: null,
        receivedAt: "2026-08-02T06:00:00.000Z", subject: "s", snippet: "", mailboxId: "mb", total: 1 } },
  ] as SyncChange[];
  const segmentsOf = async (messages: EngineMessage[], extra: SyncChange[]) => {
    const store = await mirrorOf(messages);
    await store.applyChanges(extra);
    const presented = presentationReader(store, consentPartition(store, { now: NOW, ownAddresses: [ME] }));
    return screenerSegments(presented, NOW, "en", "UTC", [ME]);
  };

  it("lists a forged own letter and a forged contact's, newest first, and never as a waiting row", async () => {
    const seg = await segmentsOf([
      failed(msg({ id: "own", from: ME, folder: "ohmail/Screener", date: "2026-08-02T08:00:00.000Z" })),
      failed(msg({ id: "contact", from: "accountant@smallfirm.example", folder: "ohmail/Screener", date: "2026-08-02T09:00:00.000Z" })),
      failed(msg({ id: "stranger", from: "someone@else.example", folder: "ohmail/Screener", date: "2026-08-02T06:00:00.000Z" })),
      { ...msg({ id: "mine", from: ME, folder: "ohmail/Screener" }), authVerdict: "pass" },
      failed(msg({ id: "filed", from: "accountant@smallfirm.example", folder: "ohmail/Quarantine" })),
    ], storePage("someone@else.example"));
    expect(seg.failedAtGate.map((f) => [f.id, f.own])).toEqual([["contact", false], ["own", true]]);
    expect(seg.failedAtGate[0]).toMatchObject({ from: { address: "accountant@smallfirm.example" }, subject: "Subject contact" });
    // The stranger the store lists is a waiting row and decides its own letter; nothing else is counted.
    expect(seg.waiting.map((w) => w.from.address)).toEqual(["someone@else.example"]);
    expect(seg.waitingTotal).toBe(1);
  });
});
