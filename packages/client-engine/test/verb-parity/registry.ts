import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { folderOps, mailboxes, outboundSends, recordChange, type Tx } from "@trafficflow/db";
import { seedScreenerHeld } from "../../../api/test/helpers.js";
import {
  ohboxView,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type FolderEntity,
  type MessageStateDTO,
  type MutationKind,
  type MutationResult,
  type RuleDTO,
  type TagDTO,
  type WaterlineMeta,
} from "@ohmail/client-engine";
import type { VerbWorld } from "./world.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE VERB REGISTRY — every EngineMutation kind, classified: covered (with scenarios) or
   deliberately out (with the reason written where the census can quote it).

   The registry is DATA the matrix runner generates tests from, which is what makes the census
   able to see coverage: an entry that vanishes, an empty scenario list, or a pass leg that is
   neither a real run nor a stated reason is a red census, not a silently narrower suite.

   Every scenario names three things (world.ts explains the three-legged contract):
     seed      — the world this verb acts in (server-side rows made change-log-visible, and any
                 prior verbs driven through the SAME engine);
     mutation  — the ONE verb under test;
     landed    — what the verb's effect means in SERVER truth, asserted against any reader that
                 claims it (the fresh bootstrap for (a), the drained live mirror for (b) and (c)).
   Plus leg (c): either `run` drives the real worker pass (with its own vacuity control — a
   sibling row the pass provably acts on), or `none` states why no in-process standing pass
   touches this verb's state. `landedAfterPass` exists for exactly one shape: a pass whose JOB
   is to transform the verb's state on schedule (the resurface flip, the send-later fire) —
   there "the verb's effect stands" means THE TRANSFORMATION HAPPENED AS ASKED, and the
   override says so explicitly instead of the leg being skipped.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

type Ctx = Record<string, string | number>;

export interface VerbScenario {
  name: string;
  seed: (w: VerbWorld) => Promise<Ctx>;
  mutation: (w: VerbWorld, ctx: Ctx) => EngineMutation;
  landed: (r: EntityReader, ctx: Ctx, w: VerbWorld, res: MutationResult) => void | Promise<void>;
  /**
   * THE OPTIMISTIC ORACLE — leg (o), the front half of overlay ≡ echo (a review finding).
   *
   * Run against `engine.read()` IN THE SAME TICK the verb is dispatched, before its promise is
   * awaited — the engine applies `mutationEffects` synchronously before its first await, so
   * this reads the pure overlay, never the echo. Without it, an overlay that paints the WRONG
   * entity while the server stores the right one keeps every settled leg green and still flips
   * on screen — the exact class the harness exists for, invisible to legs (a)–(c) alone.
   *
   *  - `"landed"`: the overlay already shows the verb's settled meaning — the `landed` oracle
   *    is reused verbatim (only legal where `landed` ignores the MutationResult, which does
   *    not exist yet).
   *  - a function: the verb's identity swaps on confirm (client-minted ids, status ladders),
   *    so the optimistic claim is stated in its own terms.
   *  - `{ none: reason }`: no assertable optimistic projection — the reason is written where
   *    the census quotes it, so the leg cannot be skipped silently.
   */
  optimistic:
    | "landed"
    | ((r: EntityReader, ctx: Ctx, w: VerbWorld) => void)
    | { none: string };
  /** Client-local extras (waterlines, overlays) — live engine only, never a fresh mirror. */
  local?: (w: VerbWorld, ctx: Ctx) => void | Promise<void>;
  pass:
    | { name: string; run: (w: VerbWorld, ctx: Ctx) => Promise<void> }
    | { none: string };
  /** Only for a pass whose scheduled TRANSFORMATION is the verb's own intent — see header. */
  landedAfterPass?: (r: EntityReader, ctx: Ctx, w: VerbWorld, res: MutationResult) => void | Promise<void>;
}

export interface VerbEntry {
  coverage: "covered" | { out: string };
  scenarios: VerbScenario[];
}

/** A single List-Unsubscribe — automated-shaped mail for the tidy pass's policy class. */
const BULK = { "list-unsubscribe": ["<https://x.test/u>"] };

const iso = (t: number): string => new Date(t).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

const msgOf = (r: EntityReader, id: string): EngineMessage | undefined =>
  r.get<EngineMessage>("message", id);
const stateOf = (r: EntityReader, messageId: string): MessageStateDTO | undefined =>
  r.list<MessageStateDTO>("message_state").find((x) => x.messageId === messageId);
const tagByName = (r: EntityReader, name: string): TagDTO | undefined =>
  r.list<TagDTO>("tag").find((t) => t.name === name);
const folderByName = (r: EntityReader, name: string): FolderEntity | undefined =>
  r.list<FolderEntity>("folder").find((f) => f.name === name);

/** Runs every worker pass the world drives, at the world's clock. */
const runEveryPass = async (w: VerbWorld): Promise<void> => {
  const passes = Object.values(w.pass) as ((at: Date) => Promise<unknown>)[];
  expect(passes.length, "vacuity: the world drives no pass").toBeGreaterThanOrEqual(5);
  for (const run of passes) await run(w.clock.now());
};

export const VERB_MATRIX: Record<MutationKind, VerbEntry> = {
  // ── the message verbs ─────────────────────────────────────────────────────────────────────

  move: {
    coverage: "covered",
    scenarios: [
      {
        name: "a move to ohmail/News lands, and the next cycle does not pull it back",
        seed: async (w) => ({ id: await w.seedMail() }),
        mutation: (_w, c) => ({ kind: "move", messageId: c.id as string, folder: "ohmail/News" }),
        landed: (r, c) => {
          expect(msgOf(r, c.id as string)?.folder).toBe("ohmail/News");
        },
        optimistic: "landed",
        pass: {
          none: "the physical IMAP move is reconcileFolders' alone (fenced, under the lease) — " +
            "apps/worker's e2e + folder-state pg suites own that half; the db-level standing pass " +
            "that CAN re-decide a placement (ohboxTidyPass) is driven by the drag-back scenario below",
        },
      },
      {
        name: "a junk verdict (move to the spam pile) lands and sticks",
        seed: async (w) => ({ id: await w.seedMail({ fromAddress: "spammer@junk.example" }) }),
        mutation: (_w, c) => ({ kind: "move", messageId: c.id as string, folder: "ohmail/Quarantine" }),
        landed: (r, c) => {
          expect(msgOf(r, c.id as string)?.folder).toBe("ohmail/Quarantine");
        },
        optimistic: "landed",
        pass: {
          none: "the verdict's physical ride to native \\Junk and its completion bookkeeping are " +
            "the reconciler's (junk-filing.ts, whose guard suite reddens on any claim-before-move " +
            "ordering); the PILE — what every client projects — is the server truth pinned here",
        },
      },
      {
        name: "a not-junk rescue (move back to INBOX) lands and sticks",
        seed: async (w) => {
          const id = await w.seedMail({ fromAddress: "friend@work.example" });
          const verdict = await w.engine.mutate({ kind: "move", messageId: id, folder: "ohmail/Quarantine" });
          expect(verdict.status).toBe("confirmed");
          return { id };
        },
        mutation: (_w, c) => ({ kind: "move", messageId: c.id as string, folder: "INBOX" }),
        landed: (r, c) => {
          expect(msgOf(r, c.id as string)?.folder).toBe("INBOX");
        },
        optimistic: "landed",
        pass: {
          none: "the rescue's physical move (native Junk → INBOX) is reconcileFolders' — " +
            "junk-restore.test.ts + its pg suite own it; the pile is asserted here",
        },
      },
      {
        name: "a drag back to the Ohbox SURVIVES ohboxTidyPass — user-always-wins, with a demoting control",
        seed: async (w) => {
          await w.armOhboxTidy();
          await w.seedRule({ match: "news@shop.test", destination: "INBOX", provenance: "seeded-from-sent" });
          // The row the user will drag home: automated-shaped, currently filed to Reads.
          const dragged = await w.seedMail({ folder: "ohmail/News", fromAddress: "news@shop.test", subject: "Weekly digest" });
          await w.seedHeaders(dragged, BULK);
          // The vacuity control: the identical shape, sitting in the Ohbox with NO user move —
          // the pass must demote it, or "the drag survived" proves only that nothing ran.
          const control = await w.seedMail({ folder: "INBOX", fromAddress: "news@shop.test", subject: "Weekly digest 2" });
          await w.seedHeaders(control, BULK);
          return { dragged, control };
        },
        mutation: (_w, c) => ({ kind: "move", messageId: c.dragged as string, folder: "INBOX" }),
        landed: (r, c) => {
          expect(msgOf(r, c.dragged as string)?.folder).toBe("INBOX");
        },
        optimistic: "landed",
        pass: {
          name: "ohboxTidyPass",
          run: async (w, c) => {
            const r = await w.pass.ohboxTidy();
            expect(r.ran, "the tidy pass never armed — the fixture is wrong, not the product").toBe(true);
            // Teeth: the control demoted (the pass really considered this account's Ohbox)…
            expect(r.moved, "vacuity control did not demote — the pass considered nothing").toBeGreaterThanOrEqual(1);
            await w.engine.syncOnce();
            expect(msgOf(w.store, c.control as string)?.folder).toBe("ohmail/News");
            // …and the runner re-asserts `landed` (the dragged row still in the Ohbox): the
            // user's drag wrote the change_log move-to-INBOX row the candidate query excludes.
          },
        },
      },
    ],
  },

  message_delete: {
    coverage: "covered",
    scenarios: [
      {
        name: "a delete tombstones everywhere, and a later worker flip on its state cannot resurrect it",
        seed: async (w) => {
          const id = await w.seedMail({ subject: "doomed" });
          const other = await w.seedMail({ subject: "stays" });
          const due = w.clock.now().getTime() + DAY;
          // A resurface appointment on the DOOMED row (set before the delete) and on a LIVING
          // control — the pass will fire both; only the living one may come back.
          for (const target of [id, other]) {
            const set = await w.engine.mutate({
              kind: "triage_set", messageId: target, state: "bubbled_up", bubbleUpAt: iso(due),
            });
            expect(set.status).toBe("confirmed");
          }
          return { id, other, due };
        },
        mutation: (_w, c) => ({ kind: "message_delete", messageId: c.id as string }),
        landed: (r, c) => {
          expect(msgOf(r, c.id as string), "the deleted row is still visible").toBeUndefined();
          expect(msgOf(r, c.other as string), "the delete leaked onto a sibling").toBeDefined();
        },
        optimistic: "landed",
        pass: {
          name: "bubbleUpPass",
          run: async (w, c) => {
            const { flipped } = await w.pass.bubbleUp(new Date((c.due as number) + 1_000));
            // Teeth: the living control's appointment fired…
            expect(flipped, "vacuity: no appointment fired at all").toBeGreaterThanOrEqual(1);
            await w.engine.syncOnce();
            expect(msgOf(w.store, c.other as string)?.triage?.state).toBe("resurfaced");
            // …and the deleted row did NOT ride the pass's `message` update back onto the
            // screen: a change for a tombstoned entity re-materializes as a delete
            // (sync-service.ts — "a getChanges row for a deleted entity already tombstones").
          },
        },
      },
    ],
  },

  triage_set: {
    coverage: "covered",
    scenarios: [
      {
        name: "park then clear: the un-park lands as state 'none' and stays cleared",
        seed: async (w) => {
          const id = await w.seedMail();
          const park = await w.engine.mutate({ kind: "triage_set", messageId: id, state: "reply_later" });
          expect(park.status).toBe("confirmed");
          return { id };
        },
        mutation: (_w, c) => ({ kind: "triage_set", messageId: c.id as string, state: "none" }),
        landed: (r, c) => {
          expect(stateOf(r, c.id as string)?.state).toBe("none");
        },
        // The overlay TOMBSTONES the settled record (the un-park's optimistic form); the
        // settled server row is a real state:"none". Both read as "in no pile".
        optimistic: (r, c) => {
          expect(stateOf(r, c.id as string)?.state ?? "none").toBe("none");
        },
        pass: {
          none: "no standing pass writes triage state except bubbleUpPass, which selects only due " +
            "`bubbled_up` rows — a `none` row is structurally outside its candidate set; the pass's " +
            "conduct around live schedules and pins is driven by the two scenarios below",
        },
      },
      {
        name: "a resurface schedule lands; the worker neither fires it EARLY nor drops it — and fires it exactly when asked",
        seed: async (w) => ({ id: await w.seedMail(), due: w.clock.now().getTime() + DAY }),
        mutation: (_w, c) => ({
          kind: "triage_set", messageId: c.id as string, state: "bubbled_up", bubbleUpAt: iso(c.due as number),
        }),
        landed: (r, c) => {
          const st = stateOf(r, c.id as string);
          expect(st?.state).toBe("bubbled_up");
          expect(new Date(st?.bubbleUpAt ?? 0).getTime()).toBe(c.due as number);
        },
        optimistic: "landed",
        pass: {
          name: "bubbleUpPass (early, then due)",
          run: async (w, c) => {
            // EARLY: an hour before the appointment nothing may fire — a pass that flips a
            // future schedule is the worker overriding the user's chosen instant.
            const early = await w.pass.bubbleUp(new Date((c.due as number) - HOUR));
            expect(early.flipped).toBe(0);
            await w.engine.syncOnce();
            expect(stateOf(w.store, c.id as string)?.state).toBe("bubbled_up");
            // DUE: the appointment fires — this doubles as the leg's vacuity control.
            const due = await w.pass.bubbleUp(new Date((c.due as number) + 1_000));
            expect(due.flipped).toBe(1);
          },
        },
        // After the due run the TRANSFORMATION is the verb's intent: pinned, schedule spent,
        // and — the 2026-08-26 ruling — the read state untouched by the flip.
        landedAfterPass: (r, c) => {
          const st = stateOf(r, c.id as string);
          expect(st?.state).toBe("resurfaced");
          expect(st?.bubbleUpAt).toBeNull();
          const msg = msgOf(r, c.id as string);
          expect(msg?.triage?.state).toBe("resurfaced");
          expect(msg?.unread, "the flip forged an artificial unread — the removed pre-ruling arm is back").toBe(true);
        },
      },
      {
        name: "a 'Now' pin (resurfaced) lands with no schedule, and a worker pass leaves it standing",
        seed: async (w) => {
          const id = await w.seedMail();
          // The leg's vacuity control: a live schedule that MUST flip while the pin stands.
          const other = await w.seedMail({ subject: "control" });
          const due = w.clock.now().getTime() + DAY;
          const set = await w.engine.mutate({
            kind: "triage_set", messageId: other, state: "bubbled_up", bubbleUpAt: iso(due),
          });
          expect(set.status).toBe("confirmed");
          return { id, other, due };
        },
        mutation: (_w, c) => ({ kind: "triage_set", messageId: c.id as string, state: "resurfaced" }),
        landed: (r, c) => {
          const st = stateOf(r, c.id as string);
          expect(st?.state).toBe("resurfaced");
          expect(st?.bubbleUpAt).toBeNull();
          expect(ohboxView(r).resurfaced.map((m) => m.id)).toContain(c.id as string);
        },
        optimistic: "landed",
        pass: {
          name: "bubbleUpPass",
          run: async (w, c) => {
            const { flipped } = await w.pass.bubbleUp(new Date((c.due as number) + 1_000));
            expect(flipped, "vacuity: the control schedule did not fire").toBe(1);
            // The runner re-asserts `landed`: the pin (bubbleUpAt NULL) was never a candidate.
          },
        },
      },
    ],
  },

  screener_decide: {
    coverage: "covered",
    scenarios: [
      {
        name: "a Yes files the sender's held mail in, promotes the rule — and the tidy pass leaves the decision alone",
        seed: async (w) => {
          const a = await w.seedHeld({ fromAddress: "lena@atelier.example", subject: "Werkstatt-Besuch?" });
          const b = await w.seedHeld({
            fromAddress: "lena@atelier.example", subject: "Nachtrag",
            date: new Date(Date.parse("2026-07-28T12:01:00.000Z")),
          });
          await w.seedHeaders(a, {});
          await w.seedHeaders(b, {});
          // The tidy leg's control: automated-shaped Ohbox mail under an inferred rule — demotes.
          await w.armOhboxTidy();
          await w.seedRule({ match: "news@shop.test", destination: "INBOX", provenance: "seeded-from-sent" });
          const control = await w.seedMail({ folder: "INBOX", fromAddress: "news@shop.test" });
          await w.seedHeaders(control, BULK);
          return { a, b, control };
        },
        // The representative IS the newest held message (the derived-Screener contract).
        mutation: (_w, c) => ({ kind: "screener_decide", senderId: c.b as string, decision: "yes" }),
        landed: (r, c) => {
          expect(msgOf(r, c.a as string)?.folder).toBe("INBOX");
          expect(msgOf(r, c.b as string)?.folder).toBe("INBOX");
          const rule = r.list<RuleDTO>("rule").find((x) => x.match === "lena@atelier.example");
          expect(rule).toMatchObject({ kind: "sender", destination: "INBOX", provenance: "promoted", enabled: true });
        },
        // Full-field parity (a review finding): the derived overlay paints the settled
        // meaning whole — folders AND the promoted rule — so `landed` reads the pure overlay.
        // The waiting segment's disappearance is DERIVED from these same folder moves.
        optimistic: "landed",
        pass: {
          name: "ohboxTidyPass",
          run: async (w, c) => {
            const r = await w.pass.ohboxTidy();
            expect(r.ran).toBe(true);
            expect(r.moved, "vacuity control did not demote").toBeGreaterThanOrEqual(1);
            await w.engine.syncOnce();
            expect(msgOf(w.store, c.control as string)?.folder).toBe("ohmail/News");
            // The decided-in mail is excluded by the decide's own change_log move-to-INBOX rows
            // (the pass's user-placement guard) — the runner re-asserts both rows stand in INBOX.
          },
        },
      },
      {
        name: "a No screens the sender out: held mail to ohmail/Screened, still unread, and a Screened rule",
        seed: async (w) => {
          const a = await w.seedHeld({ fromAddress: "paperbird@news.example", subject: "Issue 12" });
          const b = await w.seedHeld({
            fromAddress: "paperbird@news.example", subject: "Issue 13",
            date: new Date(Date.parse("2026-07-28T12:02:00.000Z")),
          });
          return { a, b };
        },
        mutation: (_w, c) => ({ kind: "screener_decide", senderId: c.b as string, decision: "no" }),
        landed: (r, c) => {
          for (const id of [c.a as string, c.b as string]) {
            const m = msgOf(r, id);
            expect(m?.folder).toBe("ohmail/Screened");
            // A letter is read when the person read it: filing it out marks nothing, overlay and server alike.
            expect(m?.unread, "the screen-out marked a letter read").toBe(true);
            expect(m?.lastReadAt ?? null).toBeNull();
          }
          const rule = r.list<RuleDTO>("rule").find((x) => x.match === "paperbird@news.example");
          expect(rule?.destination).toBe("ohmail/Screened");
        },
        // Full-field parity, read state included: neither the overlay nor the server marks the letters read.
        optimistic: "landed",
        pass: {
          name: "every pass this world drives",
          // The runner re-asserts `landed` afterwards: no worker pass reads screened-out mail either.
          run: runEveryPass,
        },
      },
      {
        // THE NON-DEFAULT DESTINATION (a review finding): `dest` is a VIEW on the mutation
        // and a FOLDER on the wire (FOLDER_OF_VIEW in http-adapter.ts) — the translation whose
        // absence once made three of the five Screener buttons decoration (types.ts, the
        // screener_decide contract). If the adapter drops it, the server's two-folder default
        // answers INBOX and this scenario reddens at leg (a).
        name: "a Yes to READS files the held mail there, and the rule points there",
        seed: async (w) => {
          const a = await w.seedHeld({ fromAddress: "zine@letters.example", subject: "No. 7" });
          const b = await w.seedHeld({
            fromAddress: "zine@letters.example", subject: "No. 8",
            date: new Date(Date.parse("2026-07-28T12:03:00.000Z")),
          });
          return { a, b };
        },
        // NOTE the deliberate absence of `read`: "&read" is NOT a field on `POST /screener/:id`
        // — the seen half is a SEPARATE `mark_seen` the surface composes beside the decide
        // (`derivedScreenerEffects` refuses the flip for exactly this wire-parity reason, and
        // `screener-state.ts` documents the composition). The flag on the mutation type is
        // fixture-only vocabulary; the read half of "file & read" is covered by the mark_seen
        // scenarios, over the wire that actually carries it.
        mutation: (_w, c) => ({
          kind: "screener_decide", senderId: c.b as string, decision: "yes", dest: "reads",
        }),
        landed: (r, c) => {
          for (const id of [c.a as string, c.b as string]) {
            expect(msgOf(r, id)?.folder, "the dest translation was dropped — the two-folder default answered")
              .toBe("ohmail/News");
          }
          const rule = r.list<RuleDTO>("rule").find((x) => x.match === "zine@letters.example");
          expect(rule).toMatchObject({ destination: "ohmail/News", provenance: "promoted", enabled: true });
        },
        // Full-field parity: overlay folder + rule destination are the settled meaning (the
        // allow side flips no read state, and neither does the wire — see the seed's note).
        optimistic: "landed",
        pass: {
          none: "the dest translation is the wire branch under test and the decide files in its " +
            "own transaction; the worker interactions for a decided sender are driven by the " +
            "default-admission scenario's ohboxTidyPass leg above",
        },
      },
      {
        // The rejection side of the same branch: a spam verdict FROM THE GATE — `dest: "spam"`
        // is a deny-side folder, so the server accepts it on a 'no' and refuses it on a 'yes'
        // (screener-service.ts, the two-refusal dest check).
        name: "a No to SPAM quarantines the held mail and the rule points at the spam pile",
        seed: async (w) => {
          const a = await w.seedHeld({ fromAddress: "blast@promo.example", subject: "WIN NOW" });
          return { a };
        },
        mutation: (_w, c) => ({
          kind: "screener_decide", senderId: c.a as string, decision: "no", dest: "spam",
        }),
        landed: (r, c) => {
          const m = msgOf(r, c.a as string);
          expect(m?.folder).toBe("ohmail/Quarantine");
          expect(m?.unread, "the spam press marked a letter read").toBe(true);
          expect(m?.lastReadAt ?? null).toBeNull();
          const rule = r.list<RuleDTO>("rule").find((x) => x.match === "blast@promo.example");
          expect(rule?.destination).toBe("ohmail/Quarantine");
        },
        // Full-field parity, deny side: quarantine, the read state left as it was, and the rule
        // destination, all read off the pure overlay.
        optimistic: "landed",
        pass: {
          none: "same transaction-filing argument as the screen-out scenario above; the physical " +
            "ride to native Junk is the reconciler's, owned by junk-filing's own guard suite",
        },
      },
      {
        // THE WIDENED VERB (item 3, 0.20): a decision is about the SENDER and applies
        // ACCOUNT-WIDE. The sender's mail is held in TWO mailboxes of one account; the press
        // names the second mailbox's representative and the FIRST mailbox's row must land in
        // INBOX too — the optimistic claim always covered it (`derivedScreenerEffects` is
        // senderKey-filtered, mailbox-blind), so before the server widened, this exact leg was
        // the parity break behind "my decision came back". Mutation watched red: restore the
        // mailbox filter on the held-bag read (`heldRowsForSender(…, mailboxId)`) and leg (a)
        // reddens on `c.a` staying held.
        name: "a Yes on a two-mailbox account files the sender's held mail in BOTH mailboxes",
        seed: async (w) => {
          const a = await w.seedHeld({ fromAddress: "post@twohomes.example", subject: "Erste" });
          // Pre-minted id, no `.returning()`: the typecheck-test-dirs pass resolves drizzle
          // through a config where this builder's returning() takes no fields object.
          const mb2 = randomUUID();
          await w.db.insert(mailboxes).values({
            id: mb2, accountId: w.accountId, provider: "imap",
            address: `second-${randomUUID().slice(0, 8)}@example.test`,
          });
          const m2 = await seedScreenerHeld(w.db, {
            accountId: w.accountId, mailboxId: mb2,
            fromAddress: "post@twohomes.example", subject: "Zweite",
            date: new Date(Date.parse("2026-07-28T12:04:00.000Z")),
          });
          await w.emit(m2.id, true);
          await w.engine.syncOnce();
          return { a, b: m2.id };
        },
        mutation: (_w, c) => ({ kind: "screener_decide", senderId: c.b as string, decision: "yes" }),
        landed: (r, c) => {
          expect(msgOf(r, c.b as string)?.folder).toBe("INBOX");
          expect(msgOf(r, c.a as string)?.folder, "the FIRST mailbox's held row stayed at the gate — the decision is mailbox-scoped again")
            .toBe("INBOX");
          const rule = r.list<RuleDTO>("rule").find((x) => x.match === "post@twohomes.example");
          expect(rule).toMatchObject({ kind: "sender", destination: "INBOX", provenance: "promoted", enabled: true });
        },
        optimistic: "landed",
        pass: {
          none: "the account-wide filing happens inside the decide's own transaction (per-mailbox " +
            "FOR SHARE role locks in applyScreenerDecision); the request road for mailboxes this " +
            "install cannot write is pg-tested in screener-decide-scope.pg.test.ts, and rule-retro " +
            "stays the backstop, pinned idempotent there",
        },
      },
    ],
  },

  // ── the read-state verbs ──────────────────────────────────────────────────────────────────

  mark_seen: {
    coverage: "covered",
    scenarios: [
      {
        name: "a deliberate read lands (unread false, lastReadAt stamped) and sticks",
        seed: async (w) => ({ id: await w.seedMail() }),
        mutation: (_w, c) => ({ kind: "mark_seen", messageIds: [c.id as string], unread: false }),
        landed: (r, c) => {
          const m = msgOf(r, c.id as string);
          expect(m?.unread).toBe(false);
          expect(m?.lastReadAt).toBeTruthy();
        },
        optimistic: "landed",
        pass: {
          none: "the physical \\Seen is reconcileFlags' (IMAP, under the lease; external " +
            "observations are refused while our write is pending — drizzle-repo.ts's user-wins " +
            "guard, pg-tested); the passes that CAN touch read state are driven by the glance " +
            "and unread scenarios beside this one",
        },
      },
      {
        // ═══ THE HISTORICAL REGRESSION, AS A STANDING RED LINE ═══════════════════════════
        // Owner report 2026-08-26: "a resurfaced message … turns back to unread". Two halves:
        // the engine FILTERED pinned ids out of a glance (`withoutPins`), so the wire never
        // marked them and the next drain reverted the row; and the flip forged unread=true.
        // Re-adding either half turns this scenario red at leg (a)/(b)/(c) — proven by
        // mutation when the harness landed.
        name: "a glance on a PINNED row: the read lands, the pin stands, and the due-flip forges no unread",
        seed: async (w) => {
          const id = await w.seedMail();
          const pin = await w.engine.mutate({ kind: "triage_set", messageId: id, state: "resurfaced" });
          expect(pin.status).toBe("confirmed");
          // The pass leg's control: a live schedule that must fire while the read stands. READ
          // deliberately — the pre-ruling arm forged `unread: true` on the flip, so a read
          // control is what turns that arm's return into a red test instead of a coincidence.
          const other = await w.seedMail({ subject: "control", unread: false });
          const due = w.clock.now().getTime() + DAY;
          const set = await w.engine.mutate({
            kind: "triage_set", messageId: other, state: "bubbled_up", bubbleUpAt: iso(due),
          });
          expect(set.status).toBe("confirmed");
          return { id, other, due };
        },
        mutation: (_w, c) => ({
          kind: "mark_seen", messageIds: [c.id as string], unread: false, via: "glance",
        }),
        landed: (r, c) => {
          const m = msgOf(r, c.id as string);
          expect(m?.unread, "the glance-read reverted — the pinned-id drop is back").toBe(false);
          // …and the pin was NOT spent: a glance reads without answering the resurface.
          expect(m?.triage?.state).toBe("resurfaced");
          expect(stateOf(r, c.id as string)?.state).toBe("resurfaced");
        },
        optimistic: "landed",
        pass: {
          name: "bubbleUpPass",
          run: async (w, c) => {
            const { flipped } = await w.pass.bubbleUp(new Date((c.due as number) + 1_000));
            expect(flipped, "vacuity: the control schedule did not fire").toBe(1);
            await w.engine.syncOnce();
            // The control resurfaced and STAYED READ — the 2026-08-26 ruling: no artificial
            // unread anywhere; a pin arrives wearing its genuine read state.
            const control = msgOf(w.store, c.other as string);
            expect(control?.triage?.state).toBe("resurfaced");
            expect(control?.unread, "the flip forged an artificial unread — the removed arm is back").toBe(false);
            // The runner re-asserts `landed`: the glanced pin is still read AND still pinned.
          },
        },
      },
      {
        name: "a deliberate read on a pinned row SPENDS the pin (glance's exact complement)",
        seed: async (w) => {
          const id = await w.seedMail();
          const pin = await w.engine.mutate({ kind: "triage_set", messageId: id, state: "resurfaced" });
          expect(pin.status).toBe("confirmed");
          return { id };
        },
        mutation: (_w, c) => ({ kind: "mark_seen", messageIds: [c.id as string], unread: false }),
        landed: (r, c) => {
          expect(msgOf(r, c.id as string)?.unread).toBe(false);
          expect(ohboxView(r).resurfaced.map((m) => m.id)).not.toContain(c.id as string);
          expect(stateOf(r, c.id as string)?.state).toBe("none");
        },
        optimistic: "landed",
        pass: {
          none: "the pin-spend is the decide transaction's own write; the glance scenario beside " +
            "this one drives the worker interaction for pinned read state",
        },
      },
      {
        name: "mark unread lands, and no worker pass reads the letter back",
        seed: async (w) => {
          const id = await w.seedMail({ unread: false }); // genuinely read first
          return { id };
        },
        mutation: (_w, c) => ({ kind: "mark_seen", messageIds: [c.id as string], unread: true }),
        landed: (r, c) => {
          const m = msgOf(r, c.id as string);
          expect(m?.unread).toBe(true);
          expect(m?.lastReadAt ?? null, "marking unread must clear the reading stamp").toBeNull();
        },
        optimistic: "landed",
        pass: {
          name: "every pass this world drives",
          // The runner re-asserts `landed` afterwards: the letter is still unread.
          run: runEveryPass,
        },
      },
    ],
  },

  feed_mark_seen: {
    coverage: "covered",
    scenarios: [
      {
        name: "the Reads sweep flips the stream read on the server and moves only its own waterline",
        seed: async (w) => {
          const a = await w.seedMail({ folder: "ohmail/News", subject: "older" });
          const b = await w.seedMail({ folder: "ohmail/News", subject: "newest" });
          return { a, b };
        },
        mutation: (_w, c) => ({ kind: "feed_mark_seen", view: "reads", upToId: c.b as string }),
        landed: (r, c) => {
          expect(msgOf(r, c.a as string)?.unread).toBe(false);
          expect(msgOf(r, c.b as string)?.unread).toBe(false);
        },
        local: (w, c) => {
          // The waterline is CLIENT state (`/sync` has no view_meta entity) — asserted on the
          // live engine only; a fresh mirror rightly knows nothing of it.
          const line = w.engine.read().get<WaterlineMeta>("view_meta", "reads_waterline");
          expect(line?.newestSeenId).toBe(c.b as string);
        },
        optimistic: "landed",
        pass: {
          none: "the sweep's flips are per-message PATCHes whose desired-\\Seen intent the IMAP " +
            "reconciler executes under the lease (reconcileFlags — out of an in-process world); " +
            "the unread mirror those PATCHes commit is the server truth pinned here",
        },
      },
    ],
  },

  // ── the tag verbs (database rows, never IMAP facts) ──────────────────────────────────────

  tag_assign: {
    coverage: "covered",
    scenarios: [
      {
        name: "tag-or-create assigns under the client-minted id",
        seed: async (w) => ({ id: await w.seedMail(), tagId: randomUUID() }),
        mutation: (_w, c) => ({
          kind: "tag_assign", messageId: c.id as string, tagId: c.tagId as string,
          assigned: true, createName: "Projekt",
        }),
        landed: (r, c) => {
          expect(msgOf(r, c.id as string)?.labels).toContain(c.tagId as string);
          expect(r.get<TagDTO>("tag", c.tagId as string)?.name).toBe("Projekt");
        },
        // The chip is instant; the created tag ROW is deliberately confirm-time (tag-or-create
        // mints it server-side under the client's id), so only the labels are optimistic.
        optimistic: (r, c) => {
          expect(msgOf(r, c.id as string)?.labels).toContain(c.tagId as string);
        },
        pass: { none: "no worker pass reads or writes tags or message_tags — tags are our rows, never mailbox facts" },
      },
      {
        name: "un-assign takes the chip off and it stays off",
        seed: async (w) => {
          const id = await w.seedMail();
          const tagId = randomUUID();
          const on = await w.engine.mutate({
            kind: "tag_assign", messageId: id, tagId, assigned: true, createName: "Ablage",
          });
          expect(on.status).toBe("confirmed");
          return { id, tagId };
        },
        mutation: (_w, c) => ({
          kind: "tag_assign", messageId: c.id as string, tagId: c.tagId as string, assigned: false,
        }),
        landed: (r, c) => {
          expect(msgOf(r, c.id as string)?.labels).not.toContain(c.tagId as string);
        },
        optimistic: "landed",
        pass: { none: "no worker pass reads or writes tags or message_tags — tags are our rows, never mailbox facts" },
      },
    ],
  },

  tag_create: {
    coverage: "covered",
    scenarios: [
      {
        name: "a standalone create lands under the SERVER-minted id",
        seed: async () => ({}),
        mutation: () => ({ kind: "tag_create", tagId: randomUUID(), name: "Reisen" }),
        landed: (r) => {
          const tag = tagByName(r, "Reisen");
          expect(tag).toBeDefined();
          expect(tag?.hue).toBe("moss");
        },
        optimistic: "landed",
        pass: { none: "no worker pass reads or writes tags or message_tags — tags are our rows, never mailbox facts" },
      },
    ],
  },

  tag_rename: {
    coverage: "covered",
    scenarios: [
      {
        name: "a rename lands on the row the mirror already holds",
        seed: async (w) => {
          const made = await w.engine.mutate({ kind: "tag_create", tagId: randomUUID(), name: "Alt" });
          expect(made.status).toBe("confirmed");
          const server = tagByName(w.store, "Alt");
          expect(server).toBeDefined();
          return { tagId: server!.id };
        },
        mutation: (_w, c) => ({ kind: "tag_rename", tagId: c.tagId as string, name: "Neu" }),
        landed: (r, c) => {
          expect(r.get<TagDTO>("tag", c.tagId as string)?.name).toBe("Neu");
        },
        optimistic: "landed",
        pass: { none: "no worker pass reads or writes tags or message_tags — tags are our rows, never mailbox facts" },
      },
    ],
  },

  tag_recolor: {
    coverage: "covered",
    scenarios: [
      {
        name: "a recolour lands hue-only",
        seed: async (w) => {
          const made = await w.engine.mutate({ kind: "tag_create", tagId: randomUUID(), name: "Farbe" });
          expect(made.status).toBe("confirmed");
          const server = tagByName(w.store, "Farbe");
          return { tagId: server!.id };
        },
        mutation: (_w, c) => ({ kind: "tag_recolor", tagId: c.tagId as string, hue: "ochre" }),
        landed: (r, c) => {
          const tag = r.get<TagDTO>("tag", c.tagId as string);
          expect(tag?.hue).toBe("ochre");
          expect(tag?.name, "the recolour must not touch the name").toBe("Farbe");
        },
        optimistic: "landed",
        pass: { none: "no worker pass reads or writes tags or message_tags — tags are our rows, never mailbox facts" },
      },
    ],
  },

  tag_delete: {
    coverage: "covered",
    scenarios: [
      {
        name: "a delete takes the tag AND its chips off every message, permanently",
        seed: async (w) => {
          const id = await w.seedMail();
          const tagId = randomUUID();
          const on = await w.engine.mutate({
            kind: "tag_assign", messageId: id, tagId, assigned: true, createName: "Weg damit",
          });
          expect(on.status).toBe("confirmed");
          return { id, tagId };
        },
        mutation: (_w, c) => ({ kind: "tag_delete", tagId: c.tagId as string }),
        landed: (r, c) => {
          expect(r.get<TagDTO>("tag", c.tagId as string)).toBeUndefined();
          expect(msgOf(r, c.id as string)?.labels, "a chip survived its tag's deletion").not.toContain(c.tagId as string);
        },
        optimistic: "landed",
        pass: { none: "no worker pass reads or writes tags or message_tags — tags are our rows, never mailbox facts" },
      },
    ],
  },

  // ── the folder verbs (real IMAP commands — pending markers, never pretended completion) ──

  folder_create: {
    coverage: "covered",
    scenarios: [
      {
        name: "a create records the command: the row exists wearing its pending marker",
        seed: async (w) => {
          await w.enableFolders();
          return {};
        },
        mutation: (w) => ({
          kind: "folder_create", folderId: randomUUID(), mailboxId: w.mailboxId, name: "Projects/Acme",
        }),
        landed: (r) => {
          const f = folderByName(r, "Projects/Acme");
          expect(f).toBeDefined();
          // Honestly PENDING: no worker exists in this world, so a settled row here would mean
          // the API pretended an IMAP CREATE it never performed.
          expect(f?.op?.kind).toBe("create");
        },
        optimistic: "landed",
        pass: {
          none: "the executing half (folder-ops on the worker, under the mailbox lease, against " +
            "real IMAP) is out of an in-process world — apps/worker/test/folder-ops.test.ts and " +
            "folder-rename-swap.pg.test.ts own execution; what the API RECORDS is pinned here",
        },
      },
    ],
  },

  folder_rename: {
    coverage: "covered",
    scenarios: [
      {
        name: "a rename records the target and keeps the mailbox's name until the worker lands the swap",
        seed: async (w) => {
          await w.enableFolders();
          return { folderId: await w.seedSettledFolder("Projects") };
        },
        mutation: (_w, c) => ({ kind: "folder_rename", folderId: c.folderId as string, name: "Projekte" }),
        landed: (r, c) => {
          const f = r.get<FolderEntity>("folder", c.folderId as string);
          expect(f?.name, "the optimistic swap leaked into the server row").toBe("Projects");
          expect(f?.op).toMatchObject({ kind: "rename", to: "Projekte" });
        },
        optimistic: "landed",
        pass: {
          none: "executing half out of an in-process world (see folder_create); the recorded " +
            "command + unchanged name IS the server truth until the worker's transaction swaps both",
        },
      },
    ],
  },

  folder_delete: {
    coverage: "covered",
    scenarios: [
      {
        name: "a delete records the ceremony: the row persists wearing op:delete until the tombstones",
        seed: async (w) => {
          await w.enableFolders();
          return { folderId: await w.seedSettledFolder("Altes") };
        },
        mutation: (_w, c) => ({ kind: "folder_delete", folderId: c.folderId as string }),
        landed: (r, c) => {
          const f = r.get<FolderEntity>("folder", c.folderId as string);
          expect(f, "the row vanished before the worker confirmed anything").toBeDefined();
          expect(f?.op?.kind).toBe("delete");
        },
        optimistic: "landed",
        pass: { none: "executing half out of an in-process world (see folder_create)" },
      },
    ],
  },

  folder_op_dismiss: {
    coverage: "covered",
    scenarios: [
      {
        name: "dismissing a FAILED create takes its never-created row with it",
        seed: async (w) => {
          await w.enableFolders();
          // The refusal, in the exact shape enqueue + a failed execution leave behind: the
          // inventory row exists from the enqueue, the command row sits `failed` with a closed
          // code, and a `folder` change announces the marker to every mirror.
          const folderId = await w.seedSettledFolder("Kaputt");
          await w.db.insert(folderOps).values({
            accountId: w.accountId, mailboxId: w.mailboxId, folderId,
            op: "create", toFolder: null, status: "failed", error: "folder_exists",
          });
          await w.db.transaction(async (tx) => {
            await recordChange(tx as unknown as Tx, {
              accountId: w.accountId, entityType: "folder", entityId: folderId, op: "update", meta: null,
            });
          });
          return { folderId };
        },
        mutation: (_w, c) => ({ kind: "folder_op_dismiss", folderId: c.folderId as string }),
        landed: (r, c) => {
          expect(r.get<FolderEntity>("folder", c.folderId as string)).toBeUndefined();
          expect(folderByName(r, "Kaputt")).toBeUndefined();
        },
        optimistic: "landed",
        pass: { none: "the dismiss is the API's own transaction; nothing downstream touches a dismissed command" },
      },
    ],
  },

  // ── the send + draft verbs ────────────────────────────────────────────────────────────────

  mail_send: {
    coverage: "covered",
    scenarios: [
      {
        name: "a compose send: exactly one delivery, and the draft row lands 'sent'",
        seed: async () => ({}),
        mutation: (w) => ({
          kind: "mail_send", inReplyTo: null, mailboxId: w.mailboxId,
          subject: "Parity compose", body: "Hallo aus dem Harness.",
          to: [{ name: null, address: "you@example.com" }],
        }),
        landed: (r, _c, w) => {
          const d = r.list<EngineDraft>("draft").find((x) => x.subject === "Parity compose");
          expect(d?.status).toBe("sent");
          expect(w.send.calls, "one press must be one delivery").toBe(1);
        },
        // The mutate-time claim is a `sending` draft and nothing else — nothing optimistic may
        // assert a delivery that has not been confirmed (types.ts, the mail_send contract).
        optimistic: (r) => {
          const d = r.list<EngineDraft>("draft").find((x) => x.subject === "Parity compose");
          expect(d?.status).toBe("sending");
        },
        pass: {
          none: "SMTP is the transport seam, faked here exactly as every suite fakes it (the suite " +
            "makes zero external requests); one-press-one-delivery under retry/crash is the send " +
            "machine's own pinned suite (drafts-send.test.ts, send-service tests) — what parity " +
            "adds is the row's fate through the engine's own wire, asserted on all three legs",
        },
      },
      {
        name: "send-later lands as an appointment, and the sender clock fires it exactly once",
        seed: async (w) => ({ at: w.clock.now().getTime() + HOUR }),
        mutation: (w, c) => ({
          kind: "mail_send", inReplyTo: null, mailboxId: w.mailboxId,
          subject: "Parity later", body: "Später.",
          to: [{ name: null, address: "you@example.com" }],
          sendAt: iso(c.at as number),
        }),
        landed: (r, c) => {
          const d = r.list<EngineDraft>("draft").find((x) => x.subject === "Parity later");
          expect(d?.status).toBe("scheduled");
          expect(new Date(d?.sendAt ?? 0).getTime()).toBe(c.at as number);
        },
        // The mutate-time effect for a send-later IS the settled meaning: `scheduled` with the
        // picked instant (mutations.ts paints exactly that), so `landed` reads both halves.
        optimistic: "landed",
        pass: {
          name: "runScheduledSendPass",
          run: async (w, c) => {
            const r = await w.pass.scheduledSend(new Date((c.at as number) + 60_000));
            expect(r).toMatchObject({ claimed: 1, sent: 1 });
            expect(w.send.calls).toBe(1);
            // Idempotence: a second clock tick re-sends nothing.
            const again = await w.pass.scheduledSend(new Date((c.at as number) + 120_000));
            expect(again.claimed).toBe(0);
            expect(w.send.calls).toBe(1);
          },
        },
        // The firing IS the verb's intent: the appointment left, once, at its time.
        landedAfterPass: (r) => {
          const d = r.list<EngineDraft>("draft").find((x) => x.subject === "Parity later");
          expect(d?.status).toBe("sent");
        },
      },
    ],
  },

  draft_save: {
    coverage: "covered",
    scenarios: [
      {
        name: "a create lands under the server's id (the id the surface must adopt)",
        seed: async () => ({}),
        mutation: (w) => ({
          kind: "draft_save", draftId: null, mailboxId: w.mailboxId,
          subject: "Entwurf", body: "erste Zeile", to: [], cc: [], bcc: [],
        }),
        landed: (r, _c, _w, res) => {
          expect(res.entityId, "no server id came back — autosave cannot adopt the row").toBeTruthy();
          const d = r.get<EngineDraft>("draft", res.entityId!);
          expect(d?.subject).toBe("Entwurf");
          expect(d?.status).toBe("draft");
        },
        optimistic: (r) => {
          const d = r.list<EngineDraft>("draft").find((x) => x.subject === "Entwurf");
          expect(d?.status).toBe("draft");
        },
        pass: {
          none: "no standing pass touches a row below 'scheduled' — the sender clock selects " +
            "only due appointments, driven at the send-later and cancel scenarios",
        },
      },
      {
        name: "an update lands on THAT row (one draft from first keystroke to delivery)",
        seed: async (w) => {
          const made = await w.engine.mutate({
            kind: "draft_save", draftId: null, mailboxId: w.mailboxId,
            subject: "Entwurf", body: "v1", to: [], cc: [], bcc: [],
          });
          expect(made.status).toBe("confirmed");
          return { draftId: made.entityId! };
        },
        mutation: (w, c) => ({
          kind: "draft_save", draftId: c.draftId as string, mailboxId: w.mailboxId,
          subject: "Entwurf v2", body: "zweite Zeile", to: [], cc: [], bcc: [],
        }),
        landed: (r, c) => {
          const d = r.get<EngineDraft>("draft", c.draftId as string);
          expect(d?.subject).toBe("Entwurf v2");
          expect(d?.body).toBe("zweite Zeile");
        },
        optimistic: "landed",
        pass: { none: "no standing pass touches a row below 'scheduled' (see the create scenario)" },
      },
    ],
  },

  draft_discard: {
    coverage: "covered",
    scenarios: [
      {
        name: "a discard tombstones the row on every reader — including a fresh bootstrap",
        seed: async (w) => {
          const made = await w.engine.mutate({
            kind: "draft_save", draftId: null, mailboxId: w.mailboxId,
            subject: "Wegwerfen", body: "x", to: [], cc: [], bcc: [],
          });
          expect(made.status).toBe("confirmed");
          return { draftId: made.entityId! };
        },
        mutation: (_w, c) => ({ kind: "draft_discard", draftId: c.draftId as string }),
        landed: (r, c) => {
          expect(r.get<EngineDraft>("draft", c.draftId as string)).toBeUndefined();
        },
        optimistic: "landed",
        pass: { none: "a deleted row has no downstream — the drafts table is ours alone" },
      },
    ],
  },

  draft_schedule_cancel: {
    coverage: "covered",
    scenarios: [
      {
        name: "a cancel returns the row to 'draft' — and the sender clock then sends NOTHING for it",
        seed: async (w) => {
          const at = w.clock.now().getTime() + HOUR;
          const mk = async (subject: string): Promise<string> => {
            const made = await w.engine.mutate({
              kind: "draft_save", draftId: null, mailboxId: w.mailboxId,
              subject, body: "geplant", to: [{ name: null, address: "you@example.com" }], cc: [], bcc: [],
            });
            expect(made.status).toBe("confirmed");
            const sched = await w.engine.mutate({
              kind: "mail_send", inReplyTo: null, draftId: made.entityId!, mailboxId: w.mailboxId,
              subject, body: "geplant", to: [{ name: null, address: "you@example.com" }],
              sendAt: iso(at),
            });
            expect(sched.status).toBe("confirmed");
            return made.entityId!;
          };
          // The appointment the user cancels, and a CONTROL appointment that must still fire —
          // without it, "nothing sent" is indistinguishable from "the clock never ran".
          const cancelled = await mk("Storniert");
          const control = await mk("Kontrolle");
          return { cancelled, control, at };
        },
        mutation: (_w, c) => ({ kind: "draft_schedule_cancel", draftId: c.cancelled as string }),
        landed: (r, c) => {
          const d = r.get<EngineDraft>("draft", c.cancelled as string);
          expect(d?.status).toBe("draft");
          expect(d?.sendAt ?? null).toBeNull();
        },
        optimistic: "landed",
        pass: {
          name: "runScheduledSendPass",
          run: async (w, c) => {
            const r = await w.pass.scheduledSend(new Date((c.at as number) + 60_000));
            expect(r).toMatchObject({ claimed: 1, sent: 1 });
            expect(w.send.calls, "the cancelled appointment was delivered anyway").toBe(1);
            expect(w.send.delivered[0]?.subject).toBe("Kontrolle");
            await w.engine.syncOnce();
            expect(w.store.get<EngineDraft>("draft", c.control as string)?.status).toBe("sent");
            // The runner re-asserts `landed`: the cancelled row is still an ordinary draft.
          },
        },
      },
    ],
  },

  /**
   * A PERSON ANSWERS FOR A SEND NOBODY COULD CONFIRM — the one sanctioned exit from the hold.
   *
   * Both outcomes are here because they are different verbs in everything but name: `arrived` is
   * testimony that the message is in the recipient's hands, and it settles the ledger row at `sent`
   * while the draft leaves the list; `not_arrived` says the attempt is definitively over, and it
   * settles the row at `failed` while the draft becomes ORDINARY AGAIN — editable, and discardable,
   * which is the whole defect this migration closes. A scenario that exercised one of them would
   * leave the other's write unmeasured on every reader.
   *
   * `resolved_by` is asserted with the status on both arms. It is the column that tells a later
   * reader testimony from evidence — a send the reconciler finalized and one a person resolved by
   * looking in their Sent folder both end at `sent` — so a resolution that moved the status and not
   * the attribution would be the same row with its provenance lost.
   *
   * The precondition is produced by `seedUnverifiedSend`, which drives `draft_save` then a
   * `mail_send` the transport makes ambiguous, and asserts BY NAME that the row landed `unverified`
   * before handing it over. A hand-written ledger row would have measured the fixture.
   */
  draft_resolve: {
    coverage: "covered",
    scenarios: [
      {
        name: "\"it arrived\": the ledger row settles as sent, attributed to a person, and the draft leaves the list",
        seed: async (w) => w.seedUnverifiedSend({ subject: "Angekommen?" }),
        mutation: (_w, c) => ({
          kind: "draft_resolve", draftId: c.draftId as string, outcome: "arrived",
        }),
        landed: async (r, c, w) => {
          const d = r.get<EngineDraft>("draft", c.draftId as string);
          expect(d?.status, "the resolved row still reads as held").toBe("sent");
          expect(d?.sendError ?? null, "the hold's sentence outlived the answer to it").toBeNull();
          const rows = (await w.db.select().from(outboundSends))
            .filter((x) => x.draftId === (c.draftId as string));
          expect(rows, "the record of the attempt did not survive the resolution").toHaveLength(1);
          expect(rows[0]!.status, "the ledger row was not settled").toBe("sent");
          expect(rows[0]!.resolvedBy,
            "the status moved without the attribution — a reader can no longer tell this person's "
            + "testimony from the reconciler's own evidence").toBe("person");
          expect(rows[0]!.resolvedAt, "resolved without a time").not.toBeNull();
        },
        /* The overlay's claim is the DRAFT's fate and nothing else: at mutate time the server has
           settled nothing, so `landed`'s ledger half would be asserting the future. */
        optimistic: (r, c) => {
          const d = r.get<EngineDraft>("draft", c.draftId as string);
          expect(d?.status).toBe("sent");
        },
        pass: {
          none: "both outcomes are TERMINAL. The only standing pass over this table is the "
            + "stranded-reservation reconciler, which claims `pending` and `unverified` rows and "
            + "reaches them through `INNER JOIN drafts` — a `sent` or `failed` row is outside its "
            + "predicate by construction, and there is nothing on schedule that transforms a "
            + "resolution. The verb's own drain is legs (a)-(c) above.",
        },
      },
      {
        name: "\"it didn't arrive\": the ledger row settles as failed and the draft is an ordinary draft again",
        seed: async (w) => w.seedUnverifiedSend({ subject: "Nicht angekommen?" }),
        mutation: (_w, c) => ({
          kind: "draft_resolve", draftId: c.draftId as string, outcome: "not_arrived",
        }),
        landed: async (r, c, w) => {
          const d = r.get<EngineDraft>("draft", c.draftId as string);
          expect(d?.status, "the row did not come back as an ordinary draft, so Discard still refuses")
            .toBe("draft");
          expect(d?.sendError ?? null, "the failed attempt's sentence is still on the row").toBeNull();
          const rows = (await w.db.select().from(outboundSends))
            .filter((x) => x.draftId === (c.draftId as string));
          expect(rows, "the record of the attempt did not survive the resolution").toHaveLength(1);
          expect(rows[0]!.status, "a definitively-over attempt is still on record as ambiguous")
            .toBe("failed");
          expect(rows[0]!.resolvedBy, "the status moved without the attribution").toBe("person");
          expect(rows[0]!.resolvedAt, "resolved without a time").not.toBeNull();
        },
        optimistic: (r, c) => {
          const d = r.get<EngineDraft>("draft", c.draftId as string);
          expect(d?.status).toBe("draft");
        },
        pass: {
          none: "both outcomes are TERMINAL. The only standing pass over this table is the "
            + "stranded-reservation reconciler, which claims `pending` and `unverified` rows and "
            + "reaches them through `INNER JOIN drafts` — a `sent` or `failed` row is outside its "
            + "predicate by construction, and there is nothing on schedule that transforms a "
            + "resolution. The verb's own drain is legs (a)-(c) above.",
        },
      },
    ],
  },

  draft_accept: {
    coverage: {
      out: "a pure client-side editor action — it moves an AI draft into the editor and touches " +
        "no server state; the adapter throws UnsupportedMutationError BY DESIGN " +
        "(http-adapter.ts), so there is no server effect to land, survive a drain, or defend " +
        "from a worker pass. Its local semantics are pinned in optimistic/send-staging suites.",
    },
    scenarios: [],
  },

  // ── the rule verbs ────────────────────────────────────────────────────────────────────────

  rule_delete: {
    coverage: "covered",
    scenarios: [
      {
        name: "a revoke lands — and kills its own still-owed retro before the pass can file anything",
        seed: async (w) => {
          const oldMail = await w.seedMail({ fromAddress: "gone@example.org", subject: "altes Mail" });
          await w.seedHeaders(oldMail, {});
          const made = await w.engine.mutate({
            kind: "rule_create", ruleKind: "sender", match: "gone@example.org",
            destination: "ohmail/News", applyRetro: true,
          });
          expect(made.status).toBe("confirmed");
          const rule = w.store.list<RuleDTO>("rule").find((x) => x.match === "gone@example.org");
          // The control: a SECOND owed retro that must still run, or "the pass moved nothing"
          // would also pass on a pass that never ran.
          const controlMail = await w.seedMail({ fromAddress: "stays@example.org", subject: "control" });
          await w.seedHeaders(controlMail, {});
          const control = await w.engine.mutate({
            kind: "rule_create", ruleKind: "sender", match: "stays@example.org",
            destination: "ohmail/News", applyRetro: true,
          });
          expect(control.status).toBe("confirmed");
          return { ruleId: rule!.id, oldMail, controlMail };
        },
        mutation: (_w, c) => ({ kind: "rule_delete", ruleId: c.ruleId as string }),
        landed: (r, c) => {
          expect(r.get<RuleDTO>("rule", c.ruleId as string)).toBeUndefined();
          expect(msgOf(r, c.oldMail as string)?.folder, "the revoked rule's retro filed mail anyway").toBe("INBOX");
        },
        optimistic: "landed",
        pass: {
          name: "ruleRetroPass",
          run: async (w, c) => {
            const r = await w.pass.ruleRetro();
            expect(r.moved, "vacuity: the surviving rule's retro moved nothing").toBeGreaterThanOrEqual(1);
            await w.engine.syncOnce();
            expect(msgOf(w.store, c.controlMail as string)?.folder).toBe("ohmail/News");
            // The runner re-asserts `landed`: the revoked rule stays gone, its backlog unmoved —
            // the owed set is defined on LIVING rules, so the user's revoke wins over the queue.
          },
        },
      },
    ],
  },

  rule_update: {
    coverage: "covered",
    scenarios: [
      {
        name: "a destination change lands on the row and moves no stored mail",
        seed: async (w) => {
          const oldMail = await w.seedMail({ fromAddress: "sender@corp.example" });
          await w.seedHeaders(oldMail, {});
          const made = await w.engine.mutate({
            kind: "rule_create", ruleKind: "sender", match: "sender@corp.example",
            destination: "ohmail/News", applyRetro: false,
          });
          expect(made.status).toBe("confirmed");
          const rule = w.store.list<RuleDTO>("rule").find((x) => x.match === "sender@corp.example");
          return { ruleId: rule!.id, oldMail };
        },
        mutation: (_w, c) => ({ kind: "rule_update", ruleId: c.ruleId as string, destination: "ohmail/Receipts" }),
        landed: (r, c) => {
          expect(r.get<RuleDTO>("rule", c.ruleId as string)?.destination).toBe("ohmail/Receipts");
          // Doctrine: rules are consulted at ARRIVAL — a destination change re-sorts nothing.
          expect(msgOf(r, c.oldMail as string)?.folder).toBe("INBOX");
        },
        optimistic: "landed",
        pass: {
          none: "a destination change stamps no retro request (that is rule_create's applyRetro, " +
            "driven next door), so no pass has anything owed for it — asserted implicitly by the " +
            "stored mail staying put through legs (a) and (b)",
        },
      },
    ],
  },

  rule_create: {
    coverage: "covered",
    scenarios: [
      {
        name: "a rule with retro lands, and the retro pass re-files the backlog onto a LIVE client — once",
        seed: async (w) => {
          const oldMail = await w.seedMail({ fromAddress: "letters@zine.example", subject: "No. 4" });
          await w.seedHeaders(oldMail, {});
          const bystander = await w.seedMail({ fromAddress: "human@friends.example", subject: "hi" });
          await w.seedHeaders(bystander, {});
          return { oldMail, bystander };
        },
        mutation: () => ({
          kind: "rule_create", ruleKind: "sender", match: "letters@zine.example",
          destination: "ohmail/News", applyRetro: true,
        }),
        landed: (r, c) => {
          const rule = r.list<RuleDTO>("rule").find((x) => x.match === "letters@zine.example");
          expect(rule).toMatchObject({ kind: "sender", destination: "ohmail/News", enabled: true });
          expect(msgOf(r, c.bystander as string)?.folder).toBe("INBOX");
        },
        optimistic: "landed",
        pass: {
          name: "ruleRetroPass",
          run: async (w, c) => {
            const first = await w.pass.ruleRetro();
            expect(first.moved).toBeGreaterThanOrEqual(1);
            expect(first.completed).toBe(1);
            await w.engine.syncOnce();
            // The re-sort arrives through /sync on the client that was already watching.
            expect(msgOf(w.store, c.oldMail as string)?.folder).toBe("ohmail/News");
            expect(msgOf(w.store, c.bystander as string)?.folder, "the retro over-matched").toBe("INBOX");
            // One-shot: the marker is stamped, the second run owes nothing.
            const second = await w.pass.ruleRetro();
            expect(second.moved).toBe(0);
          },
        },
        // The rule itself must stand after its own pass; the backlog wears its destination.
        landedAfterPass: (r, c) => {
          const rule = r.list<RuleDTO>("rule").find((x) => x.match === "letters@zine.example");
          expect(rule?.enabled).toBe(true);
          expect(msgOf(r, c.oldMail as string)?.folder).toBe("ohmail/News");
          expect(msgOf(r, c.bystander as string)?.folder).toBe("INBOX");
        },
      },
      {
        name: "applyRetro:false changes only the future — the backlog stays put through the pass",
        seed: async (w) => {
          const oldMail = await w.seedMail({ fromAddress: "quiet@zine.example" });
          await w.seedHeaders(oldMail, {});
          return { oldMail };
        },
        mutation: () => ({
          kind: "rule_create", ruleKind: "sender", match: "quiet@zine.example",
          destination: "ohmail/News", applyRetro: false,
        }),
        landed: (r, c) => {
          expect(r.list<RuleDTO>("rule").some((x) => x.match === "quiet@zine.example")).toBe(true);
          expect(msgOf(r, c.oldMail as string)?.folder).toBe("INBOX");
        },
        optimistic: "landed",
        pass: {
          name: "ruleRetroPass",
          run: async (w) => {
            // Nothing is owed: the verb declined the retro, so the pass must not invent one.
            // (Teeth for this pass live in the applyRetro:true scenario above.)
            const r = await w.pass.ruleRetro();
            expect(r.moved).toBe(0);
          },
        },
      },
    ],
  },
};

/** Every covered scenario, flat — what the matrix runner iterates. */
export function coveredScenarios(): Array<{ kind: MutationKind; scenario: VerbScenario }> {
  const out: Array<{ kind: MutationKind; scenario: VerbScenario }> = [];
  for (const [kind, entry] of Object.entries(VERB_MATRIX) as Array<[MutationKind, VerbEntry]>) {
    if (entry.coverage !== "covered") continue;
    for (const scenario of entry.scenarios) out.push({ kind, scenario });
  }
  return out;
}
