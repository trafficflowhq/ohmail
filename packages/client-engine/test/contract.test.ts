import { describe, expect, it } from "vitest";
import { apiRoutes, createApp, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
// THE REAL PASS, not a stand-in for it. The claim below is that what the worker's cycle and the
// desktop engine's drain actually run reaches a live client, so a hand-rolled UPDATE here would
// assert nothing about production.
import { bubbleUpPass } from "@trafficflow/worker/bubble-up";
import type { Tx } from "@trafficflow/db";
import {
  FIXED_NOW, makeDeps, seedMailbox, seedMessage, seedScreenerHeld, seedSession,
} from "../../api/test/helpers.js";
import {
  HttpAdapter,
  OhmailEngine,
  MemoryMirrorStore,
  decodeSeqCursor,
  encodeSeqCursor,
  flattenResponse,
  inverseMutations,
  ohboxView,
  screenerSegments,
  triagePiles,
  type EngineMessage,
  type EngineMutation,
  type FetchLike,
  type MessageStateDTO,
  type RuleDTO,
} from "@ohmail/client-engine";

/**
 * CONTRACT TESTS — the Stage-2 proof. The REAL backend (createApp(apiRoutes) +
 * PGlite + a seeded session) runs in-process; HttpAdapter's injectable fetch is
 * pointed straight at app.handle. If these pass, wiring the engine to the live
 * API is a construction-time config change, not a rewrite.
 */

const app = createApp(apiRoutes);

interface AuthMode {
  bearer?: string;
  cookies?: Record<string, string>;
}

/** Bridge fetch → the in-process app, injecting auth exactly like a browser/native client. */
function bridgeFetch(deps: ApiDeps, auth: AuthMode): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    if (auth.bearer) headers.set("authorization", `Bearer ${auth.bearer}`);
    if (auth.cookies) {
      headers.set("cookie", Object.entries(auth.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const req = new Request(url, { ...init, headers });
    return app.handle(req, { ...deps, session: null, idempotency: null });
  };
}

/** Stand up backend + session + an INBOX message that is change-log-visible. */
async function backendWorld() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const fetchImpl = bridgeFetch(deps, { bearer: s.token });

  // Rules created over the REAL wire → change_log creates.
  const mkRule = async (match: string): Promise<string> => {
    const res = await fetchImpl("http://localhost/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "sender", match, destination: "INBOX" }),
    });
    expect(res.status).toBe(201);
    return (await res.json() as { id: string }).id;
  };
  const ruleA = await mkRule("a@example.com");
  const ruleB = await mkRule("b@example.com");

  // Messages are ingested by the worker in production; here we seed the row and
  // emit its change through a REAL wire mutation (PATCH → update change).
  const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", subject: "Contract hello", unread: true });
  const patch = await fetchImpl(`http://localhost/messages/${m.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unread: true }),
  });
  expect(patch.status).toBe(200);

  return { db, deps, s, fetchImpl, ruleA, ruleB, messageId: m.id, mailboxId: m.mailboxId };
}

/**
 * A backend holding real first-contact mail in `ohmail/Screener` — the production shape
 * that this exists for (a full Screener of first-contact mail that rendered "all
 * clear" because `screener_sender` never crossed the wire).
 *
 * NO rules and no other mail: the rule assertions below count from zero.
 *
 * ── ALL THREE LIVE IN ONE MAILBOX, AND THAT IS LOAD-BEARING ─────────────────────────────────
 *
 * `seedScreenerHeld` mints a FRESH mailbox whenever it is not given one, so these three seeds
 * used to produce three mailboxes — and the two `lena@atelier.example` messages therefore sat in
 * two different ones. That was invisible while a decision re-routed the whole ACCOUNT's held bag
 * for a sender. It stopped being invisible when a decision became scoped to the mailbox it was
 * made about: only the decided mailbox's copy moved, one `message/move` was emitted instead of
 * two, and the sender stayed in the derived queue because their other message was still held
 * somewhere else.
 *
 * The scoping is right — a decision about one mailbox must never move mail in another — so the
 * FIXTURE is what was wrong, and it was wrong about production too: a person's mail from one
 * sender arrives in one mailbox. One mailbox, passed explicitly, so the shape is stated rather
 * than inherited from a default.
 */
async function screenerBackend() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const fetchImpl = bridgeFetch(deps, { bearer: s.token });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });

  const held = [
    { from: "lena@atelier.example", subject: "Werkstatt-Besuch?", at: 0 },
    { from: "lena@atelier.example", subject: "Nachtrag zum Termin", at: 60_000 },
    { from: "paperbird@news.example", subject: "Issue 12", at: 30_000 },
  ];
  const ids: string[] = [];
  for (const h of held) {
    const m = await seedScreenerHeld(db, {
      accountId: s.accountId,
      mailboxId,
      fromAddress: h.from,
      subject: h.subject,
      date: new Date(FIXED_NOW.getTime() + h.at),
    });
    // Messages are ingested by the worker in production; here the row is seeded and its
    // change emitted through a REAL wire mutation, exactly as `backendWorld` does.
    const patch = await fetchImpl(`http://localhost/messages/${m.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unread: true }),
    });
    expect(patch.status).toBe(200);
    ids.push(m.id);
  }

  return { db, deps, s, fetchImpl, lenaOldest: ids[0]!, lenaNewest: ids[1]!, paperbird: ids[2]! };
}

describe("HttpAdapter ⇄ real backend (PGlite, in-process)", () => {
  it("bootstrap sync populates the mirror (paged hasMore drain, cursor advances)", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const store = new MemoryMirrorStore();
    // syncLimit 2 forces hasMore:true on the first page (3 changes exist) — the
    // engine must drain until hasMore:false.
    const engine = new OhmailEngine({ adapter, store, syncLimit: 2 });
    await engine.start();

    expect(store.get<RuleDTO>("rule", w.ruleA)?.match).toBe("a@example.com");
    expect(store.get<RuleDTO>("rule", w.ruleB)?.match).toBe("b@example.com");
    const msg = store.get<EngineMessage>("message", w.messageId);
    expect(msg?.subject).toBe("Contract hello");
    expect(msg?.folder).toBe("INBOX");
    expect(msg?.unread).toBe(true);
    expect(store.maxSeq()).toBeGreaterThanOrEqual(3);
    expect(decodeSeqCursor(store.getCursor())).toBe(store.maxSeq());

    // Idle tail: same cursor, nothing new — and the mirror's rows and version untouched.
    const before = store.getCursor();
    const rows = JSON.stringify([...store.snapshot().entries()].sort());
    const version = store.version();
    await engine.syncOnce();
    expect(store.getCursor()).toBe(before);
    expect(JSON.stringify([...store.snapshot().entries()].sort()), "an unchanged answer moved the mirror's rows").toBe(rows);
    expect(store.version(), "an unchanged answer re-derived the mirror").toBe(version);
  });

  it("a move round-trips: optimistic → X-Sync-Seq echo → /sync converged; seq advances across mutations", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store });
    await engine.start();
    const bootstrapSeq = store.maxSeq();

    // Gate the wire so the OPTIMISTIC state is observable mid-flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated = new HttpAdapter({
      baseUrl: "http://localhost",
      fetch: async (url, init) => { await gate; return w.fetchImpl(url, init); },
    });
    const gatedEngine = new OhmailEngine({ adapter: gated, store });

    const pending = gatedEngine.mutate({ kind: "move", messageId: w.messageId, folder: "ohmail/News" });
    await new Promise((r) => setTimeout(r, 0));
    // User-always-wins: the overlay shows the move; the mirror is untouched.
    expect(gatedEngine.read().get<EngineMessage>("message", w.messageId)?.folder).toBe("ohmail/News");
    expect(store.get<EngineMessage>("message", w.messageId)?.folder).toBe("INBOX");

    release();
    const res = await pending;
    expect(res.status).toBe("confirmed");
    expect(res.seq).toBeGreaterThan(bootstrapSeq); // X-Sync-Seq echoed + advancing
    expect(gated.lastSyncSeq).toBe(res.seq);

    // The echo is applied authoritatively at the echoed seq.
    expect(store.get<EngineMessage>("message", w.messageId)?.folder).toBe("ohmail/News");
    expect(store.record("message", w.messageId)?.seq).toBe(res.seq);

    // …and the delta agrees (idempotent convergence, §3.4).
    const snapshot = JSON.stringify([...store.snapshot().entries()].sort());
    await gatedEngine.syncOnce();
    expect(JSON.stringify([...store.snapshot().entries()].sort())).toBe(snapshot);
    expect(decodeSeqCursor(store.getCursor())!).toBeGreaterThanOrEqual(res.seq!);

    // A second mutation advances the seq strictly.
    const res2 = await gatedEngine.mutate({ kind: "move", messageId: w.messageId, folder: "INBOX" });
    expect(res2.status).toBe("confirmed");
    expect(res2.seq!).toBeGreaterThan(res.seq!);
  });

  it("a card's conditional move travels the wire: applied where it was counted, stale where it was not", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const stale = await adapter
      .mutate({ kind: "move", messageId: w.messageId, folder: "ohmail/News", from: "ohmail/Receipts" }, { idempotencyKey: "card-move-stale" })
      .catch((e: unknown) => e);
    expect(stale).toMatchObject({ status: 409, code: "stale_press" });
    const made = await adapter.mutate(
      { kind: "move", messageId: w.messageId, folder: "ohmail/News", from: "INBOX" }, { idempotencyKey: "card-move-made" },
    );
    expect(made.seq).not.toBeNull();
  });

  it("an idempotent retry (same key, same body) replays verbatim and converges without duplication", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const key = "contract-retry-key-1";
    const move = { kind: "move", messageId: w.messageId, folder: "ohmail/News" } as const;

    const o1 = await adapter.mutate(move, { idempotencyKey: key });
    const o2 = await adapter.mutate(move, { idempotencyKey: key }); // retry after a "lost" response
    expect(o1.seq).not.toBeNull();
    expect(o2.seq).toBe(o1.seq); // the STORED response replayed, no new change

    // Applying both echoes converges to one state.
    const store = new MemoryMirrorStore();
    await store.applyChanges(o1.changes);
    const once = JSON.stringify([...store.snapshot().entries()].sort());
    await store.applyChanges(o2.changes);
    expect(JSON.stringify([...store.snapshot().entries()].sort())).toBe(once);

    // The SERVER's change log holds exactly ONE move for the message.
    const all = flattenResponse(await adapter.sync({ since: "0", limit: 2000 }));
    const moves = all.filter((c) => c.type === "message" && c.id === w.messageId && c.op === "move");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.move).toEqual({ from: "INBOX", to: "ohmail/News" });

    // Same key + DIFFERENT body → 409 idempotency_replay (contract §1.6).
    const conflict = await adapter
      .mutate({ kind: "move", messageId: w.messageId, folder: "ohmail/Quarantine" }, { idempotencyKey: key })
      .catch((e: unknown) => e);
    expect(conflict).toMatchObject({ status: 409, code: "idempotency_replay" });
  });

  it("410 cursor_expired triggers discard + re-bootstrap (fresh full state)", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store });
    await engine.start();
    const populated = store.snapshot().size;
    expect(populated).toBeGreaterThan(0);

    // The mirror's cursor becomes garbage (retention horizon / corrupt state).
    store.forceCursor("@@not-a-cursor@@");
    await engine.syncOnce(); // 410 → resetForBootstrap → since=0 drain

    expect(store.snapshot().size).toBe(populated); // fully re-bootstrapped
    expect(store.get<EngineMessage>("message", w.messageId)).toBeDefined();
    expect(decodeSeqCursor(store.getCursor())).toBe(store.maxSeq());
  });

  /**
   * A CURSOR AHEAD OF THE SERVER'S LOG — the same recovery, from the failure that produced it
   * live, driven end to end through the real backend.
   *
   * The case above forces a MALFORMED cursor, which `decodeCursor` rejects before it ever reads
   * the log. This one is well-formed and numerically valid; the only thing wrong with it is that
   * the account never issued that seq. Until the ceiling check in `SyncService.getChanges` this
   * answered 200 with an empty delta — so the engine applied nothing, kept the bad cursor (an
   * empty page returns `since` unchanged), and did the same on every subsequent drain, for the
   * life of the mirror. Nothing threw, so nothing here would have caught it either: the
   * assertion that matters is the one on the CURSOR, not on the absence of an exception.
   *
   * Run in BOTH store modes. `windowed` is the browser's and `full` the desktop's, and the 410
   * branch lives in the shared `drain()` — so this pins that the mode a client happens to be in
   * cannot change whether it recovers. The live incident was a full-store-shaped mirror.
   */
  for (const policy of [
    { mode: "full" } as const,
    { mode: "windowed", days: 90, minRows: 5000 } as const,
  ]) {
    it(`a cursor AHEAD of the server's max heals: 410 → re-snapshot → fresh cursor (${policy.mode} store)`, async () => {
      const w = await backendWorld();
      const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
      const store = new MemoryMirrorStore();
      const engine = new OhmailEngine({ adapter, store, storePolicy: policy });
      await engine.start();
      const populated = store.snapshot().size;
      expect(populated).toBeGreaterThan(0);
      const healthy = decodeSeqCursor(store.getCursor())!;
      expect(healthy).toBeGreaterThan(0);

      // The incident shape: a well-formed cursor naming a seq this account never issued. The
      // live gap was 2173 over a max of 1684; the distance is not what makes it fatal — one
      // past the ceiling behaves identically — so the magnitude here is only a reminder.
      store.forceCursor(encodeSeqCursor(healthy + 489));
      await engine.syncOnce();

      // THE ASSERTION THE OLD BEHAVIOUR PASSED AND THIS ONE MUST NOT: the cursor is a real
      // position in the server's log again. Left ahead, the mirror is deaf for ever.
      const healed = decodeSeqCursor(store.getCursor());
      expect(healed).toBe(store.maxSeq());
      expect(healed).toBeLessThanOrEqual(healthy);

      // …and the mirror is whole, not merely unstuck.
      expect(store.snapshot().size).toBe(populated);
      expect(store.get<EngineMessage>("message", w.messageId)).toBeDefined();

      // The next drain is an ordinary no-op rather than a second re-bootstrap.
      await engine.syncOnce();
      expect(decodeSeqCursor(store.getCursor())).toBe(healed);
      expect(store.snapshot().size).toBe(populated);
    });
  }

  it("triage (no DTO echo) reconciles through the next /sync drain", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const engine = new OhmailEngine({ adapter });
    await engine.start();

    const res = await engine.mutate({ kind: "triage_set", messageId: w.messageId, state: "reply_later" });
    expect(res.status).toBe("confirmed");
    // The endpoint returns no X-Sync-Seq → the engine drained /sync instead; the
    // authoritative message_state entity is in the mirror and the overlay is gone.
    // (The server keys the change by the message_states ROW id — the DTO carries
    // the messageId, which is what selectors join on.)
    const st = engine.store.list<MessageStateDTO>("message_state").find((x) => x.messageId === w.messageId);
    expect(st?.state).toBe("reply_later");
    expect(engine.pendingMutations()).toHaveLength(0);
  });

  it("Park, then its Undo: the open read comes back on the server and in the mirror, and the row keeps its place in Earlier", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const fetchImpl = bridgeFetch(deps, { bearer: s.token });
    const day = 86_400_000;
    const opened = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", subject: "Opened", unread: true, date: new Date(FIXED_NOW.getTime() - 3 * day) });
    const newer = await seedMessage(db, { accountId: s.accountId, mailboxId: opened.mailboxId, folder: "INBOX", subject: "Newer", unread: true, date: new Date(FIXED_NOW.getTime() - day) });
    for (const [id, unread] of [[opened.id, true], [newer.id, false]] as const) {
      const res = await fetchImpl(`http://localhost/messages/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ unread }),
      });
      expect(res.status).toBe(200);
    }
    const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }) });
    await engine.start();
    const earlier = () => ohboxView(engine.store).previouslySeen.map((m) => m.id);
    const openReadOf = () => engine.store.get<EngineMessage>("message", opened.id)?.openReadAt ?? null;
    const serverOpenRead = async () => ((await (await fetchImpl(`http://localhost/messages/${opened.id}`, {})).json()) as EngineMessage).openReadAt ?? null;

    expect(engine.holdOpenRow(opened.id)).toBe(true);
    expect((await engine.mutate({ kind: "mark_seen", messageIds: [opened.id], unread: false })).status).toBe("confirmed");
    engine.releaseOpenRow(opened.id);
    const read = openReadOf();
    expect(read, "the premise: the server stamped the open read").toEqual(expect.any(String));
    expect(earlier(), "the premise: the open read files it first").toEqual([opened.id, newer.id]);

    const park = { kind: "triage_set", messageId: opened.id, state: "set_aside" } as const;
    const undo = inverseMutations(engine.verbRead(), park);
    expect((await engine.mutate(park)).status).toBe("confirmed");
    expect(await serverOpenRead(), "the park ended the open read").toBeNull();
    for (const u of undo) expect((await engine.mutate(u)).status).toBe("confirmed");
    await engine.syncOnce();
    expect(await serverOpenRead()).toBe(read);
    expect(openReadOf()).toBe(read);
    expect(earlier()).toEqual([opened.id, newer.id]);
  });

  it("Mark unread, then its Undo: the open read comes back on the server and in the mirror, and Earlier's order is back", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const fetchImpl = bridgeFetch(deps, { bearer: s.token });
    const day = 86_400_000;
    const opened = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", subject: "Opened", unread: true, date: new Date(FIXED_NOW.getTime() - 3 * day) });
    const newer = await seedMessage(db, { accountId: s.accountId, mailboxId: opened.mailboxId, folder: "INBOX", subject: "Newer", unread: false, date: new Date(FIXED_NOW.getTime() - day) });
    const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }) });
    await engine.start();
    const earlier = () => ohboxView(engine.store).previouslySeen.map((m) => m.id);
    const openReadOf = () => engine.store.get<EngineMessage>("message", opened.id)?.openReadAt ?? null;
    const serverOpenRead = async () => ((await (await fetchImpl(`http://localhost/messages/${opened.id}`, {})).json()) as EngineMessage).openReadAt ?? null;

    expect(engine.holdOpenRow(opened.id)).toBe(true);
    expect((await engine.mutate({ kind: "mark_seen", messageIds: [opened.id], unread: false })).status).toBe("confirmed");
    engine.releaseOpenRow(opened.id);
    await engine.syncOnce();
    const read = openReadOf();
    expect(read, "the premise: the server stamped the open read").toEqual(expect.any(String));
    expect(earlier(), "the premise: the open read files it first").toEqual([opened.id, newer.id]);

    const press: EngineMutation = { kind: "mark_seen", messageIds: [opened.id], unread: true };
    const undo = inverseMutations(engine.verbRead(), press);
    expect((await engine.mutate(press)).status).toBe("confirmed");
    expect(await serverOpenRead(), "Mark unread ended the open read").toBeNull();
    for (const u of undo) expect((await engine.mutate(u)).status).toBe("confirmed");
    await engine.syncOnce();
    expect(await serverOpenRead()).toBe(read);
    expect(openReadOf()).toBe(read);
    expect(earlier()).toEqual([opened.id, newer.id]);
  });

  /**
   * "NOW" IS A STATE THE SERVER WRITES, NOT A DATE IN THE PAST.
   *
   * The resurface chooser offers Tomorrow / Next week / Pick, and every one of them writes
   * `bubbled_up` with a future `bubbleUpAt` that the worker's {@link bubbleUpPass} later flips
   * to `resurfaced`. "Now" cannot be spelled that way. `bubbled_up` with a past date pins
   * NOTHING until a worker pass runs, that pass is gated at 60s in `apps/worker`, and a
   * standalone desktop install never runs it at all — so the row would sit in whatever group it
   * was already in, for a minute or for ever, after a press that said "now".
   *
   * So `resurfaced` is settable directly, over the same `POST /messages/:id/triage`, in the same
   * transaction, emitting the same `message_state` change. This test is the delta contract for
   * it: the state crosses the wire, `bubbleUpAt` comes back null (the schedule is not merely
   * spent — there never was one), and the row is pinned in `ohboxView.resurfaced` with no worker
   * pass anywhere in the test.
   */
  it("triage_set → `resurfaced` pins the row immediately, with bubbleUpAt null and no worker pass", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const engine = new OhmailEngine({ adapter });
    await engine.start();
    expect(ohboxView(engine.store).resurfaced).toHaveLength(0);

    const res = await engine.mutate({ kind: "triage_set", messageId: w.messageId, state: "resurfaced" });
    expect(res.status).toBe("confirmed");

    // The AUTHORITATIVE mirror (the overlay is gone — the triage route echoes no X-Sync-Seq, so
    // the engine drained /sync) carries the state the server stored.
    const st = engine.store.list<MessageStateDTO>("message_state").find((x) => x.messageId === w.messageId);
    expect(st?.state).toBe("resurfaced");
    expect(st?.bubbleUpAt).toBeNull();
    expect(engine.pendingMutations()).toHaveLength(0);

    // THE POINT: pinned at the top of the Ohbox, and out of the two ordinary groups, without
    // anything having run a bubble-up pass.
    const view = ohboxView(engine.store);
    expect(view.resurfaced.map((m) => m.id)).toEqual([w.messageId]);
    expect(view.newForYou.map((m) => m.id)).not.toContain(w.messageId);
    expect(view.previouslySeen.map((m) => m.id)).not.toContain(w.messageId);

    // Idempotent convergence (§3.4): a second drain does not change its mind.
    const snapshot = JSON.stringify([...engine.store.snapshot().entries()].sort());
    await engine.syncOnce();
    expect(JSON.stringify([...engine.store.snapshot().entries()].sort())).toBe(snapshot);
  });

  /**
   * A `bubbleUpAt` sent WITH `resurfaced` is forced to null by the server.
   *
   * The field is meaningful for exactly one state. A resurfaced row carrying a timestamp reads as
   * "still scheduled" everywhere that renders one (`triagePiles` puts `bubbleUpAt` on the entry as
   * `resurfaceAt`), and the worker's due-scan selects on it — so a stored date here is a second
   * flip waiting to happen. The service forces it null rather than 400ing, because the client that
   * sends one is not making a different request; it is over-specifying the same one.
   */
  it("a bubbleUpAt sent alongside `resurfaced` is dropped, not stored", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const engine = new OhmailEngine({ adapter });
    await engine.start();

    const res = await engine.mutate({
      kind: "triage_set",
      messageId: w.messageId,
      state: "resurfaced",
      bubbleUpAt: new Date(FIXED_NOW.getTime() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe("confirmed");

    const st = engine.store.list<MessageStateDTO>("message_state").find((x) => x.messageId === w.messageId);
    expect(st).toMatchObject({ state: "resurfaced", bubbleUpAt: null });
  });

  /**
   * THE SCHEDULED HALF OF THE SAME CONTRACT — a flip nobody pressed, delivered as a delta.
   *
   * An earlier fix repaired the PRESS path: `TriageService.setState` emits the `message` update beside the
   * `message_state` one, because `selectors.ts#isResurfaced` reads `message.triage.state` and
   * `apply.ts` is a keyed upsert that joins nothing. `bubbleUpPass` — the pass that keeps the
   * "Resurfaces Friday at 9" promise, on the hosted worker's cycle and on a standalone desktop
   * install's drain — had the identical hole, and it is the WORSE instance of it:
   *
   *   · a press is made by someone who is looking at the app, so the optimistic overlay
   *     (`mutations.ts` writes BOTH entities) hid the missing delta until a reload;
   *   · a scheduled flip has no presser and no overlay. It is ALWAYS delivered to an
   *     already-running client, which is the exact case a keyed upsert of `message_state` alone
   *     cannot pin. Someone who left the app open at nine o'clock saw nothing happen.
   *
   * So this drives the REAL pass against the REAL backend and then asks the engine — no
   * re-bootstrap, no second `start()`, just the next drain of the feed it was already reading.
   *
   * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────
   *
   * Delete the second `recordChange` (the `message` one) from `bubbleUpPass`. The `message_state`
   * assertions below still pass — the state really did move — and the `ohboxView` one goes red
   * with an empty `resurfaced`, which is precisely the shape the defect had in production. That
   * mutation was run.
   */
  it("bubbleUpPass → a due row pins on a LIVE client, through the feed, with no re-bootstrap", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const engine = new OhmailEngine({ adapter });
    await engine.start();

    // Scheduled for tomorrow, over the real wire, exactly as the horizon chooser does it.
    const due = new Date(FIXED_NOW.getTime() + 86_400_000);
    const set = await engine.mutate({
      kind: "triage_set", messageId: w.messageId, state: "bubbled_up", bubbleUpAt: due.toISOString(),
    });
    expect(set.status).toBe("confirmed");

    // Not pinned yet, and the MESSAGE projection agrees with the state row. Both halves asserted:
    // if the projection were already `resurfaced` here the test below would prove nothing.
    expect(ohboxView(engine.store).resurfaced).toHaveLength(0);
    expect(engine.store.get<EngineMessage>("message", w.messageId)?.triage?.state).toBe("bubbled_up");

    // ── THE PASS, DRIVEN DIRECTLY AGAINST THE STORE THE API SERVES ────────────────────────
    //
    // No HTTP: this is the worker's cycle (and the desktop engine's drain) reaching into the
    // same database. A clock past the schedule rather than a backdated row, so the fixture
    // says "the moment arrived" instead of "the schedule was written wrong".
    const { flipped } = await bubbleUpPass(
      w.db as unknown as Tx, new Date(due.getTime() + 1_000),
      { accountId: w.s.accountId, mailboxIds: [w.mailboxId] },
    );
    expect(flipped, "the pass did not consider the row due").toBe(1);

    // One ordinary drain of the feed this engine was already reading.
    await engine.syncOnce();

    const st = engine.store.list<MessageStateDTO>("message_state").find((x) => x.messageId === w.messageId);
    expect(st).toMatchObject({ state: "resurfaced", bubbleUpAt: null });

    // THE POINT. Pinned at the top of the Ohbox on a client that never restarted — which is only
    // true because the pass emitted the `message` change too.
    expect(
      engine.store.get<EngineMessage>("message", w.messageId)?.triage?.state,
      "the message projection still carries the pre-flip state — the `message` change is missing " +
        "from bubbleUpPass, so the row moves for nobody until a re-bootstrap",
    ).toBe("resurfaced");
    const view = ohboxView(engine.store);
    expect(view.resurfaced.map((m) => m.id)).toEqual([w.messageId]);
    expect(view.newForYou.map((m) => m.id)).not.toContain(w.messageId);
    expect(view.previouslySeen.map((m) => m.id)).not.toContain(w.messageId);

    // Idempotent convergence (§3.4), and the pass's own idempotence beside it: a second pass over
    // an already-flipped row emits nothing, so a second drain has nothing to change its mind with.
    expect((await bubbleUpPass(w.db as unknown as Tx, new Date(due.getTime() + 2_000), {
      accountId: w.s.accountId, mailboxIds: [w.mailboxId],
    })).flipped).toBe(0);
    const snapshot = JSON.stringify([...engine.store.snapshot().entries()].sort());
    await engine.syncOnce();
    expect(JSON.stringify([...engine.store.snapshot().entries()].sort())).toBe(snapshot);
  });

  /**
   * OPTIMISTIC / WIRE AGREEMENT for `mark_seen` on a NON-Reads folder — the exact disagreement
   * `feed_mark_seen` has, asserted against the real server rather than argued about.
   *
   * The two halves of a mutation must mean the same thing, or the UI shows one state and the
   * next drain silently replaces it with another. `feed_mark_seen` fails that outside its
   * view's folder BY CONSTRUCTION (per-`FeedView` now, `ohmail/News` here by default): its
   * optimistic effect filters the id list to that folder, its wire side PATCHes whatever it
   * is given. Both cases below run on the seeded INBOX message, so they differ in nothing
   * except which mutation is dispatched.
   */
  it("mark_seen on an INBOX message: the overlay and the authoritative delta agree", async () => {
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const engine = new OhmailEngine({ adapter });
    await engine.start();
    expect(engine.read().get<EngineMessage>("message", w.messageId)?.unread).toBe(true);

    const res = await engine.mutate({ kind: "mark_seen", messageIds: [w.messageId], unread: false });
    expect(res.status).toBe("confirmed");
    expect(res.seq).not.toBeNull();

    // The overlay has been dropped by now, so this is the AUTHORITATIVE mirror answering.
    expect(engine.store.get<EngineMessage>("message", w.messageId)?.unread).toBe(false);
    expect(engine.pendingMutations()).toHaveLength(0);

    // And a second drain does not change its mind.
    const snapshot = JSON.stringify([...engine.store.snapshot().entries()].sort());
    await engine.syncOnce();
    expect(JSON.stringify([...engine.store.snapshot().entries()].sort())).toBe(snapshot);
  });

  it("…and `feed_mark_seen` on the SAME message does NOT — which is why it was not reused", async () => {
    // The disagreement, made observable. The optimistic effect drops the id (wrong folder), so
    // `mutationEffects` returns nothing and the engine reports a local rejection — while the
    // server, had the request been sent, would have flipped the row. Reusing this mutation for
    // the Ohbox would have produced a row that stays bold and then changes under the cursor on
    // the next drain.
    const w = await backendWorld();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const engine = new OhmailEngine({ adapter });
    await engine.start();

    const res = await engine.mutate({ kind: "feed_mark_seen", messageIds: [w.messageId] });
    expect(res.status).toBe("rolled_back");
    expect(engine.store.get<EngineMessage>("message", w.messageId)?.unread).toBe(true);
  });

  /**
   * THE PROOF: the Screener exists on a Cloud account, and a decision converges —
   * against the real server, over the unchanged wire.
   *
   * No `screener_sender` crosses the wire and the engine never calls `GET /screener`.
   * The queue is grouped out of the message mirror, the row's id is the representative
   * MESSAGE id, and `POST /screener/:id` resolves exactly that (`screener-service.ts:144`).
   * Convergence rides `/sync`'s existing vocabulary: per-message `move` changes plus a
   * `rule` create.
   */
  it("the Screener DERIVES from the mirror, and a decide converges through /sync", async () => {
    const w = await screenerBackend();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const engine = new OhmailEngine({ adapter });
    await engine.start();

    // The mirror alone answers the Screener — 3 held messages, 2 first-contact senders.
    const before = screenerSegments(engine.read(), FIXED_NOW);
    expect(before.waiting).toHaveLength(2);
    expect(before.waiting.flatMap((s) => s.held)).toHaveLength(3);
    expect(before.waiting.every((s) => s.derived)).toBe(true);
    // Nothing the server sent was a screener entity: derivation, not a new wire type.
    expect(engine.store.list("screener_sender")).toEqual([]);

    const lena = before.waiting.find((s) => s.from.address === "lena@atelier.example")!;
    expect(lena.id).toBe(w.lenaNewest);          // the representative IS the newest message
    expect(lena.held).toHaveLength(2);           // NO-COLLAPSE: both, not a count

    const res = await engine.mutate({ kind: "screener_decide", senderId: lena.id, decision: "yes" });
    expect(res.status).toBe("confirmed");

    // The overlay is gone by now, so the AUTHORITATIVE mirror is answering: the sender's
    // segment emptied and their mail moved, both carried by `/sync`.
    const after = screenerSegments(engine.store, FIXED_NOW);
    expect(after.waiting.map((s) => s.from.address)).toEqual(["paperbird@news.example"]);
    for (const id of [w.lenaOldest, w.lenaNewest]) {
      expect(engine.store.get<EngineMessage>("message", id)?.folder).toBe("INBOX");
    }
    expect(engine.store.get<EngineMessage>("message", w.paperbird)?.folder).toBe("ohmail/Screener");

    // …and the promoted rule arrived over the same feed.
    const rule = engine.store.list<RuleDTO>("rule").find((r) => r.match === "lena@atelier.example");
    expect(rule).toMatchObject({ kind: "sender", destination: "INBOX", provenance: "promoted", enabled: true });

    // A second drain does not change its mind (idempotent convergence, §3.4).
    const snapshot = JSON.stringify([...engine.store.snapshot().entries()].sort());
    await engine.syncOnce();
    expect(JSON.stringify([...engine.store.snapshot().entries()].sort())).toBe(snapshot);
    expect(engine.pendingMutations()).toHaveLength(0);
  });

  it("replaying a decide with the SAME Idempotency-Key creates no second rule", async () => {
    const w = await screenerBackend();
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl });
    const key = "contract-screener-key-1";
    const decide = { kind: "screener_decide", senderId: w.lenaNewest, decision: "yes" } as const;

    // The decide endpoint echoes no X-Sync-Seq (the engine drains `/sync` instead —
    // `http-adapter.ts:184-186`), so the replay is judged by two things: that it answers
    // at all, and the server's own change log.
    await adapter.mutate(decide, { idempotencyKey: key });
    const retry = await adapter.mutate(decide, { idempotencyKey: key }).catch((e: unknown) => e);
    // The STORED response replays verbatim. Without the claim written IN the decide tx
    // this re-executes instead — and re-execution now 404s, because the mail it
    // resolves by is no longer held in `ohmail/Screener`.
    expect(retry).not.toBeInstanceOf(Error);

    // The SERVER's change log holds exactly ONE promoted rule and ONE move per message.
    const all = flattenResponse(await adapter.sync({ since: "0", limit: 2000 }));
    const rules = all.filter((c) => c.type === "rule" && c.op === "create");
    expect(rules).toHaveLength(1);
    expect((rules[0]!.entity as RuleDTO).match).toBe("lena@atelier.example");
    for (const id of [w.lenaOldest, w.lenaNewest]) {
      const moves = all.filter((c) => c.type === "message" && c.id === id && c.op === "move");
      expect(moves).toHaveLength(1);
      expect(moves[0]!.move).toEqual({ from: "ohmail/Screener", to: "INBOX" });
    }
  });

  it("web cookie mode: X-CSRF-Token is echoed from tf_csrf; a missing token is a hard 403 rollback", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", subject: "csrf", unread: true });
    // DERIVED from the session token, which is what the server now recomputes and compares
    // against — a literal is nobody's CSRF token any more. See `cookies.ts#csrfTokenFor`.
    const csrf = csrfTokenFor(s.token);
    const cookieFetch = bridgeFetch(deps, { cookies: { tf_session: s.token, tf_csrf: csrf } });
    // Emit the message's change over the cookie'd wire (needs the CSRF header too).
    const patch = await cookieFetch(`http://localhost/messages/${m.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ unread: true }),
    });
    expect(patch.status).toBe(200);

    // The adapter reads tf_csrf via its cookie reader (document.cookie on web).
    const adapter = new HttpAdapter({
      baseUrl: "http://localhost",
      fetch: cookieFetch,
      getCookie: (name) => (name === "tf_csrf" ? csrf : null),
    });
    const engine = new OhmailEngine({ adapter });
    await engine.start();
    const ok = await engine.mutate({ kind: "move", messageId: m.id, folder: "ohmail/News" });
    expect(ok.status).toBe("confirmed");

    // Without the cookie reader the double-submit check fails closed: 403, not retryable.
    const blind = new HttpAdapter({ baseUrl: "http://localhost", fetch: cookieFetch, getCookie: () => null });
    const blindEngine = new OhmailEngine({ adapter: blind, store: engine.store });
    const rejected = await blindEngine.mutate({ kind: "move", messageId: m.id, folder: "INBOX" });
    expect(rejected.status).toBe("rolled_back");
    expect(rejected.error?.status).toBe(403);
    // The optimistic overlay rolled back to the authoritative state.
    expect(blindEngine.read().get<EngineMessage>("message", m.id)?.folder).toBe("ohmail/News");
  });

  /**
   * ═══ THE TRIAGE PILES OVER THE REAL WIRE — one membership per message, at every instant ═══
   *
   * The live wire keys `message_state` by the SERVER'S row id (`TriageService.setState` emits
   * `entityId: row.id`; the snapshot says "the entity id is the ROW id in every case") — an id
   * the client only learns from the drain. The optimistic overlay used to key the same entity
   * by `messageId` unconditionally, so it neither replaced nor tombstoned the settled record:
   * each gesture whose mutation was still in flight (or parked in the retry queue) stacked one
   * phantom row on the settled one — a live rail badge said "Parked 6" over a pile of one until
   * a reload emptied the overlays — and only the real backend exposes it, because the
   * FixturesAdapter keys both sides by `messageId`. Two mechanisms hold the invariant now:
   * `mutationEffects` writes at the mirror's own record id (`stateRecordIdOf`), and
   * `triagePiles` collapses records by `messageId`, which covers the window where a drain lands
   * the settled row under a still-standing overlay. `triage-pile-parity.test.ts` drives both
   * against a live-SHAPED adapter; these three run the same lifecycle against the REAL backend,
   * so the keying premise itself is asserted against the server that produces it rather than a
   * simulation of it.
   */
  describe("triage piles: no over-count in the optimistic window (real row-id keying)", () => {
    /** Wrap the backend's fetch so the NEXT /triage POST parks until released — the optimistic
     *  window, held open for as long as the assertions need. */
    function gate(fetchImpl: FetchLike) {
      let release: (() => void) | null = null;
      let hold = false;
      const gated: FetchLike = async (url, init) => {
        if (hold && String(url).includes("/triage")) {
          hold = false;
          await new Promise<void>((r) => { release = r; });
        }
        return fetchImpl(url, init);
      };
      return { gated, holdNext: () => { hold = true; }, release: () => release?.() };
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it("re-filing counts the message in exactly ONE pile while the mutation is in flight", async () => {
      const w = await backendWorld();
      const g = gate(w.fetchImpl);
      const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: g.gated }) });
      await engine.start();

      // Settle "Answer later" over the real wire — and assert the premise of this whole block:
      // the mirror's row is keyed by the server's ROW id, not the message id. If a future server
      // ever keys these by message id the mismatch is gone and this block should be rethought,
      // so the fixture states its own ground rather than drifting quiet.
      const first = await engine.mutate({ kind: "triage_set", messageId: w.messageId, state: "reply_later" });
      expect(first.status).toBe("confirmed");
      const settled = engine.store.entries<MessageStateDTO>("message_state")
        .find((e) => e.entity.messageId === w.messageId);
      expect(settled).toBeDefined();
      expect(settled!.id).not.toBe(w.messageId);

      // Drag it to Parked, and HOLD the POST open.
      g.holdNext();
      const parked = engine.mutate({ kind: "triage_set", messageId: w.messageId, state: "set_aside" });
      await tick();

      // The piles must present the message ONCE, in the pile of the newest gesture: an overlay
      // that misses the settled record's key leaves it standing in Answer Later while the park
      // is in flight — two piles at once, which is the over-count the rail badge rendered.
      const during = triagePiles(engine.read());
      expect(during.setAside.filter((e) => e.messageId === w.messageId)).toHaveLength(1);
      expect(during.replyLater.filter((e) => e.messageId === w.messageId)).toHaveLength(0);

      g.release();
      await expect(parked).resolves.toMatchObject({ status: "confirmed" });
      const after = triagePiles(engine.read());
      expect(after.setAside.filter((e) => e.messageId === w.messageId)).toHaveLength(1);
      expect(after.replyLater).toHaveLength(0);
    });

    it("un-filing takes the message out of its pile IMMEDIATELY, not a drain later", async () => {
      const w = await backendWorld();
      const g = gate(w.fetchImpl);
      const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: g.gated }) });
      await engine.start();

      const park = await engine.mutate({ kind: "triage_set", messageId: w.messageId, state: "set_aside" });
      expect(park.status).toBe("confirmed");
      expect(triagePiles(engine.read()).setAside).toHaveLength(1);

      // The un-park, with the POST held: the overlay is all there is. A delete keyed by the
      // message id cannot touch the server-keyed row, so this used to leave the pile count
      // standing for the whole window — a dead-looking button that "worked" a drain later.
      g.holdNext();
      const clear = engine.mutate({ kind: "triage_set", messageId: w.messageId, state: "none" });
      await tick();
      expect(triagePiles(engine.read()).setAside).toHaveLength(0);

      g.release();
      await expect(clear).resolves.toMatchObject({ status: "confirmed" });
      expect(triagePiles(engine.read()).setAside).toHaveLength(0);
      // The row settles to `state: "none"` rather than vanishing — the server never deletes
      // these rows (its clear is the same `onConflictDoUpdate`), so after the drain the mirror
      // holds the none-state record the overlay's tombstone stood in for.
      const st = engine.store.list<MessageStateDTO>("message_state").find((x) => x.messageId === w.messageId);
      expect(st?.state).toBe("none");
    });

    it("a park from clean shows at most ONE Parked row at every notification it emits", async () => {
      const w = await backendWorld();
      const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl }) });
      await engine.start();

      // A census at every notify — the same instants a subscribed rail badge repaints at. The
      // window this exists for: the reconciling drain lands the server-keyed row while the
      // overlay still stands, so row cardinality says 2 between those two notifications.
      const counts: number[] = [];
      engine.subscribe(() => { counts.push(triagePiles(engine.read()).setAside.length); });

      const res = await engine.mutate({ kind: "triage_set", messageId: w.messageId, state: "set_aside" });
      expect(res.status).toBe("confirmed");
      expect(counts.length).toBeGreaterThan(0);
      expect(Math.max(...counts)).toBe(1);
      expect(triagePiles(engine.read()).setAside).toHaveLength(1);
    });
  });
});

/**
 * A PERSON'S READ OR UNREAD ANSWERED RETRYABLY AFTER A NEWER PRESS ON ITS LETTERS: the newest press
 * decides each letter's flag. The older verb goes again only with the letters the newer one did not
 * name, under its own key; with none left it is not sent again. Answered 500 (the server took
 * nothing) or dropped after the server applied it, the case a cut connection leaves.
 */
describe("a person's read answered retryably after a newer press (real wire)", () => {
  type Step = { hold?: boolean; fault?: "500" | "drop" };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  async function world(n: number, plan: (batch: number) => Step) {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const plain = bridgeFetch(deps, { bearer: s.token });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", subject: `letter ${i}`, unread: true });
      const r = await plain(`http://localhost/messages/${m.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ unread: true }),
      });
      expect(r.status).toBe(200);
      ids.push(m.id);
    }
    const wire: Array<{ said: string; key: string }> = [];
    const releases: Array<() => void> = [];
    const faulty: FetchLike = async (url, init) => {
      if (init?.method !== "PATCH" || new URL(String(url)).pathname !== "/messages") return plain(url, init);
      const body = JSON.parse(String(init.body)) as { ids: string[]; unread: boolean };
      const key = new Headers(init.headers as HeadersInit | undefined).get("idempotency-key") ?? "";
      wire.push({ said: `${body.ids.map((id) => ids.indexOf(id)).join(",")} ${body.unread ? "unread" : "read"}`, key });
      const step = plan(wire.length);
      if (step.hold) await new Promise<void>((r) => { releases.push(r); });
      if (step.fault === "500") {
        return new Response(JSON.stringify({ error: { code: "internal", message: "internal error" } }),
          { status: 500, headers: { "content-type": "application/json" } });
      }
      const res = await plain(url, init);
      if (step.fault === "drop") throw new TypeError("fetch failed: other side closed");
      return res;
    };
    const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: faulty }) });
    await engine.start();
    const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
    const until = async (count: number) => { for (let i = 0; i < 100 && wire.length < count; i++) await tick(); };
    const unread = async () => Promise.all(ids.map(async (id) =>
      ((await (await plain(`http://localhost/messages/${id}`, {})).json()) as { unread: boolean }).unread));
    const mirror = () => ids.map((id) => engine.read().get<EngineMessage>("message", id)?.unread);
    return { engine, ids, wire, releases, settle, until, unread, mirror };
  }

  for (const n of [1, 3]) {
    for (const fault of ["500", "drop"] as const) {
      it(`a Mark read over ${n} answered ${fault}, a Mark unread on the first meanwhile: the first ends unread`, async () => {
        const w = await world(n, (b) => (b === 1 ? { hold: true, fault } : {}));
        const read = w.engine.mutate({ kind: "mark_seen", messageIds: w.ids, unread: false });
        await w.until(1);
        const unread = w.engine.mutate({ kind: "mark_seen", messageIds: [w.ids[0]!], unread: true });
        await w.settle();
        w.releases[0]!();
        const [r, u] = await Promise.all([read, unread]);
        const flushed = await w.engine.flushPending();
        await w.settle();

        expect(u.status).toBe("confirmed");
        const rest = n === 1 ? [] : ["1,2 read"];
        expect(w.wire.map((x) => x.said), "the older read went again over the newer Mark unread")
          .toEqual([n === 1 ? "0 read" : "0,1,2 read", "0 unread", ...rest]);
        expect(w.wire.filter((x) => x.said.endsWith(" read")).every((x) => x.key === r.key), "the read went again under a new key").toBe(true);
        const settled = [r, ...flushed].filter((x) => x.key === r.key).map((x) => x.status);
        expect(settled.at(-1)).toBe(n === 1 ? "superseded" : "confirmed");
        const expected = w.ids.map((_id, i) => i === 0);
        expect(await w.unread(), "the server ended on the older press").toEqual(expected);
        expect(w.mirror(), "the mirror disagrees with the server").toEqual(expected);
        expect(w.engine.pendingMutations()).toEqual([]);
      }, 30_000);
    }
  }

  it("a Mark unread answered 500, a Mark read made meanwhile: the letter ends read", async () => {
    const w = await world(1, (b) => (b === 1 ? { hold: true, fault: "500" } : {}));
    const unread = w.engine.mutate({ kind: "mark_seen", messageIds: w.ids, unread: true });
    await w.until(1);
    const read = w.engine.mutate({ kind: "mark_seen", messageIds: w.ids, unread: false });
    await w.settle();
    w.releases[0]!();
    await Promise.all([unread, read]);
    await w.engine.flushPending();
    await w.settle();

    expect(w.wire.map((x) => x.said), "the older unread went again over the newer read").toEqual(["0 unread", "0 read"]);
    expect(await w.unread()).toEqual([false]);
    expect(w.mirror()).toEqual([false]);
  }, 30_000);

  it("a Mark read waiting its turn loses the letter a Mark unread names, before its first send", async () => {
    // Letter 2's read holds the wire; the read over 0 and 1 waits behind it and is answered 500.
    const w = await world(3, (b) => (b === 1 ? { hold: true } : b === 2 ? { fault: "500" } : {}));
    const other = w.engine.mutate({ kind: "mark_seen", messageIds: [w.ids[2]!], unread: false });
    await w.until(1);
    const read = w.engine.mutate({ kind: "mark_seen", messageIds: [w.ids[0]!, w.ids[1]!], unread: false });
    await w.settle();
    const unread = w.engine.mutate({ kind: "mark_seen", messageIds: [w.ids[0]!], unread: true });
    await w.settle();
    w.releases[0]!();
    await Promise.all([other, read, unread]);
    await w.engine.flushPending();
    await w.settle();

    expect(w.wire.filter((x) => x.said.endsWith(" read") && x.said.split(" ")[0]!.split(",").includes("0")),
      "the waiting read carried a letter a newer press had marked unread").toEqual([]);
    expect(await w.unread()).toEqual([true, false, false]);
    expect(w.mirror()).toEqual([true, false, false]);
  }, 30_000);
});
