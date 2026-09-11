import { eq } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import { accountSettings, type Tx } from "@trafficflow/db";
import { resolveOhboxPolicy, type OhboxPolicy } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { fenceErasedAccount } from "./erasure-fence.js";
import { planAccountFanOut } from "./reader-request.js";
import {
  fanOutProfileEdit, profileTravelled, type ProfileTravel,
} from "./profile-request.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

// Re-exported so the API surface has one import for the read helpers AND the resolver, and so the
// engine's resolution (`@trafficflow/core`) stays the single source of truth — see the note on
// `resolveOhboxPolicy` in `rules.ts`.
export { resolveOhboxPolicy };

/**
 * THE EDITABLE OHBOX PREFERENCE — read/write helpers for `account_settings.ohbox_*` (mail 0042).
 * Two facts about one account: the POSTURE (`ohbox_policy`) that turns the automated-mail
 * demotion on, and the BAR (`ohbox_bar`) — the account's own words, threaded into the classifier's
 * user turn. Both nullable; an absent `account_settings` row is every account that never changed
 * anything — the read returns defaults, never an error. THE ONE INVARIANT: a failed or absent
 * read resolves to the LENIENT posture. `people_only` is the strict one, and defaulting to it on
 * a fetch error would demote a real person's mail on a transient blip — the
 * absent-config-selects-safe rule `consent-seed.ts#consentSettings` states for `auto_suggest_at`.
 */

/** The two literals `account_settings.ohbox_policy` may hold (or NULL). The CHECK mirrors these. */
export const OHBOX_POLICIES: readonly OhboxPolicy[] = ["people_only", "people_and_replied"];

/**
 * The 2 KiB ceiling the migration's CHECK enforces, restated here so the service refuses an
 * over-cap bar with a 400 rather than letting the database raise a 23514 the caller cannot read.
 * Measured in BYTES to match `octet_length`, not characters — a multibyte bar must be judged the
 * same way the column judges it.
 */
export const OHBOX_BAR_MAX_BYTES = 2048;

/**
 * The product-default bar, shown as the placeholder and used whenever `ohbox_bar` is NULL. It states
 * what deserves the Ohbox in terms of RELEVANCE — real people plus the service mail the account owner
 * actually acts on — never "only real people", which the mechanism does not do (a receipt belongs in
 * Receipts, a relevant alert can stay in the Ohbox). A COPY constant on purpose: the stored value is
 * only ever what the account owner typed, so the default lives in one place and a NULL read falls back to it.
 */
export const DEFAULT_OHBOX_BAR =
  "Keep my Ohbox for real people writing to me and the service mail I actually act on — a delivery, "
  + "a security alert, something that needs a reply. File the newsletters and promotions in Reads, the "
  + "receipts and confirmations in Receipts, and hold first-time strangers in the Screener.";

/** What a caller stores. All optional: a PATCH may set one axis without touching the others. */
export interface ScreeningPreferenceUpdate {
  /** `people_only` | `people_and_replied` | `null` (revert to the lenient default). */
  ohboxPolicy?: OhboxPolicy | null;
  /** The free-text bar, or `null` to revert to {@link DEFAULT_OHBOX_BAR}. */
  ohboxBar?: string | null;
  /**
   * SCREENER AUTO-APPLY opt-in. `true` ⇒ stamp `screener_auto_apply_at = now()` (on); `false` ⇒
   * NULL it (off). A boolean on the wire, a timestamp in the column — the read below collapses the
   * timestamp back to a boolean, and {@link ScreeningPreference.screenerAutoApply} is what a control
   * renders. There is no "revert to default" third state: the default IS off, and `false` reaches
   * it. See {@link ScreeningPreference.screenerAutoApply} for what turning it on does.
   */
  screenerAutoApply?: boolean;
}

/**
 * What a read returns — the RAW stored values, so the API echoes exactly what the database holds.
 * `ohboxPolicy` NULL means "never set" (the client shows it as the lenient default); the resolved
 * posture the ENGINE runs on is {@link resolveOhboxPolicy}, never this raw value.
 */
export interface ScreeningPreference {
  ohboxPolicy: OhboxPolicy | null;
  ohboxBar: string | null;
  /** `account_settings.screening_baseline_at`, raw. Fed to `resolveCutline`, never read here. */
  screeningBaselineAt: Date | null;
  /** `account_settings.dormancy_days`, raw — NULL means the product default. */
  dormancyDays: number | null;
  /** `account_settings.screening_scope`, raw — anything but `'all_time'` is the window. */
  screeningScope: string | null;
  /**
   * Whether SCREENER AUTO-APPLY is on — the resolved boolean, from `screener_auto_apply_at IS NOT
   * NULL`. An absent row, a NULL column and a failed read all resolve to `false`, so an account
   * that has never touched this — and one whose settings could not be fetched — auto-applies
   * nothing. That default is the safe one: on means the worker files obvious strong-bulk senders
   * out of the Screener (deterministic routing only — no model call, no spend, no auto-purchase of
   * paid suggestions), and off means the queue is a human's to triage as it has always been.
   */
  screenerAutoApply: boolean;
}

/**
 * Read the account's stored preference. An absent row (most accounts) ⇒ both NULL, which every
 * reader treats as defaults. This is the RAW read for the API surface and the worker's resolution.
 */
/**
 * A posture save's answer: the preference as it stands HERE, plus where the edit went (mail 0094).
 *
 * `pending` is present only when nothing was written on this install — the route answers 202 — and
 * the preference alongside it is the UNCHANGED one, because that is what this install still holds.
 * Both fields are absent on a one-install account, so its answer is unchanged byte for byte.
 */
export interface ScreeningPreferenceResult extends ScreeningPreference {
  pending?: true;
  travel?: ProfileTravel;
}

export async function getScreeningPreference(ctx: ServiceContext): Promise<ScreeningPreference> {
  const [row] = await ctx.db.select({
    ohboxPolicy: accountSettings.ohboxPolicy,
    ohboxBar: accountSettings.ohboxBar,
    screenerAutoApplyAt: accountSettings.screenerAutoApplyAt,
    // The cutline's three stored answers, on the read the Screener page already makes. A second
    // read would let the queue and the count beside it be measured from different fetches.
    screeningBaselineAt: accountSettings.screeningBaselineAt,
    dormancyDays: accountSettings.dormancyDays,
    screeningScope: accountSettings.screeningScope,
  }).from(accountSettings).where(eq(accountSettings.accountId, ctx.accountId)).limit(1);
  return {
    // A value outside the enum (only reachable if the CHECK is somehow bypassed) reads as NULL here,
    // never as a third posture — the same allowlist-not-negation discipline the router uses.
    ohboxPolicy: row?.ohboxPolicy === "people_only" || row?.ohboxPolicy === "people_and_replied"
      ? row.ohboxPolicy : null,
    ohboxBar: row?.ohboxBar ?? null,
    // `IS NOT NULL`, never the timestamp itself — the flag is a predicate, and an absent row reads
    // as OFF like every other unset field here.
    screenerAutoApply: row?.screenerAutoApplyAt != null,
    // RAW, all three: `resolveCutline` owns every default and every rejection, and a value
    // normalised here would be a second opinion about the same columns.
    screeningBaselineAt: row?.screeningBaselineAt ?? null,
    dormancyDays: row?.dormancyDays ?? null,
    screeningScope: row?.screeningScope ?? null,
  };
}

/**
 * Write the account's preference. STRICT validation, no coercion — mirrors `ai-settings.ts` /
 * `consent.ts`: an unknown posture is a 400, an over-cap bar is a 400 (in bytes, matching the CHECK),
 * and `null` on either axis is a legal "revert to default". The upsert touches only the columns the
 * caller named plus `updated_at`, so it races the seed/auto-suggest writers on the same PK without
 * clobbering their columns — the pattern `setAutoSuggest` established and proves under real Postgres.
 */
export async function setScreeningPreference(
  ctx: ServiceContext, update: ScreeningPreferenceUpdate,
): Promise<ScreeningPreferenceResult> {
  const values: typeof accountSettings.$inferInsert = { accountId: ctx.accountId };
  const set: Partial<typeof accountSettings.$inferInsert> = { updatedAt: ctx.now() };

  if ("ohboxPolicy" in update) {
    const p = update.ohboxPolicy;
    if (p !== null && p !== undefined && p !== "people_only" && p !== "people_and_replied") {
      throw new ServiceError(
        "validation_failed", 400,
        `ohboxPolicy must be one of ${OHBOX_POLICIES.join(", ")} or null`,
      );
    }
    values.ohboxPolicy = p ?? null;
    set.ohboxPolicy = p ?? null;

    // ARM THE BACKLOG RE-ROUTE, ONLY on the TRANSITION into `people_only` (mail 0043). The
    // posture only changes NEW mail; mail already misfiled into the Ohbox is moved by the
    // worker's tidy pass, owed work exactly when `ohbox_tidy_requested_at` is set past
    // `ohbox_tidy_done_at` — stamping on the flip is what "run once on the policy flip" means.
    // `ohbox_tidy_cursor` is NULLed in the SAME write: a re-arm leaving the cursor at a previous
    // run's end would resume there and move nothing. Only on the TRANSITION — a re-save that
    // keeps `people_only` (editing the bar) must not re-run the backlog, so the prior posture is
    // read first. Not a race hazard: a double-stamp merely re-arms an idempotent pass that writes
    // zero. The explicit re-run affordance is `requestOhboxTidy`, which arms unconditionally.
    if (p === "people_only") {
      const prior = await getScreeningPreference(ctx);
      if (prior.ohboxPolicy !== "people_only") {
        values.ohboxTidyRequestedAt = ctx.now();
        values.ohboxTidyCursor = null;
        set.ohboxTidyRequestedAt = ctx.now();
        set.ohboxTidyCursor = null;
      }
    }
  }

  if ("ohboxBar" in update) {
    const b = update.ohboxBar;
    if (b !== null && b !== undefined) {
      if (typeof b !== "string") {
        throw new ServiceError("validation_failed", 400, "ohboxBar must be a string or null");
      }
      if (Buffer.byteLength(b, "utf8") > OHBOX_BAR_MAX_BYTES) {
        throw new ServiceError(
          "validation_failed", 400,
          `ohboxBar must be at most ${OHBOX_BAR_MAX_BYTES} bytes`,
        );
      }
    }
    values.ohboxBar = b ?? null;
    set.ohboxBar = b ?? null;
  }

  if ("screenerAutoApply" in update) {
    const on = update.screenerAutoApply;
    if (typeof on !== "boolean") {
      throw new ServiceError("validation_failed", 400, "screenerAutoApply must be a boolean");
    }
    // A boolean in, a timestamp stored: `true` records WHEN the account opted in (the fact worth
    // keeping, for the reason `auto_suggest_at` keeps it), `false` NULLs it back to OFF. Unlike the
    // posture flip this arms NOTHING — the pass reads this column live every cycle, so there is no
    // "requested_at" to stamp; opting in is the whole instruction and opting out is complete.
    values.screenerAutoApplyAt = on ? ctx.now() : null;
    set.screenerAutoApplyAt = on ? ctx.now() : null;
  }

  /* ── THE SCREENING POSTURE IS APPLIED BY THE INSTALL THAT ORGANIZES (mail 0094) ──────────
   *
   * This door had no organizer gate either. `ohbox_policy` decides where NEW mail is filed and
   * arms the backlog re-route that the worker's tidy pass performs — both on the organizer's
   * authority, in the organizer's own cycle. Written on a mailbox this install only reads, it
   * changed a row nothing acts on while the pane reported the new posture, which is the same
   * silently-ineffective shape ruling 6 names for the responder.
   *
   * ACCOUNT-scoped (`account_settings`), so it fans out.
   */
  let travel: ProfileTravel | undefined;
  let pending = false;

  // A transaction where a bare upsert once stood, and the fence is the reason: the FOR SHARE
  // interlock in `erasure-fence.ts` only holds until COMMIT, so fencing an autocommit statement
  // from a separate statement would guard nothing. Fence first, then the same upsert.
  await asTx(ctx).transaction(async (tx) => {
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    const plan = await planAccountFanOut(tx, ctx.accountId, "profile.update");

    /* ONLY THE FIELDS THIS REQUEST NAMED. The payload is a partial and absence is load-bearing —
       sending the whole posture would let a door that changed the bar also overwrite a policy the
       person never touched on the machine that actually applies it. */
    const travelling = {
      screeningPreference: {
        ...("ohboxPolicy" in update ? { ohboxPolicy: (update.ohboxPolicy ?? null) as string | null } : {}),
        ...("ohboxBar" in update ? { ohboxBar: (update.ohboxBar ?? null) as string | null } : {}),
        ...("screenerAutoApply" in update ? { screenerAutoApply: update.screenerAutoApply as boolean } : {}),
      },
    };

    if (!plan.writeLocally) {
      // The reader's own `account_settings` row is left untouched — never both.
      travel = await fanOutProfileEdit(tx, ctx, plan, travelling);
      pending = true;
      return;
    }

    await tx.insert(accountSettings).values(values)
      .onConflictDoUpdate({ target: accountSettings.accountId, set });
    if (profileTravelled(plan)) travel = await fanOutProfileEdit(tx, ctx, plan, travelling);
  });

  const current = await getScreeningPreference(ctx);
  return {
    ...current,
    ...(pending ? { pending: true as const } : {}),
    ...(travel === undefined ? {} : { travel }),
  };
}

/**
 * ARM THE OHBOX BACKLOG RE-ROUTE ON DEMAND — the "tidy now" affordance's service half (mail
 * 0043). Stamps `ohbox_tidy_requested_at = now()` and NULLs `ohbox_tidy_cursor` in one write, so
 * the tidy pass owes a fresh, from-the-top run. Unlike the transition stamp in
 * `setScreeningPreference` this is UNCONDITIONAL — what a user presses to re-file the existing
 * Ohbox again. It does NOT change the posture and does NOT demote: with `ohbox_policy` still
 * lenient the pass no-ops, so arming a lenient account moves no mail — this only asks the pass to
 * look. Racing the seed/auto-suggest writers on the same PK is safe: the upsert touches only
 * these two columns plus `updated_at`.
 */
export async function requestOhboxTidy(ctx: ServiceContext): Promise<void> {
  // Fenced in a transaction for `setScreeningPreference`'s reason: the FOR SHARE interlock
  // lives and dies with the transaction, so the fence and the upsert must share one.
  await asTx(ctx).transaction(async (tx) => {
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, ohboxTidyRequestedAt: ctx.now(), ohboxTidyCursor: null })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { ohboxTidyRequestedAt: ctx.now(), ohboxTidyCursor: null, updatedAt: ctx.now() },
      });
  });
}
