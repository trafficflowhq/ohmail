import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { billingEvents, billingSubscriptions } from "./schema.js";
import { suspendedAccountIds } from "./suspension.js";
import type { LedgerTx, Tx } from "./change-log.js";

/**
 * PLANS and ENTITLEMENTS.
 *
 * ## Why this lives in `packages/db`
 *
 * `entitlementsFor` has two consumers that straddle the services boundary. The WORKER is
 * where AI actually happens (the spend gate, and later sync gating) and it may import **core +
 * db only** — the worker's dependency test pins that list, because a `@trafficflow/services`
 * import typechecks, resolves through the vitest alias, and then throws `MODULE_NOT_FOUND`
 * inside the worker's Docker image where `services` is not installed. `packages/services`
 * (the mailbox gate, the status route) already imports db. So db is the only home both can
 * reach, and it is the right one anyway: this function interprets rows whose schema is here.
 *
 * One function, one truth. Two copies of this logic would diverge into either overcharging
 * the user or giving tokens away.
 *
 * ## NOTHING IN PRODUCTION CONSUMES THIS YET — and that is a launch gate, not a detail
 *
 * This module ships the DECISION; the consumers are the Stripe webhook + the status route, the
 * AI gate in the worker, and the mailbox-create gate. Until they land, `canAddMailbox` gates
 * nothing, AI spend is not metered, and `paused` stops no worker. A repo-wide grep for
 * `entitlementsFor|canAddMailbox|debitCredits|liveSubscriptionOf` outside `packages/db`
 * returns zero hits by design (all three consumers were deliberately deferred), and a test
 * asserts it stays that way until someone deliberately changes it.
 *
 * **Do not enable Stripe before those consumers exist.** A live subscription with no gate on
 * the spending side is the worst of both worlds: customers are charged and nothing limits what
 * they cost.
 *
 * ## Why entitlements are read from the ROW, never from {@link PLAN_LIMITS}
 *
 * `billing_subscriptions.mailbox_limit` / `.monthly_credits` are DENORMALIZED at sale time:
 * they are what THIS subscription was sold with. A later price change, or a grandfathered
 * custom deal, must not retro-rewrite what a live customer is entitled to — so
 * {@link entitlementsFor} reads the snapshot it is handed and the plan card below is used
 * only by Checkout line items and the pricing UI.
 */

/**
 * The canonical plan card — Checkout, the pricing UI and tests share it.
 *
 * Mailboxes are **5 / 10 / 50** (raised from 2/5/10 during the pre-beta build).
 * This constant is the enforcement side of a number the landing page advertises, and the two
 * were allowed to drift once already: `apps/webapp/messages/en.json` sold Solo as 5 mailboxes
 * while this card still said 2, so the third `POST /mailboxes` answered 409 to a customer who
 * had bought the third mailbox. If the marketing number changes again, it changes HERE in the
 * same commit — `test/entitlements.test.ts` pins the whole card so the diff cannot
 * be one-sided.
 *
 * Credits are unchanged (2k / 6k / 20k): the mailbox count is a capacity promise, an AI action
 * is a metered cost, and only the first one was under-priced against what the product does.
 */
export const PLAN_LIMITS = {
  solo: { priceUsd: 9, mailboxes: 5, monthlyCredits: 2_000 },
  plus: { priceUsd: 15, mailboxes: 10, monthlyCredits: 6_000 },
  pro: { priceUsd: 29, mailboxes: 50, monthlyCredits: 20_000 },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;

/**
 * WHAT A TRIAL IS GIVEN — the bounty, granted once per account when its trial row first lands.
 *
 * The trial used to grant NOTHING, and that decision was coherent on its own terms: `aiEnabled`
 * is `balance > 0`, so a zero balance turned managed AI off through the ordinary rule and no
 * special case was needed. What it produced on screen was a fourteen-day evaluation of a product
 * whose most distinctive feature the evaluator could not see — the Screener's suggestions, the
 * drafts, the summaries — while every plan card beside it advertised them. A trial that cannot
 * demonstrate the thing being sold is not a trial of the product.
 *
 * 500 is chosen against what the trial has to DO rather than against a plan's monthly figure. One
 * credit is one AI action ({@link ../ledger-source AI_ACTION_COST}), a first-contact backlog is
 * typically tens of senders, and the automatic Screener batch buys ten per open — so 500 covers
 * a real first fortnight several times over and still stops well short of a month of the smallest
 * plan (2 000). It is a fixed number and NOT a fraction of the plan the visitor picked at
 * Checkout: the trial is the same product whichever card was clicked, and scaling the bounty by
 * plan would make the cheapest trial the worst demonstration.
 *
 * **The bounty is not clawed back when the trial converts, and that is a stated exception to
 * no-rollover.** The expiry that runs at every paid cycle boundary is keyed off the newest
 * `invoice_grant` (`latestInvoiceGrantSource`), and a trial grant is not one — so a converting
 * account carries whatever is left of its 500 into its first paid month, on top of that month's
 * allowance. Bounded by construction (at most 500, once per account, ever) and deliberately not
 * closed: teaching the renewal path a second kind of prior grant would put the ledger's most
 * replay-sensitive composition at risk to reclaim a rounding error in the customer's favour.
 */
export const TRIAL_GRANT_CREDITS = 500;

/**
 * HOW MANY NO-CARD TRIALS ONE ORIGIN MAY START PER WINDOW — the bound that makes the bounty a
 * bounded acquisition cost rather than an open one.
 *
 * A hard product rule requires that revenue precede token spend — no API cost without revenue
 * behind it. The trial
 * bounty is an explicit, deliberate exception to it, and an exception to a hard rule is
 * only as good as the bound stated with it: 500 managed-AI actions per account, granted with no
 * card, is a per-account limit and says nothing about how many accounts one person may create.
 * Verified email is the first bound (an account cannot reach Checkout unverified) and the signup
 * throttle is the second, but neither is a bound on TRIAL STARTS — an invite holder, or anyone at
 * all once public signup is open, could clear both and still start trials as fast as the signup
 * limiter allows.
 *
 * So the trial fork of Checkout claims a slot too, under its own namespace, on the SAME per-IP
 * primitive the waitlist and registration use. Its own namespace rather than sharing
 * `register:ip` for a reason that matters: the two must be able to disagree. A deployment may want
 * generous signup and stingy trials, and a shared counter would make "twenty signups" and "twenty
 * trials" one budget while only one of them costs money.
 *
 * THREE per day, and the number is chosen against what an honest person needs: starting a trial is
 * a once-per-account act, and even someone testing the product for a team does not need a fourth
 * in twenty-four hours. Trials are already once per account (`createCheckout`'s history read), so
 * this only ever refuses the same origin starting a FOURTH different account's trial in a day. The
 * paid fork is deliberately unlimited — a card is the bound there, and refusing somebody's money
 * is a defect.
 *
 * NOT a substitute for the per-account bound: it is the second half of it. Together they cap the
 * managed-AI cost one origin can incur without paying at
 * `TRIAL_STARTS_PER_IP × TRIAL_GRANT_CREDITS` per window.
 */
export const TRIAL_STARTS_PER_IP = 3;

/** The rolling window {@link TRIAL_STARTS_PER_IP} is counted over. */
export const TRIAL_START_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * The statuses the partial unique index `billing_sub_one_live_idx` treats as LIVE — i.e. the
 * set within which an account may hold at most one subscription row.
 *
 * This MUST equal the SQL predicate in `drizzle/0018_billing.sql`. `credits.pg.test.ts` reads
 * `pg_indexes.indexdef` and asserts every member appears in the predicate and `'incomplete'`
 * does not, so the TS const and the index cannot drift silently.
 */
export const LIVE_SUBSCRIPTION_STATUSES = [
  "trialing", "active", "past_due", "unpaid", "paused",
] as const;

export type SubscriptionStatus =
  | "trialing" | "active" | "past_due" | "unpaid" | "canceled"
  | "incomplete" | "incomplete_expired" | "paused";

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  /** Denormalized at sale time — see the module doc. */
  mailboxLimit: number;
  /** Denormalized at sale time; the renewal grant amount. */
  monthlyCredits: number;
  graceUntil: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface EntitlementsInput {
  /** `null` = the account has no subscription row at all. */
  sub: SubscriptionSnapshot | null;
  /** From `balanceOf()`; a missing `credit_balances` row is 0. */
  balance: number;
  /** Wired to the account's suspension state where the caller has it; otherwise `false`. */
  suspended: boolean;
  now: Date;
  /**
   * The account's OWN AI switch (`accounts.ai_enabled`), when the caller has read it.
   *
   * Optional, and `true` when omitted, because the two kinds of caller want different things and
   * the difference is not laziness:
   *
   *  · the SPEND GATE reads the switch itself and refuses on it BEFORE it reads any subscription
   *    (`ai-gate.ts`: one indexed primary-key read for an account with AI off, instead of two
   *    reads and an entitlement computation). By the time it calls this function the switch is
   *    already known to be on, so passing it would be re-asking a settled question;
   *  · a STATUS READ has to report the whole predicate. `aiEnabled` was the subscription's half
   *    of it alone, so an account with a funded trial and its own switch off was reported as
   *    `aiEnabled: true` — and the surface that exists to explain a refusal before the press
   *    instead promised an action the gate would answer 409 to.
   *
   * Omitting it therefore means "not asked", which is honest for the gate and would be a lie for
   * the status route; the route passes it.
   */
  aiSwitchOn?: boolean;
}

/* ONE definition, in `ai-gate-port.js`, imported back here. The refusal union the spend gate
 * exposes is built from these strings, and that port has to be nameable without reaching into the
 * subscription logic — so the vocabulary sits at the leaf and the logic that produces it sits
 * here. Two unions that agree until somebody adds a state to one of them is the failure this
 * avoids. Re-exported, so nothing that took the name from this module has to move. */
export type { EntitlementReason } from "./ai-gate-port.js";
import type { EntitlementReason } from "./ai-gate-port.js";

export interface Entitlements {
  /**
   * The RETENTION limit: how many mailboxes may remain enabled. The downgrade handler reads
   * this to decide how many to disable (never delete — a billing event must never destroy
   * user data).
   */
  mailboxLimit: number;
  /**
   * The CREATION right: may ONE MORE mailbox be added. Deliberately separate from
   * {@link Entitlements.mailboxLimit} — see the note on `entitlementsFor`.
   * `POST /mailboxes` is gated on this.
   */
  canAddMailbox: boolean;
  aiEnabled: boolean;
  syncEnabled: boolean;
  reason: EntitlementReason;
}

/**
 * The post-cancel / post-unpaid EXPORT window (the standing rule: never destroy user data on a
 * billing event). Sync keeps running for this long past the paid period so the user can get their
 * mail out; after it, sync stops — and still nothing is deleted.
 */
export const EXPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The single entitlement decision, as a PURE function: no db handle, no clock read, fully
 * table-testable (`test/entitlements.test.ts` drives the whole truth table).
 *
 * Evaluation order is `suspended` first (it overrides everything), then subscription state.
 * "plan" below means the row's DENORMALIZED `mailboxLimit`.
 *
 * | state                                        | mailboxLimit | canAddMailbox | aiEnabled     | syncEnabled          | reason           |
 * |----------------------------------------------|--------------|---------------|---------------|----------------------|------------------|
 * | `suspended` (any sub state)                  | 0            | false         | false         | false                | `suspended`      |
 * | `sub === null`                               | 0            | false         | false         | false                | `no_subscription`|
 * | `incomplete` / `incomplete_expired`          | 0            | false         | false         | false                | `no_subscription`|
 * | `trialing`                                   | plan         | true          | `balance > 0` | true                 | `trialing`       |
 * | `active`                                     | plan         | true          | `balance > 0` | true                 | `active`         |
 * | `past_due` within grace                      | plan         | true          | `balance > 0` | true                 | `past_due_grace` |
 * | `past_due` past grace, or `graceUntil` null  | plan         | false         | false         | true                 | `past_due`       |
 * | `unpaid`                                     | plan         | false         | false         | 30-day export window | `unpaid`         |
 * | `canceled`                                   | plan         | false         | false         | 30-day export window | `canceled`       |
 * | `paused`                                     | plan         | false         | false         | false                | `paused`         |
 *
 * Four decisions in that table are deliberate departures from the original architecture
 * sketch, and each is a contract now:
 *
 *  1. **`canAddMailbox` is a separate right.** The sketch gave read-only states "plan (read)"
 *     limits; under the mailbox gate's `count < mailboxLimit` check an `unpaid` account could still ADD
 *     mailboxes. Retention ("how many may stay enabled") and creation ("may one more be
 *     made") are different questions and conflating them was a hole.
 *  2. **`paused` is specified** (the sketch's table omits it while its own status CHECK includes
 *     it): plan retention, no creation, no AI, and **no sync**. A paused subscription is a
 *     not-paying account with data retained; burning always-on worker resources for it
 *     contradicts revenue-first and matches the standing rule that a suspended account's
 *     automation must not keep firing.
 *  3. **`past_due` past grace keeps `syncEnabled: true`.** Credits already paid for are never
 *     revoked by dunning; `aiEnabled: false` is what stops further SPEND. ("Throttled" is a
 *     worker QoS concern for a later slice — `reason` is the hook.)
 *  4. **The trial is a `status='trialing'` row and nothing more, and THIS FUNCTION STILL DOES
 *     NOT KNOW WHAT A TRIAL IS WORTH.** The trial now carries a bounty —
 *     {@link TRIAL_GRANT_CREDITS}, granted once per account when its trial row first lands —
 *     which reverses the previous policy of granting nothing. What did NOT change is the rule
 *     here: `aiEnabled = balance > 0`, evaluated on `trialing` exactly as on `active`. The
 *     bounty is a GRANT, made by the code that owns subscription events, and it reaches this
 *     function only as a number in `balance`.
 *
 *     That separation is the whole design and it is worth stating because it is the tempting
 *     thing to collapse. A `status === "trialing" ? true : …` here would be a second, invisible
 *     source of AI permission: an account whose bounty is spent would keep spending, and the
 *     "you have run out" surface would have nothing true to say. Every credit path — trial
 *     bounty, monthly invoice grant, admin comp — is one balance, one rule, one exhaustion.
 *
 *     The residual gap the previous policy named is unchanged and still named: this function
 *     sees a NUMBER, so it cannot tell a trial bounty from a staff comp from an invoice grant.
 *     The audit trail is the ledger, where each carries its own `reason` and its own source
 *     namespace, and the rule stays a pure function of the balance because making entitlements
 *     query the ledger would trade a real property (pure, total, table-testable, callable from
 *     the worker) for a distinction the ledger already records.
 *
 * ── THE `aiEnabled` COLUMN IS `balance > 0` **AND THE ACCOUNT'S OWN SWITCH** ───────────────
 *
 * `accounts.ai_enabled` is the account owner's own control, and the spend gate refuses on it
 * before it looks at any subscription. This function did not see it, so `aiEnabled` was the
 * subscription's half of a two-part predicate while every reader treated it as the whole thing:
 * a funded trial whose owner had switched managed AI off was reported as spendable, the Screener
 * offered the purchase, and the server answered 409 after the press — which is exactly the
 * refusal-before-the-press that surface exists to provide.
 *
 * The switch reaches here as {@link EntitlementsInput.aiSwitchOn}, optional and `true` when
 * omitted (see it for why the gate does not pass it). Where the subscription already refuses, the
 * switch is not consulted and the state keeps the `reason`; where the subscription would have
 * allowed it, `reason` becomes `ai_disabled` — the same word the gate uses, because a surface
 * predicting a refusal must predict the server rather than improve on it.
 *
 * **Fail closed, and TOTAL.** `past_due` with a null `graceUntil` is treated as past grace;
 * `canceled`/`unpaid` with a null `currentPeriodEnd` gets no sync; and a status that is not
 * in the union at runtime (impossible under the CHECK, but rows outlive code) returns the
 * `no_subscription` shape. The union is exhausted with a `never` check AND a runtime default.
 */
export function entitlementsFor(input: EntitlementsInput): Entitlements {
  const { sub, balance, suspended, now } = input;

  // Admin suspension overrides every subscription state: no retention, no creation, no AI,
  // no sync. (Nothing is DELETED — that is the point of disable-never-delete.)
  if (suspended) return NOTHING("suspended");
  if (!sub) return NOTHING("no_subscription");

  const plan = sub.mailboxLimit;
  /**
   * MAY THIS ACCOUNT SPEND — the whole predicate, not the subscription's half of it.
   *
   * This was `balance > 0` alone, and the missing conjunct is the account's own switch. The two
   * refuse for opposite reasons and the spend gate honours both, so a status read reporting only
   * the first said `aiEnabled: true` about an account every AI call would be refused for. See
   * {@link EntitlementsInput.aiSwitchOn} for why the flag is optional rather than required.
   *
   * Where the SUBSCRIPTION already refuses, the switch changes nothing and is not consulted: the
   * state is the more useful explanation, and "AI is off since the subscription ended" stays the
   * sentence a cancelled account gets whatever its switch says.
   */
  const aiSwitchOn = input.aiSwitchOn ?? true;
  const canSpend = balance > 0 && aiSwitchOn;
  /**
   * The reason to report for a state that WOULD have allowed spending.
   *
   * The switch outranks the balance here for one reason and it is not aesthetics: the spend gate
   * refuses on the switch before it reads the subscription at all, so `ai_disabled` is the word
   * the server would use for this account. A surface explaining a refusal before the press has to
   * predict the server, not improve on it.
   */
  const spendReason = (state: EntitlementReason): EntitlementReason =>
    aiSwitchOn ? state : "ai_disabled";
  /** The 30-day post-period export window; a null period end fails CLOSED. */
  const withinExportWindow =
    sub.currentPeriodEnd != null &&
    now.getTime() <= sub.currentPeriodEnd.getTime() + EXPORT_WINDOW_MS;

  switch (sub.status) {
    case "incomplete":
    case "incomplete_expired":
      // An abandoned or failed Checkout is not a subscription. Same shape as having none —
      // and the same `reason`, so callers need not learn a Stripe-internal distinction.
      return NOTHING("no_subscription");

    case "trialing":
      return { mailboxLimit: plan, canAddMailbox: true, aiEnabled: canSpend, syncEnabled: true, reason: spendReason("trialing") };

    case "active":
      return { mailboxLimit: plan, canAddMailbox: true, aiEnabled: canSpend, syncEnabled: true, reason: spendReason("active") };

    case "past_due": {
      // Within grace the account is fully live; past it (or with no grace recorded — fail
      // closed) it keeps its mailboxes and its sync but stops spending.
      const inGrace = sub.graceUntil != null && now.getTime() <= sub.graceUntil.getTime();
      return inGrace
        ? { mailboxLimit: plan, canAddMailbox: true, aiEnabled: canSpend, syncEnabled: true, reason: spendReason("past_due_grace") }
        : { mailboxLimit: plan, canAddMailbox: false, aiEnabled: false, syncEnabled: true, reason: "past_due" };
    }

    case "unpaid":
      return { mailboxLimit: plan, canAddMailbox: false, aiEnabled: false, syncEnabled: withinExportWindow, reason: "unpaid" };

    case "canceled":
      return { mailboxLimit: plan, canAddMailbox: false, aiEnabled: false, syncEnabled: withinExportWindow, reason: "canceled" };

    case "paused":
      return { mailboxLimit: plan, canAddMailbox: false, aiEnabled: false, syncEnabled: false, reason: "paused" };

    default: {
      // Compile-time exhaustiveness…
      const _never: never = sub.status;
      void _never;
      // …and a runtime floor, because a row written by a future migration outlives this code.
      return NOTHING("no_subscription");
    }
  }
}

/** The zero-entitlement shape: retention 0, no creation, no AI, no sync. */
function NOTHING(reason: EntitlementReason): Entitlements {
  return { mailboxLimit: 0, canAddMailbox: false, aiEnabled: false, syncEnabled: false, reason };
}

/** What {@link liveSubscriptionOf} returns: the snapshot plus the row's identity. */
export type LiveSubscription = SubscriptionSnapshot & { id: string; plan: Plan };

/**
 * The account's LIVE subscription row, or `null`.
 *
 * "Live" is exactly {@link LIVE_SUBSCRIPTION_STATUSES} — the same set the partial unique index
 * enforces — so at most one row can match and the `limit 1` is a formality, not a choice.
 *
 * **It is NOT the right read for the export window, and that trap has a test.** `canceled` is
 * deliberately excluded from the live set (the partial index must let resubscribe history
 * accumulate), so feeding this function's `null` straight into {@link entitlementsFor} makes a
 * cancelled account look like it never subscribed — and cuts its sync the INSTANT it cancels,
 * destroying the 30-day export window that {@link EXPORT_WINDOW_MS} exists to protect.
 * A caller that needs the post-cancellation state — the status route, and whatever
 * gates sync — must read the account's NEWEST `billing_subscriptions` row regardless of status
 * (`order by stripe_event_ts desc limit 1`) and pass THAT snapshot.
 * `test/live-subscription.test.ts` › "THE SEAM" pins both halves.
 *
 * `forUpdate` is the mailbox-limit serializer: `SELECT … FOR UPDATE` on this row makes two
 * concurrent `POST /mailboxes` at limit N−1 admit exactly one. It is deliberately opt-in — the
 * read paths (the status route, the spend gate) must not take write locks on every request.
 *
 * MUST be called with the ambient transaction handle when `forUpdate` is set: a row lock
 * taken outside the caller's transaction is released immediately and serializes nothing.
 */
export async function liveSubscriptionOf(
  tx: Tx,
  accountId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<LiveSubscription | null> {
  const base = tx
    .select({
      id: billingSubscriptions.id,
      plan: billingSubscriptions.plan,
      status: billingSubscriptions.status,
      mailboxLimit: billingSubscriptions.mailboxLimit,
      monthlyCredits: billingSubscriptions.monthlyCredits,
      graceUntil: billingSubscriptions.graceUntil,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
    })
    .from(billingSubscriptions)
    .where(and(
      eq(billingSubscriptions.accountId, accountId),
      // The predicate is generated FROM the const, so it cannot fall out of step with it —
      // only with the SQL index, which the pg drift tripwire compares.
      inArray(billingSubscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
    ))
    .limit(1);

  const rows = await (opts.forUpdate ? base.for("update") : base);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    plan: row.plan as Plan,
    status: row.status as SubscriptionStatus,
    mailboxLimit: row.mailboxLimit,
    monthlyCredits: row.monthlyCredits,
    graceUntil: row.graceUntil ?? null,
    currentPeriodEnd: row.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

/**
 * The account's NEWEST subscription row, whatever its status — the read {@link liveSubscriptionOf}
 * tells you to make and, at first, did not provide.
 *
 * ## Why this exists as a callable rather than a doc comment
 *
 * The billing build found and documented the seam: `liveSubscriptionOf` deliberately excludes
 * `canceled` so the partial unique index can let resubscribe history accumulate, which means
 * feeding its `null` into {@link entitlementsFor} makes a cancelled account look like it never
 * subscribed and **cuts its 30-day export window the instant it cancels**. The trap
 * was written down; the correct read was not shipped. A documented trap with no helper is a
 * trap every caller re-springs by hand-rolling the SQL slightly differently — so it is a
 * function now, and the status route calls THIS one.
 *
 * The split of duties is exact and neither side is a superset of the other:
 *
 *  · {@link liveSubscriptionOf} answers *"is there a subscription this account is currently
 *    ON?"* — the front-door 409 for a second Checkout, and the mailbox gate's `forUpdate`
 *    allocation lock.
 *    A cancelled account must answer `null` there, because it may legitimately resubscribe.
 *  · `newestSubscriptionOf` answers *"what is the latest thing we know about this account's
 *    billing?"* — the STATUS read, where a cancellation is information rather than absence.
 *
 * `ORDER BY stripe_event_ts DESC` is the same fence the mirror upsert uses, so "newest" means
 * the newest thing STRIPE said, not the newest row we happened to write. `created_at DESC` is
 * the tie-break: `event.created` has one-second resolution, so a cancel-and-resubscribe inside
 * one second is representable, and without a second key the answer would be whatever the
 * planner felt like returning.
 *
 * **THIS IS ALMOST NEVER THE READ YOU WANT.** On its own it lets a dead row speak for an
 * account that has a LIVE one — the defect described at {@link effectiveSubscriptionOf},
 * which is what every entitlement reader calls and which uses this only as its fallback arm.
 * `test/billing-boundaries.test.ts` censuses this name for that reason.
 *
 * `forUpdate` is opt-in, exactly as {@link liveSubscriptionOf}'s is, and exists so
 * {@link effectiveSubscriptionOf}'s fallback arm can take the allocation row lock in the SAME
 * statement that reads. `packages/services/src/mailbox-allowance.ts` used to carry a private copy
 * of this query for that one reason; the copy is gone. When set, it MUST be called with the
 * ambient transaction handle: a row lock taken outside the caller's transaction is released
 * immediately and serializes nothing.
 */
export async function newestSubscriptionOf(
  tx: Tx,
  accountId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<LiveSubscription | null> {
  const base = tx
    .select({
      id: billingSubscriptions.id,
      plan: billingSubscriptions.plan,
      status: billingSubscriptions.status,
      mailboxLimit: billingSubscriptions.mailboxLimit,
      monthlyCredits: billingSubscriptions.monthlyCredits,
      graceUntil: billingSubscriptions.graceUntil,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
    })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.accountId, accountId))
    .orderBy(desc(billingSubscriptions.stripeEventTs), desc(billingSubscriptions.createdAt))
    .limit(1);

  const rows = await (opts.forUpdate ? base.for("update") : base);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    plan: row.plan as Plan,
    status: row.status as SubscriptionStatus,
    mailboxLimit: row.mailboxLimit,
    monthlyCredits: row.monthlyCredits,
    graceUntil: row.graceUntil ?? null,
    currentPeriodEnd: row.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

/**
 * **THE ONE READ OF "WHAT IS THIS ACCOUNT'S SUBSCRIPTION STATE".** The live row if
 * there is one, otherwise the newest row of any status, otherwise `null`.
 *
 * Every entitlement reader in the product calls THIS: the mailbox gate, the status route, the AI
 * gate (both arms) and — in its roster form, {@link accountsWithSyncDisabled} — the sync gate and
 * the `sync_lag` alert. That is the entire point; the defect below was five readers answering one
 * question five ways.
 *
 * ## The defect this exists to close
 *
 * There were several answers to one question and the wrong one drove what the customer saw:
 *
 *  · `LIVE_SUBSCRIPTION_STATUSES`, and therefore the partial unique index
 *    `billing_sub_one_live_idx`, covers only trialing/active/past_due/unpaid/paused. An
 *    `incomplete_expired` row and an `active` row for one account are legal TOGETHER.
 *  · The mirror upsert's conflict target is `stripe_subscription_id`, so two Stripe
 *    subscriptions are two rows.
 *  · `subscription_data.metadata.account_id` is stamped on every subscription our Checkout
 *    creates, so a subscription the customer ABANDONED still resolves to their account and is
 *    still mirrored — no `checkout.session.completed` required.
 *  · {@link entitlementsFor} maps `incomplete` / `incomplete_expired` to the `no_subscription`
 *    ZERO shape.
 *
 * So: an SCA-failed Checkout parks `sub_A` in `incomplete`; the retry pays and mirrors `sub_B`
 * `active` ten minutes later; ~23 h after that Stripe expires `sub_A`, and the resulting
 * `customer.subscription.updated` carries the newest `stripe_event_ts` on the account — on the
 * row that means nothing. Every reader that took newest-of-any-status then read the DEAD row for
 * a customer who is paying: `GET /billing/subscription` answered `no_subscription`, the AI gate
 * refused every action, and the worker's roster PARKED the account and stopped its mail.
 *
 * ## Why LIVE-preferred wins, and why the fallback is not optional
 *
 * The live row is the one the customer is being charged for, and there can only ever be one of
 * it — `billing_sub_one_live_idx` makes "the live row" a well-defined singular thing, so
 * preferring it is never a choice between two candidates. Newest-of-any-status is not a
 * competing answer to the same question; it is a WEAKER one, because it lets a dead row speak
 * for an account that has a live one. A newer `canceled` row beside a live `active` one can only
 * belong to a DIFFERENT, already-dead subscription: cancelling the live one updates that same
 * row, since the mirror keys on `stripe_subscription_id`.
 *
 * The fallback is the documented cancellation seam and it must stay. {@link liveSubscriptionOf}
 * deliberately excludes `canceled` so resubscribe history can accumulate under the partial index;
 * feeding its `null` straight to {@link entitlementsFor} makes a cancelled account look like it
 * never subscribed and cuts the 30-day export window {@link EXPORT_WINDOW_MS} exists to
 * protect. It can never shadow a live row, because it is not consulted while one exists.
 *
 * **THIS IS NOT THE FRONT-DOOR QUESTION.** `createCheckout`'s 409 asks "is there a subscription
 * this account is currently ON?" and must keep calling {@link liveSubscriptionOf} directly: a
 * `canceled` account has no live row and MAY resubscribe, so routing that check through here
 * would hand it a non-null cancelled snapshot and refuse the resubscribe forever. One question
 * per function; these are two questions.
 *
 * ## Why TWO arms and not one `ORDER BY (status in LIVE) DESC … LIMIT 1 FOR UPDATE`
 *
 * The collapsed form is tempting — one statement, one ordering shared with the roster read — and
 * it breaks the mailbox-limit mutex. That mutex works because both racers lock **the same
 * row**: the live arm's target is "the live row", singular by the partial unique index, so
 * concurrent creators converge on one lock no matter whose snapshot is older. The collapsed
 * form's target is "whatever is on top of an ORDER BY", which is not a stable identity — creator
 * A locks row X, a webhook commits a newer row Y, creator B's snapshot puts Y on top and locks
 * THAT, and two transactions hold two locks while both believe they are serialized. Secondarily,
 * `SELECT … ORDER BY … LIMIT 1 FOR UPDATE` re-checks only the WHERE under EvalPlanQual and not
 * the ORDER BY, whereas the live arm carries the liveness predicate IN its WHERE and so fails
 * closed. Do not collapse these arms.
 *
 * `forUpdate` is the mailbox-limit serializer and is deliberately opt-in — the read paths (the status
 * route, the connect gate) must not take write locks on every request. When set, the row this
 * returns is locked, and it must then be called with the ambient transaction handle.
 */
export async function effectiveSubscriptionOf(
  tx: Tx,
  accountId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<LiveSubscription | null> {
  const live = await liveSubscriptionOf(tx, accountId, opts);
  if (live) return live;
  return newestSubscriptionOf(tx, accountId, opts);
}

/**
 * Accounts (of those given) whose BILLING STATE says their mail must not be synced — the
 * **duty set**, for a whole roster, in one query.
 *
 * ## Why this is here and not only in the worker
 *
 * `apps/worker/src/mailboxes.ts` has held a private copy of this since the sync gate shipped,
 * and the copy being private is what produced the defect that moved it here. `loadEnabledMailboxes`
 * drops these accounts; `alerts.ts`'s `sync_lag` rule called every non-disabled mailbox enabled.
 * So a paused or unpaid subscription left `connected` rows that the roster deliberately parks,
 * their `last_sync_at` aged past fifteen minutes, and the alert paged forever for mailboxes that
 * are intentionally not syncing — recreating the noisy-alert failure the whole rule exists to
 * avoid, and doing it in the one place whose job is to be trusted at 3am.
 *
 * Two populations that must be the same population is a job for one function. This is it, and
 * it lives in `packages/db` for the reason the module header gives: the worker may import
 * **core + db only**, so db is the only home both drivers can reach.
 *
 * **The worker's copy is GONE.** `apps/worker/src/mailboxes.ts` re-exports this function
 * rather than holding a second query; there is one roster decision and three consumers of it —
 * the worker's `loadEnabledMailboxes`, the `sync_lag` rule in `alerts.ts`, and the worker's
 * re-export. They cannot drift because there is nothing left to drift from.
 *
 * ## And why it is phrased as "DISABLED", not "enabled"
 *
 * An account is excluded only when it HAS a subscription row whose entitlement says
 * `syncEnabled: false`. An account with no `billing_subscriptions` row at all keeps syncing, and
 * the asymmetry is deliberate: wrongly excluding an account stops a paying customer's mail —
 * and, here, hides the alert that would have said so — while wrongly including one costs a few
 * IMAP connections. When the data is ambiguous, sync, and keep watching.
 *
 * ## The ordering IS {@link effectiveSubscriptionOf}, for a whole roster
 *
 * One query, not one per account — so the per-account helper cannot simply be called here, and
 * the rule it embodies has to be expressed as a sort instead:
 *
 *   `DISTINCT ON (account_id) … ORDER BY account_id, (status in LIVE) DESC,
 *    stripe_event_ts DESC, created_at DESC`
 *
 * The first key is the live-preference and **`billing_sub_one_live_idx` is what makes it
 * well-defined**: that partial unique index admits at most one live row per account, so the
 * `true` bucket holds either nothing or exactly one row. `DISTINCT ON` therefore returns THE
 * live row when one exists and the newest row of any status when none does — the same answer
 * {@link effectiveSubscriptionOf} gives, not an approximation of it. Without the index the first
 * key would merely narrow to a bucket and leave the planner to pick within it.
 *
 * The predicate is generated from `LIVE_SUBSCRIPTION_STATUSES`, the same const
 * {@link liveSubscriptionOf}'s WHERE comes from, so the two SQL forms cannot disagree about what
 * "live" means. `test/billing-effective-readers.pg.test.ts` pins the equivalence
 * against real Postgres rather than trusting this paragraph.
 *
 * This ordering used to be newest-of-any-status, and that was the defect: an account with a live
 * `active` row and a newer `incomplete_expired` one read as `no_subscription`, whose entitlement
 * is `syncEnabled: false` — so the roster parked a paying customer and stopped their mail, and
 * `alerts.ts` correctly stopped paging about it.
 *
 * Reading {@link liveSubscriptionOf} ALONE here would still be wrong in the other direction: it
 * excludes `canceled`, which would cut a cancelled account's 30-day export window the instant it
 * cancelled. The fallback arm is what keeps that window open.
 *
 * The decision itself is {@link entitlementsFor} — composed, never re-derived, so `paused` /
 * `unpaid` / the export window keep exactly one definition. `balance` is 0 because only
 * `syncEnabled` is read and it does not depend on credits.
 */
export async function accountsWithSyncDisabled(
  tx: Tx, accountIds: readonly string[], now: Date,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (accountIds.length === 0) return out;

  // A suspended account is dropped from the rotation whatever its subscription says. Read
  // once for the whole batch; the flag feeds `entitlementsFor` below (so its `reason` is honest)
  // AND the ids are unioned in unconditionally at the end, so a suspended account with no
  // subscription row — which never appears in the DISTINCT ON result — is still parked.
  const suspended = await suspendedAccountIds(tx, accountIds);

  const rows = await tx
    .selectDistinctOn([billingSubscriptions.accountId], {
      accountId: billingSubscriptions.accountId,
      status: billingSubscriptions.status,
      mailboxLimit: billingSubscriptions.mailboxLimit,
      monthlyCredits: billingSubscriptions.monthlyCredits,
      graceUntil: billingSubscriptions.graceUntil,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
    })
    .from(billingSubscriptions)
    .where(inArray(billingSubscriptions.accountId, [...accountIds]))
    .orderBy(
      asc(billingSubscriptions.accountId),
      // THE LIVE-PREFERENCE. `false < true` in Postgres, so DESC puts the live row first;
      // the partial unique index guarantees there is at most one of it. Generated from the same
      // const `liveSubscriptionOf` uses, so "live" has one definition across both SQL forms.
      desc(inArray(billingSubscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES])),
      desc(billingSubscriptions.stripeEventTs),
      desc(billingSubscriptions.createdAt),
    );

  for (const r of rows) {
    const ent = entitlementsFor({
      sub: {
        status: r.status as SubscriptionStatus,
        mailboxLimit: r.mailboxLimit,
        monthlyCredits: r.monthlyCredits,
        graceUntil: r.graceUntil ?? null,
        currentPeriodEnd: r.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      },
      balance: 0,
      // The account's real suspension state, read above for the whole batch.
      suspended: suspended.has(r.accountId),
      now,
    });
    if (!ent.syncEnabled) out.add(r.accountId);
  }
  // A suspended account with no subscription row is not in `rows`, so union the whole set in —
  // suspension drops an account from the rotation regardless of what it ever bought.
  for (const id of suspended) out.add(id);
  return out;
}

/** One Stripe delivery, as the webhook handler hands it to the claim gate. */
export interface BillingEventClaim {
  stripeEventId: string;
  type: string;
  /** Resolved from the customer where possible; `null` when the link is not known yet. */
  accountId?: string | null;
  payload: unknown;
  /** `event.created` — also the mirror's last-write-wins fence against out-of-order delivery. */
  eventTs: Date;
}

/**
 * The webhook DEDUP gate, as a CLAIM. Returns `true` when this delivery may apply its
 * effect, `false` when it has already been applied (⇒ answer Stripe 200 and do nothing).
 *
 * **Call it INSIDE the same transaction as the effect.** That is the whole mechanism: the
 * dedup record and the credits it grants become durable together, so there is no window in
 * which one exists without the other.
 *
 * ## Why a bare `ON CONFLICT DO NOTHING` was not enough
 *
 * The arch's protocol says a row's PRESENCE means "already applied". But a FAILED apply rolls
 * its transaction back, so the error can only be recorded from a separate transaction — and
 * the moment that transaction writes the row, presence stops meaning "applied". A bare gate
 * then acknowledges every subsequent Stripe retry with 200 without ever applying anything: a
 * failed `invoice.paid` never grants the credits the customer paid for, and is never retried
 * again. Stripe gives up after ~3 days and the money is simply gone.
 *
 * So only `status = 'applied'` suppresses a retry. A `'failed'` row is CLAIMABLE — the
 * `ON CONFLICT DO UPDATE … WHERE status = 'failed'` re-takes it, and its row lock makes two
 * concurrent deliveries of the same event admit exactly one (the loser waits, then sees
 * `'applied'` and gets zero rows back).
 *
 * Pair it with {@link recordBillingEventFailure} on the error path.
 */
export async function claimBillingEvent(tx: LedgerTx, ev: BillingEventClaim): Promise<boolean> {
  if (typeof (tx as unknown as { rollback?: unknown }).rollback !== "function") {
    throw new Error(
      "claimBillingEvent: must be called INSIDE the transaction that applies the effect — a claim " +
        "that commits separately from what it claims is not a dedup gate.",
    );
  }
  const claimed = await tx
    .insert(billingEvents)
    .values({
      stripeEventId: ev.stripeEventId,
      type: ev.type,
      accountId: ev.accountId ?? null,
      payload: ev.payload,
      eventTs: ev.eventTs,
      status: "applied",
      error: null,
    })
    .onConflictDoUpdate({
      target: billingEvents.stripeEventId,
      set: {
        status: "applied", error: null, type: ev.type,
        accountId: ev.accountId ?? null, payload: ev.payload, eventTs: ev.eventTs,
        receivedAt: sql`now()`,
      },
      // A previously APPLIED event is final; only a failed attempt may be re-claimed.
      setWhere: eq(billingEvents.status, "failed"),
    })
    .returning({ id: billingEvents.stripeEventId });
  return claimed.length > 0;
}

/**
 * Record that an apply was a DELIBERATE NO-OP: the event is final and there is nothing for it
 * to do, so the row is written `applied` — suppressing every retry — with the WHY on the row.
 *
 * Born from one production event (2026-08-19): a `customer.subscription.deleted` whose
 * subscription metadata named an account that had been removed outright. The mirror upsert
 * failed the `accounts` FK, the row landed `failed`, and it could never succeed by retrying —
 * the account was not coming back and the subscription was already canceled at Stripe, which
 * is what the event said. A permanently-failed row is not an operator queue item; it is a
 * stuck `billing_events_failed` alert, paging hourly about nothing anyone can do.
 *
 * `disposition` lands in `error` — the row's one free-text column — which on an APPLIED row
 * reads as "why applying meant doing nothing". `ev.accountId` must be NULL when the subject is
 * gone: `billing_events.account_id` FKs `accounts`, which is the same reason the failure
 * fallback drops attribution; the disposition text is where the orphaned id survives.
 *
 * Idempotent, and final-respecting: a `failed` row converts (that is the whole point — the
 * production row predated this path), an `applied` row is left untouched and still counts as
 * success, exactly like {@link claimBillingEvent}'s already-applied answer. Autocommit is
 * correct here for the same reason it is in the replay path: there is no effect for a
 * transaction to be atomic WITH.
 */
export async function recordBillingEventNoop(
  tx: Tx, ev: BillingEventClaim, disposition: string,
): Promise<boolean> {
  const rows = await tx
    .insert(billingEvents)
    .values({
      stripeEventId: ev.stripeEventId,
      type: ev.type,
      accountId: ev.accountId ?? null,
      payload: ev.payload,
      eventTs: ev.eventTs,
      status: "applied",
      error: disposition,
    })
    .onConflictDoUpdate({
      target: billingEvents.stripeEventId,
      set: { status: "applied", error: disposition, receivedAt: sql`now()` },
      // Only a failed attempt may be converted — an applied event is final, whichever path
      // applied it.
      setWhere: eq(billingEvents.status, "failed"),
    })
    .returning({ id: billingEvents.stripeEventId });
  if (rows.length > 0) return true;
  // Zero rows ⇒ the row exists and is already `applied` (the setWhere refused). That is a
  // re-delivery of a no-op already recorded — success, nothing to write.
  const existing = await tx
    .select({ status: billingEvents.status })
    .from(billingEvents)
    .where(eq(billingEvents.stripeEventId, ev.stripeEventId))
    .limit(1);
  return existing[0]?.status === "applied";
}

/**
 * Record that an apply FAILED, from a transaction of its own (the apply transaction has rolled
 * back by the time this runs — that is why the row has to be written from outside it).
 *
 * The row is left `status = 'failed'`, which is what keeps the event RETRYABLE: the next
 * delivery's {@link claimBillingEvent} re-claims it and applies the effect. Writing it as
 * anything else would acknowledge the retry and lose the money.
 *
 * Guarded so a late-arriving failure report can never demote an event that has since been
 * applied successfully.
 */
export async function recordBillingEventFailure(
  tx: Tx, ev: BillingEventClaim, error: string,
): Promise<void> {
  await tx
    .insert(billingEvents)
    .values({
      stripeEventId: ev.stripeEventId,
      type: ev.type,
      accountId: ev.accountId ?? null,
      payload: ev.payload,
      eventTs: ev.eventTs,
      status: "failed",
      error,
    })
    .onConflictDoUpdate({
      target: billingEvents.stripeEventId,
      set: { error, receivedAt: sql`now()` },
      setWhere: eq(billingEvents.status, "failed"),
    });
}
