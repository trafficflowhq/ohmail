import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import {
  accountSettings, drafts as draftsTbl, mailboxFolders, mailboxes, messageBodies,
  outboundSends, recordChange, rules as rulesTbl, type LedgerTx, type Tx,
} from "@trafficflow/db";
import {
  FolderOpsService, setFoldersEnabled, runScheduledSendPass,
  type Db, type ServiceContext,
} from "@trafficflow/services";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
// The REAL worker passes — never stand-ins. What leg (c) of the matrix proves is that the
// passes production actually runs leave a user verb's effect standing, so a hand-rolled UPDATE
// here would assert nothing (the rule `contract.test.ts` states for `bubbleUpPass`).
//
// `bubble-up` rides the package's exports map because the sidecar genuinely shares it; the
// other three are worker-internal (nothing at runtime imports them from outside `apps/worker`),
// so widening the exports map for a test would put test-only doors on a published package —
// they are imported relatively instead, exactly as this suite already imports
// `../../api/test/helpers.js` across package lines.
import { bubbleUpPass } from "@trafficflow/worker/bubble-up";
import { ruleRetroPass } from "../../../../apps/worker/src/rule-retro.js";
import {
  awayReplyFlagRedeliverPass, type AwayReplyRedeliverResult,
} from "../../../../apps/worker/src/away-reply-flag-redeliver.js";
import { ohboxTidyPass } from "../../../../apps/worker/src/ohbox-tidy.js";
import { FIXED_NOW, makeDeps, seedMessage, seedScreenerHeld, seedSession, type TestClock } from "../../../api/test/helpers.js";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, OUTBOX_TYPE,
  type EngineMutation, type FetchLike,
} from "@ohmail/client-engine";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE VERB-PARITY WORLD — one real backend per scenario, three server-truth readers
   ══════════════════════════════════════════════════════════════════════════════════════════

   INSTANT-ARCH §6.2(e) / §8 stage 5: every user verb is driven through the REAL in-process API
   (`createApp(apiRoutes)` over PGlite, a seeded session, `HttpAdapter`'s injectable fetch aimed
   at `app.handle`) and judged three ways:

     (a) LANDS   — a FRESH engine bootstrapping from nothing sees the effect. That is server
                   truth by construction: nothing optimistic survives into a second mirror.
     (b) STICKS  — the SAME engine's next full sync cycle does not revert it. This is the
                   flip-under-the-eyes check: the overlay is gone by then, so a divergence
                   between a verb's optimistic half and its wire half reads as a row changing
                   under the cursor — the reported "screen twice, mark read twice" class.
     (c) SURVIVES THE WORKER — where a standing pass touches the same state (`bubbleUpPass`,
                   `ruleRetroPass`, `ohboxTidyPass`, the scheduled-send clock), the REAL pass
                   runs against the same database and the verb's effect still stands afterwards (user-intent-wins). Every pass leg carries its own
                   vacuity control — a sibling row the pass DOES act on — because a pass that
                   considered nothing proves nothing (the cold-account lesson).

   The runner (`verb-parity.matrix.test.ts`) owns (a)/(b) generically; scenarios own their
   seeds, their meaning of "landed", and leg (c). The census (`verb-parity.census.test.ts`)
   pins the registry against `MUTATION_KINDS`, so a NEW verb is red until it is classified.

   WHY IN-PROCESS AND NOT THE :5433 STAND-UP: the passes here are pure functions of a db handle
   (their own headers say so — "a test drives it against PGlite with no worker, no lease and no
   network"), which makes the worker half DETERMINISTIC: a scenario runs the pass at the exact
   clock instant it means to, instead of polling a live worker's cycle. The transactional
   claims PGlite cannot see (FOR UPDATE races, two concurrent drivers) stay where they already
   live: the `*.pg.test.ts` suites. IMAP-executing passes (reconcileFlags/reconcileFolders,
   junk filing's physical ride, the folder-op runner) need a mailbox on a wire and are
   deliberately out of leg (c) — each exclusion is written at its verb in `registry.ts`, and
   their own suites (`apps/worker` e2e + guard files) own that half.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const app = createApp(apiRoutes);

/** Trust-nothing authserv resolver — the explicit spelling the pass deps require. */
export const NO_TRUST = async (): Promise<ReadonlySet<string>> => new Set<string>();

export interface SendSpy {
  calls: number;
  delivered: OutboundMessage[];
  /**
   * OPT-IN: make the NEXT submission ambiguous, so a send lands `unverified`.
   *
   * `false` by default and read per call, which is the whole design of it — every scenario that
   * does not set it sees the adapter it always saw (one `send`, an ack carrying the minted id,
   * `messageInSent` false), so the covered verbs' scenarios are unchanged by this field existing.
   *
   * WHY A SWITCH RATHER THAN A SECOND WORLD. `unverified` is not a row a fixture may write: it is
   * where the product's own send path ends when SMTP THROWS and the Sent-folder probe then cannot
   * find the message (`send-service.ts`, the submission closure). Reaching it through that path is
   * the only way a parity scenario can claim the state is real — a hand-written ledger row would
   * measure the fixture. So the transport is made ambiguous for one press and the product decides,
   * exactly as it does against a provider that accepts the bytes and drops the connection.
   *
   * `calls` still counts the attempt: the submission DID happen, and that is the fact the hold is
   * about.
   */
  unverifiable: boolean;
}

export interface VerbWorld {
  db: Db;
  deps: ApiDeps;
  clock: TestClock;
  accountId: string;
  mailboxId: string;
  /**
   * The mailbox's own address — RANDOMISED per world, so it must be read and never assumed.
   * Any fixture about own-sent mail needs it: `consentPartition`'s `ownAddresses`, and the
   * `autoReplyByUsWhere` fragment, both decide "did WE write this" by comparing against it.
   */
  ownAddress: string;
  fetchImpl: FetchLike;
  engine: OhmailEngine;
  store: MemoryMirrorStore;
  /** The faked SMTP transport's spy — `sends.calls` is the double-delivery guard. */
  send: SendSpy;

  /**
   * LEG (d)'s WITNESS — was this verb ALREADY ON DISK when the wire was asked?
   *
   * Every request the engine issues under an `Idempotency-Key` is recorded here with one boolean:
   * whether the durable outbox held an entry under that key at the instant the request left. The
   * contract it pins is INSTANT-ARCH §6.2(b) stage 1 — *the intent is durable the moment it is
   * expressed*, and `OhmailEngine.mutate` writes the entry BEFORE it dispatches precisely so that a
   * process killed between the POST and the answer restarts with the verb intact and replays it
   * under the same key.
   *
   * It exists because that ordering is invisible to legs (a)–(c). All three read the world AFTER
   * the verb settled, by which time the entry has been dropped again, so an engine that persisted
   * AFTER the response — or not at all — would keep every one of them green while losing every
   * verb a killed tab was holding. That is the durability half of the class the closing review
   * named ("this product decides in memory and persists afterwards"), and this is where the census
   * can see it for every verb at once rather than one surface at a time.
   */
  wireWitness: Array<{ key: string; kind: string; heldAtWire: boolean }>;
  /** Leg (d)'s oracle: the wire was asked under `key`, and never before the entry was on disk. */
  durableAtWire(key: string): { asked: number; volatile: number };

  /** Emit a seeded message's change over the REAL wire (the `contract.test.ts` idiom). */
  emit(messageId: string, unread?: boolean): Promise<void>;
  /** Seed one message into a folder AND make it change-log-visible. */
  seedMail(o?: {
    folder?: string; subject?: string; fromAddress?: string; unread?: boolean; date?: Date;
  }): Promise<string>;
  /** Screener-held first-contact mail, change-log-visible. */
  seedHeld(o: { fromAddress: string; subject?: string; date?: Date }): Promise<string>;
  /**
   * A draft HELD by a send nobody could confirm: `drafts.status = 'unverified'` beside its own
   * `outbound_sends` row at `unverified`. Driven through the ENGINE'S OWN VERBS — `draft_save`
   * then `mail_send` — with the transport made ambiguous for that one press, so the state is the
   * one the product produces rather than one a fixture wrote.
   *
   * It ASSERTS the precondition by name before returning. Without that, dropping the ambiguous
   * mode would leave a `sent` draft and the resolution scenarios would assert against a row that
   * was never held — passing or failing for a reason that has nothing to do with the verb.
   */
  seedUnverifiedSend(o?: { subject?: string }): Promise<{ draftId: string; subject: string }>;
  /** A message's raw header bag (what `evaluateRules`' verdict reads). */
  seedHeaders(messageId: string, headers: Record<string, string[]>): Promise<void>;
  /** Flip the per-account folders flag — every folder verb 403s `folders_disabled` without it. */
  enableFolders(): Promise<void>;
  /** A SETTLED user folder (inventory row + `folder` create change) — no worker exists here. */
  seedSettledFolder(name: string): Promise<string>;
  /** Arm the Ohbox posture pass exactly as a `people_only` opt-in does. */
  armOhboxTidy(): Promise<void>;
  /** A rules row seeded server-side (for worlds whose subject is not rule_create). */
  seedRule(o: {
    match: string; destination: string; kind?: "sender" | "domain";
    provenance?: string;
  }): Promise<string>;

  /** (a)'s reader: a SECOND engine bootstrapping from nothing — server truth by construction. */
  freshStore(): Promise<MemoryMirrorStore>;

  /** The real passes, bound to this world's database. */
  pass: {
    bubbleUp(at: Date): Promise<{ flipped: number }>;
    ruleRetro(): Promise<{ moved: number; completed: number }>;
    ohboxTidy(): Promise<{ ran: boolean; examined: number; moved: number; kept: number }>;
    scheduledSend(at: Date): Promise<{ claimed: number; sent: number }>;
    /**
     * The one-time `autoReplyByUs` re-delivery — see `away-reply-flag-redeliver.ts`.
     *
     * The PASS'S OWN RESULT TYPE, not a restatement of its shape. It was written out here as
     * `{ examined, redelivered, capped }` and then the pass replaced `capped` with `exhausted`
     * plus a `cursor` — so the declaration and the implementation disagreed, and nothing local
     * said so: `pnpm typecheck` does not reach this directory, and the run that would have caught
     * it (`typecheck-test-dirs.mjs`) was made before that rename and not after. Naming the type
     * makes the next such rename a compile error here instead of a ratchet breach two lanes later.
     */
    awayReplyFlagRedeliver(): Promise<AwayReplyRedeliverResult>;
  };
}

/** One fresh world: PGlite + the real route table + a seeded session + a drained engine. */
export async function verbWorld(): Promise<VerbWorld> {
  const send: SendSpy = { calls: 0, delivered: [], unverifiable: false };
  const sendAdapter: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      send.calls += 1;
      /* The AMBIGUOUS submission, opt-in per call — see `SendSpy.unverifiable`. Throwing here is
         what the real transport does when it accepts the bytes and then loses the connection, and
         it is the only door to `unverified`: the send path answers a throw by PROBING Sent, and
         `messageInSent` below says no, so it finalizes `unverified` rather than guessing.
         BEFORE `delivered`, deliberately: an ambiguous submission is not a delivery, and the spy
         that pins this state elsewhere (`mail-send.test.ts`, the `throwOnSend` arm) leaves its own
         delivered list empty for the same reason. `calls` still counts the attempt. */
      if (send.unverifiable) throw new Error("verb-parity: the submission was made ambiguous");
      send.delivered.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* no-op */ },
  });

  const { db, deps, clock } = await makeDeps(FIXED_NOW, {}, { sendAdapter });
  // The folder verbs' service is OPTIONAL on ApiDeps (a host without a worker lane wires none)
  // and `makeDeps` predates it — wired here exactly as the hosted composition wires it, so the
  // /folders verbs answer instead of 500ing `folder ops service not configured`.
  // `services` is OPTIONAL on ApiDeps and `ApiServices` is fully required, so there is no empty
  // bag to substitute — the first attempt at this assigned `{}` and traded one type error for two.
  // `makeDeps` always provides one; that premise is ASSERTED here rather than assumed, so a change
  // in `makeDeps` fails with a sentence instead of a narrowing error two lanes later.
  if (!deps.services) throw new Error("verbWorld: makeDeps provided no services bag");
  deps.services.folderOps = new FolderOpsService();
  const s = await seedSession(db, { now: FIXED_NOW });
  const wireWitness: Array<{ key: string; kind: string; heldAtWire: boolean }> = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    const req = new Request(url, { ...init, headers });
    return app.handle(req, { ...deps, session: null, idempotency: null });
  };

  // One mailbox for the whole world. Messages are seeded rows made change-log-visible over the
  // real wire (`emit`), because ingest is the worker's and there is no worker here. The Trash
  // folder is discovered at connect time in production; seeded here because `DELETE
  // /messages/:id` and the folder-delete ceremony refuse a mailbox without one (422).
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: `own-${randomUUID().slice(0, 8)}@example.com`,
    trashFolder: "Trash",
  }).returning();
  const mailboxId = mb!.id;
  const ownAddress = mb!.address;

  const store = new MemoryMirrorStore();

  /**
   * LEG (d)'s WITNESS, TAKEN AT THE ADAPTER — the wire boundary, and the one place every verb
   * passes through.
   *
   * The first draft read the `idempotency-key` HEADER inside `fetchImpl`, which is a finer claim
   * (the entry is on disk when the REQUEST leaves) and turned out to be an unusable one:
   * `feed_mark_seen` deliberately sends no key at all — it is a per-message `PATCH`, idempotent by
   * definition — so the leg was vacuous for it and the vacuity guard said so on the first run.
   * Rather than carve out an exclusion for the one verb whose wire shape differs, the witness moved
   * to the seam every verb shares. `OhmailEngine.mutate` writes the outbox entry and only then
   * calls `dispatch`, which calls this; moving `putOutbox` below `dispatch` is exactly the mutation
   * this catches, for all 22 covered kinds at once.
   */
  const inner = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
  const adapter = new Proxy(inner, {
    get(target, prop, _recv) {
      if (prop === "mutate") {
        return async (m: EngineMutation, opts: { idempotencyKey: string }) => {
          wireWitness.push({
            key: opts.idempotencyKey,
            kind: m.kind,
            heldAtWire: store.entries<unknown>(OUTBOX_TYPE)
              .some((e) => (e.entity as { key?: unknown } | null)?.key === opts.idempotencyKey),
          });
          return target.mutate(m, opts);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      // Bound to the INSTANCE, not to the proxy: `HttpAdapter` reads private fields through
      // `this`, and a method invoked with the proxy as receiver would trip that.
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  /* ONE CLOCK FOR BOTH ENDS: the server's floor is its own now minus the press age the engine
     measures, so an engine on the wall clock against the fixed server clock reads every press as
     made before the seed that preceded it. */
  const engine = new OhmailEngine({ adapter, store, now: () => clock.now() });

  const emit = async (messageId: string, unread = true): Promise<void> => {
    const res = await fetchImpl(`http://localhost/messages/${messageId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unread }),
    });
    expect(res.status, `emit(${messageId}) — the seed never became change-log-visible`).toBe(200);
  };

  const svcCtx = (): ServiceContext => ({
    db, accountId: s.accountId, userId: null, now: () => clock.now(), requestId: "verb-parity",
  });

  const w: VerbWorld = {
    db, deps, clock, accountId: s.accountId, mailboxId, ownAddress, fetchImpl, engine, store, send,
    wireWitness,
    durableAtWire(key: string) {
      const rows = wireWitness.filter((r) => r.key === key);
      return { asked: rows.length, volatile: rows.filter((r) => !r.heldAtWire).length };
    },
    emit,

    async seedMail(o = {}) {
      const m = await seedMessage(db, {
        accountId: s.accountId, mailboxId,
        folder: o.folder ?? "INBOX",
        subject: o.subject ?? "Verb parity subject",
        fromAddress: o.fromAddress ?? "sender@example.com",
        unread: true,
        date: o.date ?? FIXED_NOW,
      });
      await emit(m.id, o.unread ?? true);
      // Drained at once, so a seed may drive FURTHER verbs through the engine against this
      // row — an engine asked to mutate a message its mirror has never seen rolls back locally
      // (zero effects) without touching the wire, by design.
      await engine.syncOnce();
      return m.id;
    },

    async seedHeld(o) {
      const m = await seedScreenerHeld(db, {
        accountId: s.accountId, mailboxId,
        fromAddress: o.fromAddress, subject: o.subject, date: o.date ?? FIXED_NOW,
      });
      await emit(m.id, true);
      await engine.syncOnce();
      return m.id;
    },

    async seedUnverifiedSend(o = {}) {
      const subject = o.subject ?? `Nicht bestätigt ${randomUUID().slice(0, 8)}`;
      const made = await engine.mutate({
        kind: "draft_save", draftId: null, mailboxId,
        subject, body: "Ist das angekommen?", to: [{ name: null, address: "you@example.com" }],
        cc: [], bcc: [],
      });
      expect(made.status, "the draft this hold is about was not saved").toBe("confirmed");
      const draftId = made.entityId!;

      /* ONE press, made ambiguous — the switch is set for the length of the submission and put
         back immediately, so nothing after this seeder sees a transport it did not ask for. */
      send.unverifiable = true;
      let pressed;
      try {
        pressed = await engine.mutate({
          kind: "mail_send", inReplyTo: null, draftId, mailboxId,
          subject, body: "Ist das angekommen?", to: [{ name: null, address: "you@example.com" }],
        });
      } finally {
        send.unverifiable = false;
      }
      /* THE PRESS'S OWN ANSWER, which is a REJECTION and not a failure. The engine recodes an
         unverified send to `send_unverified` precisely so the composer does not read it as
         "failed" and mint a fresh key for a message the reservation may already have sent
         (engine.ts, the recode's own docblock). `mail-send.test.ts`'s "SMTP threw and Sent has no
         copy" case pins the same three fields. */
      expect(pressed.status, "the ambiguous press did not settle as a rejection").toBe("rolled_back");
      expect(pressed.error?.code, "the press was not recoded to the send's own ambiguity")
        .toBe("send_unverified");
      expect(pressed.error?.retryable, "an unverified send must not advertise a blind retry")
        .toBe(false);

      /* THE PRECONDITION, ASSERTED BY NAME. Both halves, and each says what is missing rather
         than handing back a row nobody checked: a scenario that ran against a `sent` draft would
         be measuring the absence of the hold. */
      /* The whole (one-account, one-row) table, filtered in JS: this package does not depend
         on drizzle-orm and no test in it imports one — `select().from(t)` is the idiom here. */
      const row = (await db.select().from(outboundSends)).find((x) => x.draftId === draftId);
      expect(row?.status,
        "the send did not land UNVERIFIED — the world's ambiguous-submission mode is not in effect, "
        + "so there is no held row for a resolution to resolve")
        .toBe("unverified");
      const draftRow = (await db.select().from(draftsTbl)).find((x) => x.id === draftId);
      expect(draftRow?.status, "the ledger is unverified but the draft is not held").toBe("unverified");

      await engine.syncOnce();
      return { draftId, subject };
    },

    async seedHeaders(messageId, headers) {
      await db.insert(messageBodies).values({ messageId, text: "", html: null, headers });
    },

    async enableFolders() {
      await setFoldersEnabled(svcCtx(), true);
    },

    async seedSettledFolder(name) {
      const [row] = await db.insert(mailboxFolders)
        .values({ mailboxId, folder: name, uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n })
        .returning();
      // The change row a real discovery would have appended. Inside a transaction because the
      // ledger REFUSES a top-level handle (assertLedgerTx) — the seq allocation and the row
      // must commit together or a polling client can advance past a hole.
      await db.transaction(async (tx) => {
        // `LedgerTx`, not `Tx`: `recordChange` demands a real transaction handle so the seq
        // allocation and the row commit together, and that is what makes `recordChange(db, …)`
        // uncompilable.
        await recordChange(tx as unknown as LedgerTx, {
          accountId: s.accountId, entityType: "folder", entityId: row!.id, op: "create", meta: null,
        });
      });
      return row!.id;
    },

    async armOhboxTidy() {
      const at = clock.now();
      await db.insert(accountSettings)
        .values({ accountId: s.accountId, ohboxPolicy: "people_only", ohboxTidyRequestedAt: at })
        .onConflictDoUpdate({
          target: accountSettings.accountId,
          set: { ohboxPolicy: "people_only", ohboxTidyRequestedAt: at, ohboxTidyCursor: null },
        });
    },

    async seedRule(o) {
      const [r] = await db.insert(rulesTbl).values({
        accountId: s.accountId, kind: o.kind ?? "sender", match: o.match,
        destination: o.destination, priority: 0,
        provenance: o.provenance ?? "seeded-from-sent", enabled: true,
      }).returning();
      return r!.id;
    },

    async freshStore() {
      const fresh = new MemoryMirrorStore();
      const second = new OhmailEngine({
        adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }),
        store: fresh,
      });
      await second.start();
      return fresh;
    },

    pass: {
      async bubbleUp(at) {
        return bubbleUpPass(db as unknown as Tx, at, { accountId: s.accountId, mailboxIds: [mailboxId] });
      },
      async awayReplyFlagRedeliver() {
        return awayReplyFlagRedeliverPass(db as unknown as Tx, { accountId: s.accountId });
      },
      async ruleRetro() {
        return ruleRetroPass(db as unknown as Tx, {
          accountId: s.accountId, trustedAuthservIdsFor: NO_TRUST,
        }, clock.now());
      },
      async ohboxTidy() {
        return ohboxTidyPass(db as unknown as Tx, {
          accountId: s.accountId, trustedAuthservIdsFor: NO_TRUST,
        }, clock.now());
      },
      async scheduledSend(at) {
        return runScheduledSendPass(db, { openSendAdapter: sendAdapter, now: () => at });
      },
    },
  };
  return w;
}

/** The whole-mirror fingerprint used by the (b) leg's "a drain does not change its mind". */
export function snapshotOf(store: MemoryMirrorStore): string {
  return JSON.stringify([...store.snapshot().entries()].sort());
}
