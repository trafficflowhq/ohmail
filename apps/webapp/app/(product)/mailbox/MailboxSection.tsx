"use client";

/**
 * SETTINGS → MAILBOXES, for the Cloud client. The pane that lets somebody who already has
 * an account CONNECT A MAILBOX.
 *
 * ── THE DEAD END THIS ENDS ──────────────────────────────────────────────────────────────
 *
 * `JoinScreen` was the only caller of `POST /mailboxes` in the product. That is fine while
 * onboarding runs start to finish, and it is a trap the moment it does not:
 *
 *  1. The mailbox step asks for an app password. Every provider in
 *     `app/shell/providers.ts` requires the user to leave, sign in somewhere else and
 *     generate one — realistically several minutes.
 *  2. `POST /mailboxes` is `stepUp`-gated and the window is FIVE MINUTES
 *     (`packages/services/src/auth/config.ts:21`). So the submit that comes back with the
 *     password lands on 403 `step_up_required` more often than not.
 *  3. `JoinScreen` answers that with a fatal screen whose only exit is "Sign in", and
 *     `LoginScreen` sends a completed sign-in to `/`.
 *  4. `/` is the mail client — which had no way to add a mailbox and no link back to
 *     `/join`. The user is now permanently unable to connect the mailbox they just paid for.
 *
 * Going back to `/join` is NOT the fix and would re-enter the same loop: `bootstrap()` sends
 * anybody who already has one mailbox straight to "done", and anybody who has none back to
 * the step that just expired.
 *
 * ── SO THE CEREMONY RUNS ON SUBMIT, IN PLACE ────────────────────────────────────────────
 *
 * The window is not widened. Widening it would trade a usability bug for a security one, and
 * five minutes is the right number for a route that writes an IMAP credential.
 *
 * Instead this pane does what `AccountSection` already does for `DELETE /account`, and for
 * the reason spelled out in that file's header: NOTHING refreshes `sessions.last_twofa_at`
 * except completing a login, so a person sitting in their mailbox is essentially never
 * step-up fresh, and "try it and translate the 403" is a button that fails for everyone. The
 * password and the second factor are asked for HERE — but AFTER the credentials are typed,
 * not before, which is the whole point: the clock starts when the user has already finished
 * the slow part, so the five minutes are spent on a passkey tap rather than on a trip to
 * Google.
 *
 * The typed mailbox form is held across the ceremony and submitted the instant the factor
 * verifies. A `step_up_required` that somehow still arrives returns to the factor step with
 * the form intact — never to a screen that discards what was typed.
 *
 * ── WHY THE LIST COMES FROM THE API AND NOT THE MIRROR ──────────────────────────────────
 *
 * `views/SettingsView.tsx` used to render `reader.list<MailboxEntity>("mailbox")`, and for a
 * real account that is ALWAYS EMPTY: `"mailbox"` is not an `EntityType`
 * (`packages/db/src/change-log.ts:31-33`), so `/sync` never emits one and only the
 * `FixturesAdapter` seeds them. Every signed-in customer saw an empty Mailboxes pane no
 * matter how many mailboxes they had connected. `GET /mailboxes` is the only surface that
 * knows, so this pane asks it.
 *
 * This file lives under `(product)`, which `scripts/publish-desktop.mjs` DENYs, so none of
 * it reaches the Desktop mirror — the same seam as `AccountSection`. Desktop passes no node
 * and keeps the shared shell's fixture list.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsRow, SettingsSection, SettingsVerdict } from "@ohmail/ui";
/* The first-run flow's route helper. The pane NAVIGATES rather than rendering the stage: the
   stage lives in the shared shell above every pane, so a person who opens it from here keeps the
   app behind it and lands back in this pane when they leave. */
import { goFirstRun } from "../../shell/routing";
import {
  ApiError,
  apiConfigured,
  assertPasskey,
  auth,
  billing,
  codeOf,
  mailboxes as mailboxApi,
  messageOf,
  webauthnAvailable,
  type MailboxDTO,
  type OrganizerPeek,
  type TwofaChallenge,
  type UpdateMailboxBody,
} from "../../api-client";
import {
  OAUTH_REASONS, beginOAuthReturn, noOAuthOutcome, oauthOutcome, subscribeOAuthOutcome,
} from "./oauth-return";
import { hostsFor, providerById, providerLabel, type ProviderPreset } from "../../shell/providers";
import { ProviderPicker } from "../../shell/ProviderPicker";
import { AGO_COPY, agoStamp } from "../../shell/format";
import { isSyncBlockReason, showInboundQuiet, standDownToken } from "../../shell/mail-state";
import { useMailState } from "../../shell/MailStateProvider";
import { displayAddress } from "../../shell/idn";

/**
 * `list` → the pane at rest. `form` → typing credentials for a NEW mailbox. `edit` → changing the
 * server settings or app password of one that already exists. Both funnel into the same two
 * ceremony steps (`password` → `factor`), because `POST` and `PATCH` are both step-up-gated and
 * both write a credential — the only thing that differs is which call the verified factor makes.
 */
/**
  * `"remove"` is the CONFIRMATION, not the removal: it states the consequences and asks. The
  * removal itself runs from `"factor"` like every other write that touches a stored credential —
  * `DELETE /mailboxes/:id` is step-up gated for the mirror image of `create`'s reason, because it
  * DESTROYS one.
  */
type Stage = "list" | "form" | "edit" | "remove" | "password" | "factor" | "saving";
type Factor = "webauthn" | "totp" | "recovery_code";

/**
 * What the edit form holds. Separate from the connect form's {@link Typed} on purpose: an edit is
 * a PATCH of stored settings, so every field is a correction that may be omitted, and the server
 * merges what is sent over what it already has.
 *
 * The ports are strings because they are input values; each is parsed only once, on submit,
 * after it has been validated. Everything is held across the ceremony so a refused probe
 * returns to a form that still has it.
 *
 * `smtpHost`/`smtpPort` are the SENDING half (SET-M3). The connect form has always collected an
 * SMTP host, and `PATCH /mailboxes/:id` has always accepted an `smtp` block — probed before it
 * is stored, with the server's `SIZE` announcement re-learned from the dial — but the edit form
 * patched IMAP only, so a mistyped or migrated SMTP host had no correction path.
 */
interface EditForm {
  host: string;
  port: string;
  user: string;
  pass: string;
  smtpHost: string;
  smtpPort: string;
  /** The plaintext opt-in — rendered only after the server reported `tls_unavailable`. */
  allowInsecure: boolean;
}

const emptyEdit = (): EditForm => ({
  host: "", port: "", user: "", pass: "", smtpHost: "", smtpPort: "", allowInsecure: false,
});

/** A port is optional; if given it has to be one a server could actually listen on. */
function validPort(raw: string): boolean {
  if (!/^\d+$/.test(raw)) return false;
  const n = Number(raw);
  return n >= 1 && n <= 65535;
}

/**
 * Turn the typed corrections into a PATCH body. Blank fields are DROPPED rather than sent empty —
 * an omitted field means "keep the stored value", which is what makes "rotate only the password"
 * a one-field edit. The password is the one field always sent: its presence is what makes the
 * server re-try the login before it stores anything.
 */
function imapPatchOf(e: EditForm): NonNullable<UpdateMailboxBody["imap"]> {
  const imap: NonNullable<UpdateMailboxBody["imap"]> = { pass: e.pass };
  const host = e.host.trim();
  const user = e.user.trim();
  const port = e.port.trim();
  if (host) imap.host = host;
  if (user) imap.user = user;
  if (port) imap.port = Number(port);
  // Sent only when checked — the server re-proves TLS is absent before honoring it, so a stray
  // flag costs nothing, but omitting a false keeps the wire identical to the pre-consent shape.
  if (e.allowInsecure) imap.allowInsecure = true;
  return imap;
}

/**
 * The SMTP half of the same PATCH — or `undefined` when no SMTP field was touched, so an edit
 * that only rotates the password (or corrects IMAP) dials no SMTP server at all: the server
 * probes the `smtp` block whenever one arrives with a `pass`, and an unasked-for dial against
 * a working submission server is a way to fail a save about something else.
 *
 * When a field WAS touched, `pass` rides along because the server re-tries the SMTP login
 * before storing anything — the same try-before-store the IMAP block gets — and a typed
 * username correction rides into both transports, exactly as the connect form sends one login
 * for both. Blank fields are dropped; the server merges over the stored `smtp` meta, so a
 * host-only correction keeps the stored port.
 */
function smtpPatchOf(e: EditForm): UpdateMailboxBody["smtp"] {
  const host = e.smtpHost.trim();
  const port = e.smtpPort.trim();
  if (!host && !port) return undefined;
  const smtp: NonNullable<UpdateMailboxBody["smtp"]> = { pass: e.pass };
  if (host) smtp.host = host;
  if (port) smtp.port = Number(port);
  const user = e.user.trim();
  if (user) smtp.user = user;
  return smtp;
}

/** Everything the user typed, held across the ceremony so a 403 never discards it. */
interface Typed {
  /** `null` until the user chooses — the form's fields only render once one is. */
  provider: ProviderPreset | null;
  address: string;
  user: string;
  pass: string;
  imapHost: string;
  smtpHost: string;
  /** The plaintext opt-in — rendered only after the server reported `tls_unavailable`. */
  allowInsecure: boolean;
}

const emptyTyped = (): Typed => ({
  provider: null,
  address: "",
  user: "",
  pass: "",
  imapHost: "",
  smtpHost: "",
  allowInsecure: false,
});

/**
 * WHAT THE ROW IS ALLOWED TO CALL THIS MAILBOX — and why it is not just `status`.
 *
 * `mailboxes.status` DEFAULTS to `'connected'` (`packages/db/src/schema.ts`) and
 * `MailboxService.create` inserts without setting it, so the column says `connected` from the
 * moment the row exists: before the host is resolved, before the password is offered, before
 * one message. Measured on a live iCloud mailbox: the pane said "iCloud Mail ·
 * connected" seconds before the first message arrived and minutes before the first
 * completed cycle. `apps/worker/src/index.ts` states the invariant it believed it was keeping,
 * that the column "may only say `connected` about one that has actually synced"; nothing on the
 * way IN enforced it.
 *
 * iCloud is the sharpest case because an app-specific password is mandatory there with 2FA on,
 * so the common mistake — typing the Apple ID password — produced a row reading "connected"
 * until the worker's first attach failed.
 *
 * ── NO FOURTH STATUS VALUE, AND THAT IS THE POINT ───────────────────────────────────────
 *
 * The obvious fix is a `pending` member and a migration. It would be the wrong one: the fact is
 * already in the row. `lastSyncAt` is NULL until a cycle completes — exactly "no cycle has
 * confirmed this mailbox" — it is already on the wire, and the line below already reads it for
 * the timestamp. A new enum member would add a value every consumer of the column has to learn
 * and a second source of truth that can disagree with `last_sync_at`, to change one sentence.
 *
 * The rule is one-directional, which is what makes it honest: it can only ever WEAKEN the
 * claim. A mailbox that has synced still says `connected`, because a cycle proved it.
 */
export function statusKey(m: Pick<MailboxDTO, "status" | "lastSyncAt">): string {
  return m.status === "connected" && m.lastSyncAt === null ? "status_connecting" : `status_${m.status}`;
}

// The forwarding-detection notice's show rule is `showInboundQuiet` in `shell/mail-state.ts` —
// the SHARED shell, because the desktop's Mailboxes pane renders the same notice and
// `(product)` is denied from the Desktop mirror. This pane imports it beside `isSyncBlockReason`.

/**
 * ONE ADDRESS, ONE ROW.
 *
 * ── WHAT WAS ON SCREEN ──────────────────────────────────────────────────────────────────
 *
 * `delete` is a SOFT delete and mail 0021's unique index is PARTIAL (`WHERE status <>
 * 'disabled'`, on `lower(address)`), so a disabled row is not a conflict and connecting the same
 * address again legally inserts a second one. That is the intended schema — a tombstone must not
 * lock its own address out for ever — and the pane rendered the consequence verbatim: the dead
 * row sat beside the live one, same address, indistinguishable, for ever.
 *
 * It is not a rare shape. It is what the ONLY available remedy produces: a mailbox the organizer
 * lease stood down is off the worker's roster (`loadEnabledMailboxes` filters `status <>
 * 'disabled'`) and this pane offers no re-enable, so connecting the address again is the only
 * move a Cloud customer has.
 *
 * ── THE KEY ITSELF MOVED, AND SO DID ITS REASONING ──────────────────────────────────────
 *
 * `addressKey` now lives at `app/shell/address-key.ts` — `lower()` only, never `trim()`, with the
 * whole argument for that (a grouping may be narrower than the constraint; it may never be wider).
 * It moved when a SECOND consumer arrived: `mail-state.ts`'s stand-down arm decides the same
 * question — has this address come back? — and that rail and this pane render on ONE SCREEN. Two
 * copies that agree today are how they come to disagree later, and on this pair disagreeing means
 * two contradictory sentences about one mailbox, which is the defect both were written to end.
 *
 * Re-exported here because this pane was its only home for a long time and callers read better
 * for it.
 */
/* IMPORTED as well as re-exported, and the difference is a caught defect rather than a style
 * choice: `export { x } from "..."` re-exports without binding `x` in THIS module's scope, so the
 * call below became `Cannot find name` — typecheck and 43 tests, immediately and loudly. */
import { addressKey } from "../../shell/address-key";
export { addressKey };

/**
 * WHY THE CONNECT BUTTON IS NOT ALWAYS THERE.
 *
 * ── WHAT WAS ON SCREEN ──────────────────────────────────────────────────────────────────
 *
 * Walked end to end on a live Cloud account. Someone who answered "Do this
 * later" at onboarding's plan step (`JoinScreen` links it to `/`) arrives here with no
 * `billing_subscriptions` row. This pane offered **"Connect a mailbox"** and walked them
 * through every screen it has — provider, credentials, the ohmail account password, and a
 * FRESH SECOND FACTOR — and only then did `POST /mailboxes` answer 402 `no_subscription`.
 *
 * So the product asked for a second factor before saying it was never going to work. That is
 * the worst possible ordering: the most annoying step sat in front of the refusal.
 *
 * ── EVERY FACT THIS NEEDS WAS ALREADY ON THE WIRE ───────────────────────────────────────
 *
 * Nothing here re-decides anything. `GET /billing/subscription` is `cost: "read"` with no
 * `stepUp` (`packages/api/src/routes/billing.ts`) and `BillingService.subscriptionStatus`
 * builds its `entitlements` from the SAME pure `entitlementsFor` that
 * `readMailboxAllowance` feeds; `emailVerified` rides on `GET /auth/session`, which this pane
 * already calls; and the slot count is the list it already holds, filtered exactly as the gate
 * counts it (`status <> 'disabled'`).
 *
 * ── THE PRECEDENCE IS THE SERVER'S PIPELINE, IN ORDER ───────────────────────────────────
 *
 * `withStepUp` → `withSpendGate` → handler (`packages/api/src/app.ts`), so an unverified
 * address is refused BEFORE the allowance gate is reached. A pane that offered "choose a
 * plan" to an unverified account would be naming a refusal that never fires. Then
 * `decideMailboxAllowance`'s own order: `canAddMailbox` first, the count second — an account
 * whose subscription forbids creation must be told THAT, not that it is full.
 *
 * ── IT MAY ONLY EVER WITHHOLD AN OFFER IT CAN PROVE IS DEAD ─────────────────────────────
 *
 * The read is a snapshot; the gate is `SELECT … FOR UPDATE` inside the create's transaction.
 * They can disagree, so every unknown fails OPEN — an unreadable billing status, an unreadable
 * session, a list that has not arrived — and `connect()`'s catch is untouched. Withholding a
 * connect the server would have allowed is worse than the defect being fixed.
 *
 * **AND `no_subscription` IS ONLY ACTED ON WHEN THERE IS NO ROW AT ALL.** The two reads are
 * not identical: the gate prefers the LIVE row and falls back to newest-of-any-status
 * (`mailbox-allowance.ts`), while the status route always takes newest-of-any-status
 * (`billing/billing-service.ts`). So a live `active` row can be shadowed in newest-ordering by
 * a dead one with a later `stripe_event_ts` — an abandoned Checkout leaves an `incomplete` row,
 * and Stripe bumps it to `incomplete_expired` about a day later, which `entitlementsFor` maps
 * to the `no_subscription` shape. That account is fully entitled and the server would admit it.
 * With zero rows the two reads provably collapse to the same `null`, which is the only case
 * this refuses in advance; anything else keeps the button and lets the transaction answer.
 */
export type ConnectBlock =
  | "email_unverified" | "no_subscription" | "subscription_inactive" | "at_limit";

/** Everything the decision is made from. Every field is nullable, and null means UNKNOWN. */
export interface ConnectFacts {
  /** `GET /auth/session` → `user.emailVerified`. */
  emailVerified: boolean | null;
  /** `GET /billing/subscription` → `entitlements`, the server's own verdict. */
  entitlements: { canAddMailbox: boolean; mailboxLimit: number; reason: string } | null;
  /** The same response's newest `billing_subscriptions` row. `null` = the account has none. */
  subscription: { status: string } | null;
  /** Mailboxes occupying a slot: `status <> 'disabled'`, exactly as the gate counts. */
  enabledCount: number | null;
}

/** Why the connect button is withheld, or `null` when it is offered. Pure, and total. */
export function connectBlock(f: ConnectFacts): ConnectBlock | null {
  if (f.emailVerified === false) return "email_unverified";
  const ent = f.entitlements;
  if (!ent) return null;
  if (!ent.canAddMailbox) {
    if (ent.reason !== "no_subscription") return "subscription_inactive";
    // The shadowed-row case above: a `no_subscription` REASON with a row present is not
    // evidence that the create would be refused.
    return f.subscription === null ? "no_subscription" : null;
  }
  // An unread count fails OPEN, like every other unknown here, and `?? 0` is what that means
  // for a `>=` test: it can only ever offer a connect the server may still refuse, never
  // withhold one it would have allowed. Guarding on `!== null` instead would read the same for
  // every entitlement that exists — `entitlementsFor` never pairs `canAddMailbox: true` with a
  // zero limit — so it would be a branch nothing could ever watch fail.
  if ((f.enabledCount ?? 0) >= ent.mailboxLimit) return "at_limit";
  return null;
}

/** One address: the row that is shown, and how many disabled ones it stands in front of. */
interface AddressGroup {
  shown: MailboxDTO;
  superseded: number;
}

/**
 * Collapse the list to one entry per address.
 *
 * THE SHOWN ROW IS THE LIVE ONE when there is a live one, and the FIRST otherwise. `list`
 * returns the whole account ordered by `id` and the index guarantees at most one non-disabled
 * row per address, so "the live one" is unambiguous whenever it exists.
 *
 * A group of disabled rows with no live sibling is NOT collapsed to a footnote — it keeps a real
 * row. An account whose only mailbox was stood down must still see it, with its reason; that is
 * the state the one-row rule was written for, and hiding it would be the same defect from the other side.
 */
export function groupByAddress(items: MailboxDTO[]): AddressGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, MailboxDTO[]>();
  for (const m of items) {
    const key = addressKey(m.address);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(m);
    else { byKey.set(key, [m]); order.push(key); }
  }
  return order.map((key) => {
    const rows = byKey.get(key)!;
    const live = rows.find((m) => m.status !== "disabled");
    return {
      shown: live ?? rows[0]!,
      // Counted against the SHOWN row, so a group of one disabled mailbox reports zero — it is
      // not superseded by anything, it is simply the mailbox.
      superseded: rows.filter((m) => m !== (live ?? rows[0]!) && m.status === "disabled").length,
    };
  });
}

/**
 * WHICH OF THE FOUR THINGS FAILED, IN THIS PANE'S OWN WORDS.
 *
 * `POST /mailboxes` now tries the credentials before storing them and refuses with
 * `mailbox_probe_failed` plus `details.reason`, a member of the SAME seven-value taxonomy the
 * worker's classifier emits. That is the whole reason this reads `reason` and not the sentence:
 * one vocabulary for one set of failures, so a mistyped host and a wrong password cannot drift
 * back into sharing a sentence.
 *
 * IT IS `probe_*`, NOT `err_*`, AND THAT IS NOT DUPLICATION. The `err_*` lines all begin "Sync
 * failed", which is a claim about a mailbox that exists and has a worker attached to it. Nothing
 * has been stored when this fires — there is no mailbox and there was no sync — so reusing them
 * would ship a false sentence in the deploy that removes one.
 *
 * UNKNOWN REASONS FALL BACK TO THE SERVER'S OWN SENTENCE rather than to a generic apology: a
 * newer API that adds a taxonomy member must degrade to something true, and the server's message
 * is always exactly that. It is also what `JoinScreen` shows, since it renders `messageOf`
 * directly — so the two connect surfaces never disagree about a failure, they only differ in how
 * localizable the words are.
 */
const PROBE_REASONS = new Set([
  "auth", "connect", "tls", "timeout", "storage", "sync", "unknown",
]);

export function probeReasonOf(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== "mailbox_probe_failed") return null;
  const reason = (err.details as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" && PROBE_REASONS.has(reason) ? reason : null;
}

/**
 * THE TLS REFUSAL, IN DETAIL — `details.tls` on a `tls` reason, when the server could say more
 * than "certificate refused". Two kinds change what the form OFFERS rather than just what it
 * says: `hostname_mismatch` may carry `suggestedHost` (the vanity-CNAME shape — the certificate
 * is valid and names the provider's real host, so one press moves the field to a name the server
 * can prove), and `tls_unavailable` unlocks the explicit plaintext opt-in for a server that has
 * no TLS at all. `transport` says WHICH field is to blame; everything here degrades to the plain
 * `probe_tls` sentence when a newer server sends a kind this build has no copy for.
 */
const PROBE_TLS_KINDS = new Set([
  "hostname_mismatch", "expired", "not_yet_valid", "self_signed", "untrusted", "tls_unavailable", "generic",
]);

export interface ProbeTlsInfo {
  kind: string;
  transport: "imap" | "smtp";
  certHost?: string;
  expectedHost?: string;
  suggestedHost?: string;
}

export function probeTlsOf(err: unknown): ProbeTlsInfo | null {
  if (!(err instanceof ApiError) || err.code !== "mailbox_probe_failed") return null;
  const details = err.details as { tls?: unknown; transport?: unknown } | null | undefined;
  const tls = details?.tls;
  if (!tls || typeof tls !== "object") return null;
  const record = tls as Record<string, unknown>;
  if (typeof record.kind !== "string" || !PROBE_TLS_KINDS.has(record.kind)) return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  return {
    kind: record.kind,
    transport: details?.transport === "smtp" ? "smtp" : "imap",
    certHost: str(record.certHost),
    expectedHost: str(record.expectedHost),
    suggestedHost: str(record.suggestedHost),
  };
}

/**
 * "Fix both fields in one press" — should applying a canonical-host suggestion to the failing
 * transport's field also correct the OTHER one? Yes exactly when both current values are the
 * same name one label deeper (mail.example.com / smtp.example.com): the vanity pair that points
 * at one provider server. Comparing the values MINUS their first label, rather than a public-
 * suffix heuristic, is what keeps `mail.foo.co.uk` from dragging `smtp.bar.co.uk` along.
 */
export function sameVanityParent(a: string, b: string): boolean {
  const parent = (h: string): string => h.trim().toLowerCase().split(".").slice(1).join(".");
  const pa = parent(a);
  return pa.length > 0 && pa.includes(".") && pa === parent(b);
}

export function MailboxSection() {
  const t = useTranslations("mailboxes");
  /**
   * The `blocked_*` sentences are the SHELL's, shared rather than copied.
   *
   * `sync_blocked_reason` is a closed set of three (mail 0029) and this row and the shell's
   * strip both have to name its members. Two copies of the same three sentences is how one of
   * them ends up describing a refusal the other has renamed — and that failure mode has
   * produced once already: a fourth value rendered the literal key path.
   */
  const ts = useTranslations("sync");
  /**
   * The first-run flow's namespace, for the TEST VERDICT's three lines and nothing else.
   *
   * Reused rather than duplicated: `probeOk` interpolates exactly the three facts the endpoint
   * answers with, and a second spelling of "the server answered, signed in, N folders" is how one
   * of them ends up naming a different number. The FAILURE sentences stay this pane's own
   * `probe_*` — the service throws the same refusal on the test and the create, so one vocabulary
   * already covers both.
   */
  const tob = useTranslations("onboarding");
  /**
   * The provider tile's own namespace, for the one provider label that is PROSE rather than a
   * brand name — `providerLabel` reads `otherLabel` from it. Shared with `ProviderPicker` so the
   * picker tile and this row cannot name the same preset two different ways.
   */
  const tp = useTranslations("providerPicker");
  /**
   * WHAT THE ACCOUNT IS DOING, derived once by the shell.
   *
   * This pane deliberately does not compute it. It cannot: "the mirror is growing" is a fact
   * about the client's own message count over TIME, and a settings pane that sampled its own
   * would eventually disagree with the strip four pixels above it about whether mail is
   * arriving. `refresh` is the same reader, so a connect or a resync here updates the strip too
   * instead of leaving it a poll period behind.
   */
  const { state: mailState, refresh: refreshMailState } = useMailState();

  const [items, setItems] = useState<MailboxDTO[] | null>(null);
  /**
   * A failed read is not an empty result. `GET /mailboxes` REFUSED, as opposed to `items === null` ("not back yet") or
   * `items === []` ("back, and there are none"). Three states, because collapsing any two of
   * them puts a false sentence on screen: see `refresh`.
   */
  const [listFailed, setListFailed] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  /** `null` until the session read answers, and `null` for ever if it never does. */
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  /** The server's own entitlement verdict; `null` while unread or unreadable. */
  const [gate, setGate] = useState<Pick<ConnectFacts, "entitlements" | "subscription">>({
    entitlements: null, subscription: null,
  });
  /**
   * Has the entitlement read SETTLED once? Until it has, the list stage shows neither the
   * button nor a refusal — offering a connect and withdrawing it a moment later is the same
   * false promise this gate exists to stop, just faster.
   */
  const [gateRead, setGateRead] = useState(false);
  const [stage, setStage] = useState<Stage>("list");
  /**
   * THE MAILBOX A REMOVAL IS ABOUT, held for the whole ceremony.
   *
   * The row it came from can leave the list under a refresh mid-ceremony, so the DTO is captured
   * rather than looked up again at the end — a removal that resolved its target at confirm time
   * could act on a different mailbox than the one the confirmation named. Mutually exclusive with
   * `editing` by construction: both are entered from a resting list, and `finishCeremony` reads
   * them in a fixed order.
   */
  const [removing, setRemoving] = useState<MailboxDTO | null>(null);
  const [typed, setTyped] = useState<Typed>(emptyTyped);
  /**
   * The mailbox being edited, or `null` in the connect flow. It is what the ceremony's final step
   * reads to decide between `PATCH` and `POST`, and it carries the address the edit form shows —
   * the stored host/port/user are NOT on the wire (credentials never leave the server), so the
   * form starts empty and an untouched field keeps whatever is stored.
   */
  const [editing, setEditing] = useState<MailboxDTO | null>(null);
  const [edited, setEdited] = useState<EditForm>(emptyEdit);
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<TwofaChallenge | null>(null);
  const [method, setMethod] = useState<Factor>("webauthn");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The server said `tls_unavailable`: the ONLY state in which the plaintext opt-in renders.
   * Never set from anything the user typed — a checkbox that exists before the server has
   * proved TLS absent is an invitation to downgrade a server that merely has a bad certificate.
   */
  const [insecureOffer, setInsecureOffer] = useState(false);
  /** A canonical-host suggestion from a hostname-mismatch refusal, and which field it corrects. */
  const [suggestion, setSuggestion] = useState<{ host: string; transport: "imap" | "smtp" } | null>(null);
  const [noFactor, setNoFactor] = useState(false);
  /** Re-render clock, so the relative "synced 2 minutes ago" stays true while the pane is open. */
  const [now, setNow] = useState(() => Date.now());
  /** Mailboxes whose resync this pane has queued, so the row can say so until it lands. */
  const [queued, setQueued] = useState<Set<string>>(new Set());
  /** Mailboxes whose quiet-notice dismissal is in flight, so the button debounces (mail 0078). */
  const [dismissingQuiet, setDismissingQuiet] = useState<Set<string>>(new Set());
  /**
   * THE TAKEOVER CHECK, for at most one mailbox at a time.
   *
   * One at a time deliberately: each check opens a short-lived IMAP connection to the user's
   * provider, and a pane that let somebody start four of them at once would spend a mailbox's whole
   * connection budget answering a question nobody had finished reading. `peek: null` is the
   * in-flight state, so the panel can say it is looking rather than showing an empty result.
   */
  const [organizer, setOrganizer] = useState<OrganizerCheck | null>(null);
  /**
   * A settled, non-error outcome. Separate from `error` because `error` carries `role="alert"`, and
   * "Cloud will start organizing this mailbox on its next pass" is not an alert.
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * A MICROSOFT CEREMONY BEING STARTED — the button is disabled between the press and the top-level
   * navigation to the consent screen.
   *
   * ONE state, not two. The FINISHING half used to live here as well, and it could not: the
   * `complete` call runs on page load, before this component is guaranteed to exist, so its progress
   * is read from the module store as {@link finishing} rather than held in a component that may not
   * be mounted when it starts. Both are still visible states rather than a spinner on nothing.
   */
  const [oauthBusy, setOauthBusy] = useState<null | "starting">(null);
  /**
   * THE OUTLOOK DISCLOSURE IS OPEN (SET-L3). "Connect Outlook" used to fire the top-level
   * navigation to Microsoft on the click itself — no sentence about the redirect, no word on
   * how this door differs from the password ceremony beside it. The picker's Microsoft tile
   * already had the honest shape (the sign-in note on screen, then an explicit continue), so
   * the standalone button now shows the same note plus the which-door sentence, and only the
   * continue leaves the app. The RECONNECT on an oauth row stays one press: that row already
   * names Microsoft, and the person pressing it came to repair exactly that connection.
   */
  const [outlookOffer, setOutlookOffer] = useState(false);
  /**
   * IS THE OUTLOOK DOOR ARMED ON THIS DEPLOYMENT (cloud 0009).
   *
   * `false` until the server says otherwise, and it FAILS CLOSED — the opposite of the billing gate
   * two fields up, and deliberately. That gate withholds a connect only when it can prove the account
   * is dead, because withholding one the server would allow is the worse error. Here the worse error
   * is the one this flag exists to remove: a "Connect Outlook" button on a deployment whose Entra
   * registration is disabled or half-entered, which answers a raw 503 the moment it is pressed. So an
   * unread or unreadable capability leaves the door HIDDEN, and only an explicit `available: true`
   * shows it. The value is a deployment fact — it flips only when an operator saves the admin form —
   * so it is read once on mount and never polled.
   */
  const [oauthAvailable, setOauthAvailable] = useState(false);
  /**
   * THE SECOND MICROSOFT DOOR — the device-code flow, on servers whose operator has no Entra
   * registration of their own.
   *
   * Read from the same capability call as `oauthAvailable` and FAILS CLOSED for the identical
   * reason: an unread or unreadable answer leaves this false, so no affordance appears for a
   * ceremony this deployment cannot run.
   *
   * The two doors are independent — an install may have neither, either, or both — and they are NOT
   * two buttons. One "Connect Outlook" affordance is offered when either is armed, and
   * `startOutlook` picks: the operator's OWN registration wins when it is present, because it is
   * theirs and it does not put their users behind a client id shared with every other install. The
   * device flow is what makes the door exist at all for everybody else.
   */
  const [deviceAvailable, setDeviceAvailable] = useState(false);
  /**
   * THE LIVE DEVICE CEREMONY, or null. What is on screen and what the poll loop is polling.
   *
   * `state` is our own handle, never the device code — that never leaves the server. `userCode` and
   * `verificationUri` are the two values the person reads off the screen, and `expiresAt` is the
   * deadline the countdown renders. `retryAfterMs` is the SERVER's cadence and is re-read from every
   * poll: the interval is Microsoft's, it widens on `slow_down`, and the client id it protects is
   * shared with other people's installs.
   */
  const [device, setDevice] = useState<null | {
    state: string; userCode: string; verificationUri: string;
    expiresAt: number; retryAfterMs: number;
  }>(null);
  /**
   * How a device ceremony ENDED, when it ended without a mailbox. `declined` and `expired` are the
   * two honest outcomes that are not errors — somebody said no at Microsoft, or the fifteen minutes
   * ran out — so they get their own sentence rather than the red `error` line, which is for things
   * that went wrong.
   */
  const [deviceEnded, setDeviceEnded] = useState<null | "declined" | "expired">(null);
  /**
   * The signed-in account, for ONE purpose: deciding whether a persisted device ceremony in this
   * tab's storage belongs to whoever is looking at the screen now. Null until the session read
   * lands, and a null NEVER restores anything — an unknown owner is not a match.
   */
  const [accountId, setAccountId] = useState<string | null>(null);
  /**
   * The same value, readable from an ASYNC CLOSURE that outlives the render it was created in.
   *
   * `startDeviceFlow` awaits a network round trip. If the session read resolves during that await —
   * which is exactly the ordering this whole guard exists for, since the Outlook affordance is
   * enabled by a DIFFERENT read — React re-renders with the account id while the in-flight closure
   * still holds the `null` it captured. The synchronous write would then be skipped on the very
   * path it was added to cover, leaving only the passive effect and the unload gap with it.
   *
   * A ref because it must be readable at WRITE time rather than at render time. Found by review,
   * one layer under the fix that added the synchronous write.
   */
  const accountIdRef = useRef<string | null>(null);
  /**
   * A device poll's own transient failure, kept SEPARATE from the pane-wide `error`.
   *
   * Sharing one field looked harmless and is not: a resync or a probe failure writes `error`, and
   * the device flow's next successful poll — which happens every few seconds — would clear a
   * message about an operation that never recovered. Found by review on the fix that started
   * clearing `error` from the poll loop, which traded one wrong sentence for another.
   */
  const [devicePollError, setDevicePollError] = useState<string | null>(null);
  /**
   * THE MICROSOFT TILE'S SECONDARY PATH, requested explicitly.
   *
   * When the Entra door is armed, picking the Microsoft tile connects by SIGN-IN — Continue enters
   * the consent ceremony, not the app-password form. `false` keeps that the default; a person on a
   * tenant that blocks the sign-in flips it with "use an app password instead", which reveals the
   * address/password fields. Reset whenever the provider changes or the form is left, so a return
   * to Microsoft is offered the sign-in first, not whatever the last visit chose.
   */
  const [msAppPassword, setMsAppPassword] = useState(false);

  /** The pane can be navigated away from mid-ceremony; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /**
   * Re-read the mailbox list.
   *
   * ── `counts` IS ASKED FOR ON PANE OPEN AND NEVER ON THE POLL ────────────────────────────
   *
   * `messageCount` is one grouped aggregate over the account's whole `messages` table, and
   * `refresh` runs on a 10-second timer for as long as this pane is on screen (plus whatever
   * `MailStateProvider` is doing every 30 s in the same tab). Putting the count on the poll
   * would buy a number that changes by single digits an hour and charge a full scan of
   * somebody's mail history for it, six times a minute. It is read once, when the pane mounts.
   *
   * ── WHICH IS WHY THE POLL MERGES RATHER THAN REPLACES ───────────────────────────────────
   *
   * A countless response omits the field entirely, so `setItems(got)` would drop the number
   * ten seconds after the pane opened — the count would appear, sit there for one tick, and
   * vanish for the rest of the visit. The poll therefore carries forward the last count each
   * mailbox actually reported.
   *
   * `??`, matched on `id`, and NOT `|| `: `0` is a real count — an empty mailbox, or one still
   * importing — and `||` would discard it and re-render the row as though nobody had asked.
   * A mailbox that has gone from the list takes its count with it, because the merge is keyed
   * off the INCOMING rows; a stale id cannot resurrect a row or lend its number to a new one.
   */
  const refresh = useCallback(async (opts: { counts?: boolean } = {}): Promise<void> => {
    try {
      const { items: got } = await mailboxApi.list(opts.counts ? { counts: true } : {});
      if (alive.current) {
        /**
         * ── AND IT RETURNS `got` ITSELF WHEN THERE IS NOTHING TO CARRY ────────────────────
         *
         * Not a micro-optimisation. `setItems` with a value React can see is unchanged makes
         * React BAIL OUT of the re-render, and the first version of this merge — an
         * unconditional `got.map(...)` — allocated a fresh array on every one of the six
         * polls a minute, so every poll re-rendered the pane whether anything had changed or
         * not.
         *
         * That is what made two suites hang rather than fail: the effect that renders an
         * OAuth return depends on `refreshMailState`, and a render that produces a new
         * binding re-runs it, and it calls `refresh()` — render → effect → refresh → render.
         * The real `MailStateProvider` memoizes its binding (`shell/MailStateProvider.tsx`)
         * so the cycle does not close in the product; a test that stands in for it with a
         * fresh closure per render closes it, and then the loop only needs a state update
         * that never bails out. This is that update, so this is where it is fixed.
         */
        setItems((prev) => {
          if (prev === null) return got;
          let carriedAny = false;
          const merged = got.map((m) => {
            if (m.messageCount !== undefined) return m;
            const carried = prev.find((p) => p.id === m.id)?.messageCount;
            if (carried === undefined) return m;
            carriedAny = true;
            return { ...m, messageCount: carried };
          });
          return carriedAny ? merged : got;
        });
        setListFailed(false);
      }
    } catch (err) {
      /**
       * ── A FAILED READ IS NOT AN EMPTY RESULT — `setItems([])` WAS A CLAIM, AND IT WAS THE WRONG ONE ──────────────
       *
       * This used to answer a REJECTION with the value it uses for an empty result, under a
       * comment saying "a signed-out or unreachable server is reported by the shell around
       * this pane". That comment was false for the case it was written for: on a 500 or a
       * 503 `MailStateProvider` deliberately holds `facts` at `null` and `mail-state.ts`
       * returns `QUIET`, so `SyncBar` renders NOTHING. Nothing anywhere reported it.
       *
       * What the `[]` produced instead is a sentence: `items !== null && connected.length
       * === 0` is **"No mailbox connected yet."**, told to a customer whose three mailboxes
       * are working — and `refresh` is on a 10 s poll, so the false state is rewritten every
       * ten seconds for as long as the outage lasts. Stable, not a flicker.
       *
       * `items` is therefore left ALONE. On a first load it stays `null`, which every reader
       * in this pane already treats as "unknown" (`connectBlock` takes `enabledCount: null`
       * and produces no gate); on a poll it keeps the last list that was actually true, which
       * is a better answer than erasing it. `listFailed` is what stops the "Reading your
       * mailboxes…" line from becoming the new permanent lie, and the reason goes in `error`
       * — the slot this pane already renders with `role="alert"`.
       *
       * The sentence is the SERVER'S. `api-client.ts`'s header is explicit that re-deriving
       * it here is how somebody is told they are out of mailbox slots when the real problem
       * is an unpaid subscription, and an onboarding guard forbids those strings in webapp
       * source outright.
       */
      if (alive.current) { setListFailed(true); setError(messageOf(err)); }
    }
  }, []);

  /**
   * STEP ONE — look at the mailbox and report what is holding it.
   *
   * Reads and writes nothing. The endpoint behind this is refused the ability to write a claim at
   * all (its IMAP handle has no APPEND), so opening this panel cannot make Cloud the organizer of
   * anything — which matters, because the whole point of the panel is to ask a question before a
   * decision.
   */
  const checkOrganizer = useCallback(async (id: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setOrganizer({ id, peek: null });
    try {
      const peek = await mailboxApi.organizer(id);
      if (alive.current) setOrganizer({ id, peek });
    } catch (err) {
      // THE SERVER'S SENTENCE. "The mailbox could not be checked" is a different fact from "nobody
      // holds it", and inventing a sentence here is how the two get merged — which would invite a
      // takeover of a mailbox somebody is actively organizing.
      if (alive.current) { setOrganizer(null); setError(messageOf(err)); }
    }
  }, []);

  /**
   * STEP TWO — record that a human asked for this mailbox.
   *
   * This does not win it. The worker reads the claim on its next pass and decides; if the other
   * install is still renewing and outranks Cloud, this side stands back down and the authorization
   * is spent with it. So the copy says "will start organizing on its next pass" and never "has
   * taken over".
   */
  const confirmTakeover = useCallback(async (id: string): Promise<void> => {
    setError(null);
    try {
      const result = await mailboxApi.organize(id);
      if (!alive.current) return;
      setOrganizer(null);
      setNotice(
        result.outcome === "authorized" ? t("organizerQueued")
          : result.outcome === "already_organizing" ? t("organizerAlready")
            : t("organizerDisconnected"),
      );
      // The row's status changed under us on the authorized path, and only the server knows the
      // new one — a local guess would be a second source of truth for `status`.
      await refresh();
    } catch (err) {
      if (alive.current) { setOrganizer(null); setError(messageOf(err)); }
    }
  }, [refresh, t]);

  /**
   * The server's entitlement verdict, read before anything is typed.
   *
   * A failure sets nothing: `entitlements: null` is UNKNOWN and produces no gate, so a billing
   * endpoint that is down cannot brick mailbox connect. `gateRead` flips either way, because
   * "we asked and could not tell" is a settled answer.
   */
  const loadGate = useCallback(async (): Promise<void> => {
    try {
      const { entitlements, subscription } = await billing.subscription();
      if (alive.current) setGate({ entitlements, subscription });
    } catch {
      if (alive.current) setGate({ entitlements: null, subscription: null });
    } finally {
      if (alive.current) setGateRead(true);
    }
  }, []);

  useEffect(() => {
    if (!apiConfigured()) {
      setItems([]);
      return;
    }
    /* THE ONE READ THAT ASKS FOR COUNTS. Pane open, once — the number this pane exists to show
       is worth one aggregate when somebody opens the screen and worth nothing on a timer. */
    void refresh({ counts: true });
    void (async () => {
      try {
        const { user, scope } = await auth.session();
        if (!alive.current || scope !== "full") return;
        setEmail(user.email);
        // For the persisted-ceremony owner check only — see `StoredDevice.accountId`. The ref is
        // written FIRST so an in-flight `startDeviceFlow` can read it the moment it lands, without
        // waiting for the re-render that `setAccountId` schedules.
        accountIdRef.current = user.accountId;
        setAccountId(user.accountId);
        // `withSpendGate` refuses `POST /mailboxes` for an unproven address before the
        // allowance gate is reached; this is the same fact, one screen earlier.
        setEmailVerified(user.emailVerified);
      } catch {
        /* the ceremony's own error path says so — and an unread session gates nothing */
      }
    })();
    // Whether this deployment can run the Microsoft consent at all. A read of a deployment fact, so
    // once on mount — not on the list poll. A failure leaves `oauthAvailable` false (the button
    // hidden), which is the honest state: a door whose availability we could not confirm must not be
    // shown, exactly as a dormant registration's must not.
    void (async () => {
      try {
        const { available, device: deviceDoor } = await mailboxApi.oauthAvailability();
        if (!alive.current) return;
        setOauthAvailable(available);
        // The device-code door, from the same payload. `?? false` rather than a truthiness read of a
        // possibly-absent field: an older server that predates this key answers without it, and the
        // honest reading of a missing capability is that the deployment does not have it.
        const armed = deviceDoor ?? false;
        setDeviceAvailable(armed);
        /*
         * PICK UP A CEREMONY THIS TAB WAS ALREADY RUNNING. A reload inside the fifteen minutes
         * somebody spends approving a code used to lose the handle and strand the grant; the handle
         * is kept in `sessionStorage` and restored here, after which the ordinary poll loop takes
         * over and re-supplies the code and the URI from the server.
         *
         * Gated on the door still being armed, and only when nothing is already on screen: an
         * operator who unset the variable mid-ceremony should not be handed a code that can no
         * longer be completed.
         */
        /* The resume lives in its own effect below: it needs BOTH the armed flag and the account
           id, and those two land from two independent reads whose order is not guaranteed. */
      } catch {
        /* unreadable ⇒ leave it hidden; a dead config read must not offer a button that 503s */
      }
    })();
  }, [refresh]);

  /**
   * Re-read the entitlement on every return to the list, not only on mount.
   *
   * It is mutable from outside this tab — a Checkout completed in the Subscription pane, a
   * cancellation in Stripe's portal, a webhook landing late — and a stale HARD BLOCK, with the
   * button removed, is the one failure this change must not introduce. `cost: "read"`.
   */
  useEffect(() => {
    if (!apiConfigured() || stage !== "list") return;
    void loadGate();
  }, [stage, loadGate]);

  /**
   * KEEP LOOKING. A mailbox connected seconds ago reports `lastSyncAt: null` until the
   * worker's next cycle — up to a minute — and the first version of this pane read the list
   * once and never again. It said "Not synced yet" and went on saying it, which reads as a
   * dead mailbox rather than a young one.
   *
   * Polling stops when the tab is hidden: this is a settings pane, not a monitor.
   *
   * AND IT NEVER ASKS FOR COUNTS. What this timer exists for is the sync state — a young
   * mailbox's row changing from "No mail yet" to a stamp. `messageCount` is read once, on the
   * mount effect above; `refresh` carries the last one forward so the number stays on screen.
   */
  useEffect(() => {
    if (!apiConfigured()) return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [refresh]);

  /** Ask the worker to re-scan. 202 — nothing is synced when this returns, so the row says so. */
  const resync = (id: string): void => {
    setError(null);
    setQueued((q) => new Set(q).add(id));
    void (async () => {
      try {
        await mailboxApi.resync(id);
        await refresh();
        // …and the shell's strip, which reads the same route on its own slower clock. Without
        // this the row says "Sync queued" while the strip above it is up to thirty seconds
        // behind — two surfaces disagreeing about one mailbox, which is the whole defect.
        refreshMailState();
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        setQueued((q) => { const n = new Set(q); n.delete(id); return n; });
      }
    })();
  };

  /**
   * DISMISS the forwarding-detection notice for one mailbox (mail 0078) — "this mailbox is
   * quiet and I know it". The server answers the fresh DTO; folding it into `items` settles the
   * row at once instead of waiting a poll tick, and the notice never returns for THIS episode
   * (`showInboundQuiet` compares the two instants). The in-flight set only debounces the button
   * — a failure leaves the notice standing with the pane's error line saying why, and the next
   * press asks again.
   */
  const dismissQuiet = (id: string): void => {
    setError(null);
    setDismissingQuiet((q) => new Set(q).add(id));
    void (async () => {
      try {
        const dto = await mailboxApi.dismissInboundQuiet(id);
        if (!alive.current) return;
        setItems((list) => (list === null ? list : list.map((it) => (it.id === dto.id
          // KEEP the fields this response legitimately lacks: the dismissal answer never carries
          // `messageCount` (only `?counts=1` does), and replacing the row wholesale would blank
          // the number until the next mount — absent and 0 are different answers on this wire.
          ? { ...it, ...dto, messageCount: it.messageCount }
          : it))));
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
      } finally {
        if (alive.current) setDismissingQuiet((q) => { const n = new Set(q); n.delete(id); return n; });
      }
    })();
  };

  /**
   * BEGIN the Microsoft consent — one call, then a TOP-LEVEL navigation.
   *
   * `mailboxId` is passed only for a RECONNECT, and only to preselect the account at the consent
   * screen. It does not choose which row the ceremony writes; the address in Microsoft's `id_token`
   * does, and mail 0021's unique index is what makes "the row for that address" a single row.
   *
   * `window.location.assign` and not a `fetch` that follows a redirect: a fetch cannot change the
   * top-level document, Microsoft's consent screen refuses to be framed, and a popup is blocked in
   * the common case. So the server hands back a URL and the browser goes there.
   *
   * A 503 `oauth_unconfigured` renders THE SERVER'S SENTENCE. `api-client.ts`'s header is explicit
   * that re-deriving these here is how somebody is told the wrong thing — and here the wrong thing
   * would be "Microsoft refused you" about a deployment whose operator has not finished pasting a
   * client secret in.
   */
  const startOutlook = (mailboxId?: string): void => {
    setError(null);
    setNotice(null);
    /*
     * WHICH DOOR. The operator's OWN registration wins whenever it is armed, and the reason is not
     * that the redirect flow is nicer: it is theirs. The device flow runs against a client id shared
     * by every install using it, so a throttle or an abuse report against that application is felt
     * by strangers — an operator who has done the work of registering their own application should
     * not be quietly put behind the shared one.
     *
     * `deviceAvailable` alone is the ordinary self-hosted case, and it is the whole reason this
     * branch exists: before it, an install with no Entra registration had no way to connect an
     * Outlook mailbox at all on a tenant where basic authentication is already off.
     */
    if (!oauthAvailable && deviceAvailable) { startDeviceFlow(); return; }
    setOauthBusy("starting");
    void (async () => {
      try {
        const { authorizeUrl } = await mailboxApi.oauthStart({
          ...(mailboxId ? { mailboxId } : {}),
          // Where the ceremony should land. The server validates it as a same-site relative path and
          // ignores anything else, so this is a preference and never a redirect target we control.
          // `/` and not `/mailbox`: the latter is an internal rewrite target that `middleware.ts`
          // 308s back to `/`, so naming it only ever added a redirect hop (see `OAUTH_RETURN_PATH`).
          returnTo: "/",
        });
        if (typeof window !== "undefined") window.location.assign(authorizeUrl);
      } catch (err) {
        if (!alive.current) return;
        setOauthBusy(null);
        setError(messageOf(err));
      }
    })();
  };

  /**
   * THE DEVICE-CODE CEREMONY — no redirect, and the app is never left.
   *
   * What the person does: read a short code off this screen, open a URL on any device they like,
   * type the code, sign in to Microsoft. Their own server does the rest over its own back channel;
   * the tokens are issued straight to it. That is why this is the door for an install that is not
   * `ohmail.app` — there is no redirect URI to register with Microsoft, so nothing has to be, and
   * no stranger's refresh token passes through anybody else's infrastructure.
   *
   * The ceremony survives this component: it is a database row on the operator's server. Navigating
   * away loses the code from the screen (a poll re-supplies it, which is why the server stores the
   * display values) and the grant simply expires on Microsoft's own schedule if nobody finishes it.
   */
  const startDeviceFlow = (): void => {
    setError(null);
    setNotice(null);
    setDeviceEnded(null);
    setDevicePollError(null);
    setOauthBusy("starting");
    void (async () => {
      try {
        const started = await mailboxApi.deviceOAuthStart();
        if (!alive.current) return;
        setOauthBusy(null);
        setOutlookOffer(false);
        const live = {
          state: started.state,
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          expiresAt: Date.parse(started.expiresAt),
          // Stamped with the account that started it, so a later tab-reuse cannot restore it.
          // Empty only when the session read has not landed yet — and in that case NOTHING is
          // written: both persistence paths below refuse an owner they cannot name, so the empty
          // value never reaches storage and `recallDevice` never has to judge one.
          accountId: accountIdRef.current ?? "",
          // The FIRST poll goes out immediately. The server's own fence is what enforces the
          // cadence from there — `last_polled_at` has not been written yet, so this one is allowed,
          // and every later one is scheduled from what the server says it will accept.
          retryAfterMs: 0,
        };
        /*
         * PERSISTED SYNCHRONOUSLY WHEN THE OWNER IS ALREADY KNOWN — the ordinary case.
         *
         * The effect below is the LATE-SESSION path and cannot be the only one: a passive effect
         * runs after the browser has been yielded to, so a reload or an unload in that window would
         * leave the grant live on the server with no handle in this tab — the exact recovery gap the
         * persistence exists to close, reintroduced by moving the write out of here. Found by review
         * on the fix that moved it.
         *
         * Both paths are gated on a real `accountId`, so neither can write the empty owner that the
         * restore would later delete as unowned. Writing twice is harmless — same key, same value.
         */
        const owner = accountIdRef.current;
        if (owner) rememberDevice({ ...live, accountId: owner });
        setDevice(live);
      } catch (err) {
        if (!alive.current) return;
        setOauthBusy(null);
        setError(messageOf(err));
      }
    })();
  };

  /**
   * PERSIST THE LIVE CEREMONY — and ONLY once its owner is actually known.
   *
   * ── WHY THIS IS AN EFFECT AND NOT A LINE IN `startDeviceFlow` ──────────────────────────────
   *
   * The pane makes three independent reads on mount: the mailbox list, the availability capability,
   * and the session. The Outlook affordance is enabled by the second, so a ceremony can legitimately
   * START before the third has landed — and the first version of this stamped whatever `accountId`
   * held at that moment, which was `null`. The restore effect below then read that record back,
   * found an owner it could not match, and DELETED IT — while the in-memory poll loop carried on
   * happily. The ceremony worked, and the reload recovery it exists for was silently gone.
   *
   * Found by review, and it is the third round in a row where the fix for one layer opened the next
   * one down. Writing the record from here closes the family rather than the instance: there is one
   * writer, it runs whenever either fact changes, and it cannot write an owner it does not have.
   */
  useEffect(() => {
    if (!device || !accountId) return;
    rememberDevice({ ...device, accountId });
  }, [device, accountId]);

  /**
   * PICK UP A CEREMONY THIS TAB WAS ALREADY RUNNING — once both facts are known.
   *
   * A reload inside the fifteen minutes somebody spends approving a code used to lose the handle
   * and strand the grant. Two independent reads gate the restore and neither one's arrival order is
   * guaranteed, which is why this is its own effect rather than a line inside one of them:
   *
   *  · the door must still be ARMED — an operator who unset the variable mid-ceremony should not be
   *    handed a code that can no longer be completed;
   *  · the ACCOUNT must be known and must match, or another account's code renders on this pane.
   *
   * `setDevice((cur) => cur ?? resumed)` so a ceremony started by hand in the meantime always wins.
   */
  useEffect(() => {
    if (!deviceAvailable || !accountId) return;
    const resumed = recallDevice(Date.now(), accountId);
    if (resumed) setDevice((cur) => cur ?? resumed);
  }, [deviceAvailable, accountId]);

  /** Put the pane back where it was before a ceremony, without touching the mailbox list. */
  const clearDeviceFlow = (): void => {
    forgetDevice(); setDevice(null); setDeviceEnded(null); setDevicePollError(null);
  };

  /**
   * THE POLL LOOP — one timer, cadence from the SERVER, and it stops on the first terminal answer.
   *
   * ── WHY THE DELAY IS NEVER THIS CLIENT'S CHOICE ────────────────────────────────────────────
   *
   * The interval is Microsoft's, it grows cumulatively when Microsoft says `slow_down` (RFC 8628
   * §3.5), and the application being throttled is SHARED with every other install using the public
   * client. So `retryAfterMs` comes back from each poll and is used verbatim. The server also
   * refuses an early poll outright — atomically, without a request to Microsoft — so polling faster
   * would buy nothing; this is written the honest way round so that the code and the enforcement say
   * the same thing rather than one of them being decoration.
   *
   * ── A `setTimeout` PER POLL, NOT A `setInterval` ───────────────────────────────────────────
   *
   * The delay changes between polls, and a fixed interval would keep the first one for ever — which
   * is precisely the case where Microsoft has asked us to slow down. Each poll schedules the next
   * from the answer it just got, and the effect's cleanup cancels whatever is pending, so a
   * navigation mid-ceremony leaves no timer behind.
   */
  useEffect(() => {
    if (!device) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const poll = async (): Promise<void> => {
      if (stopped || !alive.current) return;
      try {
        const r = await mailboxApi.deviceOAuthPoll({ state: device.state });
        if (stopped || !alive.current) return;
        /*
         * A VALID ANSWER CLEARS THIS LOOP'S OWN PREVIOUS FAILURE — and only its own.
         *
         * The catch below shows the server's "Microsoft could not be reached" sentence, correctly,
         * because a silent pause reads as a hung screen to somebody staring at a code. Nothing used
         * to take it down again, so a ceremony that recovered rendered a red error beside the green
         * "connected" notice.
         *
         * The first fix cleared the PANE-WIDE `error`, which was worse in a quieter way: a failed
         * resync writes that field, and this poll runs every few seconds, so a message about an
         * operation that never recovered would vanish within moments of appearing. A review caught
         * it. The device flow now owns its own line and touches nobody else's.
         */
        setDevicePollError(null);
        if (r.status === "granted") {
          forgetDevice();
          setDevicePollError(null);
          setDevice(null);
          /*
           * THE SAME TWO SENTENCES the redirect ceremony's landing uses, with the address from the
           * stored mailbox — which came from Microsoft's own token and not from anything anybody
           * typed. `created` distinguishes a first connect from a reconnect, and those are different
           * things to somebody who came here to fix a mailbox that had stopped.
           */
          const addr = r.mailbox?.address ?? "";
          setNotice(t(r.created ? "oauthConnected" : "oauthReconnected", { address: addr }));
          await refresh();
          // The shell's strip reads the same route on its own slower clock; without this the new
          // mailbox is on this screen and absent from the one above it for up to thirty seconds.
          refreshMailState();
          return;
        }
        if (r.status === "declined" || r.status === "expired") {
          forgetDevice();
          setDevicePollError(null);
          setDevice(null);
          setDeviceEnded(r.status);
          return;
        }
        // Still pending. Re-arm at the cadence the server just stated. The deadline and the display
        // values come back on every poll, which is what lets a reload re-render the code: the tab
        // keeps only the handle (see `recallDevice`) and this answer supplies the rest.
        const next = typeof r.retryAfterMs === "number" ? Math.max(0, r.retryAfterMs) : device.retryAfterMs;
        timer = setTimeout(() => { void poll(); }, next || DEVICE_POLL_FLOOR_MS);
      } catch (err) {
        if (stopped || !alive.current) return;
        /*
         * A FAILED POLL IS NOT A FAILED CEREMONY, and the loop does not stop on one. The server
         * answers 503 for "Microsoft could not be reached" and says in as many words that the
         * sign-in is still valid; the grant's own expiry is the bound, and it is checked server-side
         * on every poll. So the error is shown — a silent pause here reads as a hung screen to
         * somebody staring at a code — and the loop re-arms on the floor cadence.
         *
         * The one thing that DOES stop it is the ceremony being gone: a 400 `state_invalid` means
         * the row has reached a terminal verdict or been pruned, and re-polling it for fifteen
         * minutes would be asking a question that now has one permanent answer.
         */
        /*
         * WHICH LINE THE MESSAGE GOES ON DEPENDS ON WHETHER THE CEREMONY SURVIVES IT.
         *
         * A TERMINAL refusal — the row reached a verdict, was pruned, or belongs to another account
         * — ends the ceremony, and the block that renders `devicePollError` is inside the ceremony's
         * own markup. Putting the explanation there and then nulling `device` in the same tick meant
         * React unmounted the container and the message with it: the code simply vanished off the
         * screen with nothing said. Found by review, and it is the same mistake as the sticky error
         * one layer over — the right question is not "which field" but "does the surface that shows
         * this field still exist".
         *
         * So a terminal failure goes to the PANE-WIDE error, which outlives the ceremony, and a
         * transient one stays on the ceremony's own line where the loop is still running.
         */
        if (codeOf(err) === "oauth_device_state_invalid" || codeOf(err) === "forbidden") {
          forgetDevice();
          setDevicePollError(null);
          setError(messageOf(err));
          setDevice(null);
          return;
        }
        setDevicePollError(messageOf(err));
        timer = setTimeout(() => { void poll(); }, Math.max(device.retryAfterMs, DEVICE_POLL_FLOOR_MS));
      }
    };

    timer = setTimeout(() => { void poll(); }, device.retryAfterMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // `device.state` identifies the ceremony; `retryAfterMs` is read inside the closure and a
    // change to it does not need to restart the loop (the running poll already scheduled from the
    // value it was given). Re-running on the whole object would cancel a pending poll on every
    // pending answer, which is the loop restarting itself for ever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.state, refresh, refreshMailState, t]);

  /**
   * THE BOUNCE'S LANDING — READ, NOT PERFORMED. This pane no longer runs the ceremony.
   *
   * `oauth-return.ts` does, at module scope, from the query alone, before any of this renders. That
   * is a correction of a production failure and not a refactor: this used to be a mount effect, so a
   * consent that came back to any screen other than Settings → Mailboxes was never completed at all —
   * the browser sat on the Ohbox with an authorization code in the query and a ceremony row that was
   * never consumed. A step that must happen on EVERY landing cannot be owned by a component that
   * mounts on SOME of them.
   *
   * `beginOAuthReturn()` is called here as well as from `CloudShell` because it is idempotent and
   * because this file must not depend on which of its two hosts got there first — a pane rendered by
   * some other shell still finishes what it finds. The second call is a latch read, never a POST.
   */
  const back = useSyncExternalStore(subscribeOAuthOutcome, oauthOutcome, noOAuthOutcome);
  useEffect(() => { beginOAuthReturn(); }, []);

  /**
   * …AND SAY SO. The store carries FACTS; the sentences are this pane's, exactly as they are for
   * every other outcome it renders.
   */
  useEffect(() => {
    if (!back) return;
    if (back.kind === "running") { setError(null); return; }
    if (back.kind === "connected") {
      // `created` distinguishes a first connect from a reconnect, and the two are different things to
      // somebody who came here to fix a mailbox that had stopped.
      setNotice(back.created
        ? t("oauthConnected", { address: displayAddress(back.address) })
        : t("oauthReconnected", { address: displayAddress(back.address) }));
      void refresh();
      // A mailbox that has just been connected is exactly the case the shell's strip exists for, so
      // it must learn now rather than on its next poll.
      refreshMailState();
      return;
    }
    if (back.kind === "refused") {
      const key = OAUTH_REASONS.has(back.reason) ? `oauth_${back.reason}` : "oauth_consent_failed";
      // `consent_declined` is not an alert — the person said no, which is an outcome and not a fault.
      if (back.reason === "consent_declined") setNotice(t(key));
      else setError(t(key));
      return;
    }
    // The server's sentence, as everywhere else in this pane.
    setError(back.message);
  }, [back, refresh, refreshMailState, t]);

  /** The ceremony's final call is in flight — the pane says so, and the doors are shut. */
  const finishing = back?.kind === "running";

  /**
   * The sentence for a refused probe — and, for the two actionable TLS kinds, the side state
   * that changes what the form OFFERS: `tls_unavailable` (IMAP only) unlocks the plaintext
   * opt-in, a `hostname_mismatch` with a suggestion arms the one-press host correction.
   *
   * ABOVE the fail() handler, not below it, and the position is load-bearing:
   * a reachability guard reads the source window from fail()'s declaration to
   * connect()'s and asserts nothing in it resets the typed state — a failure path must never
   * discard what the user typed. applySuggestion's reset is a user-initiated press, not a
   * failure path, so it lives outside that window rather than being granted an exemption.
   * (No declaration-shaped literals in this comment either: the test finds its window with
   * indexOf, and a comment that quotes the anchor verbatim becomes the anchor.)
   */
  const probeErrorCopy = (err: unknown, reason: string): string => {
    const tls = probeTlsOf(err);
    if (!tls || reason !== "tls") return t(`probe_${reason}`);
    const protocol = tls.transport === "smtp" ? "SMTP" : "IMAP";
    if (tls.kind === "tls_unavailable") {
      // The consent checkbox is an IMAP affordance only — there is no plaintext SMTP flow.
      if (tls.transport === "imap") setInsecureOffer(true);
      return t("probe_tls_unavailable", { protocol });
    }
    if (tls.kind === "hostname_mismatch" && tls.certHost && tls.expectedHost) {
      if (tls.suggestedHost) {
        setSuggestion({ host: tls.suggestedHost, transport: tls.transport });
        return t("probe_tls_hostname_suggest", {
          certHost: tls.certHost, expectedHost: tls.expectedHost,
          suggestedHost: tls.suggestedHost, protocol,
        });
      }
      return t("probe_tls_hostname", { certHost: tls.certHost, expectedHost: tls.expectedHost, protocol });
    }
    const keys: Record<string, string> = {
      expired: "probe_tls_expired", not_yet_valid: "probe_tls_not_yet_valid",
      self_signed: "probe_tls_self_signed", untrusted: "probe_tls_untrusted",
    };
    const key = keys[tls.kind];
    return key ? t(key) : t("probe_tls");
  };

  /**
   * Apply a canonical-host suggestion to the CONNECT form. The failing transport's field always
   * moves; the other one moves with it exactly when the two current values are the same vanity
   * pair (see {@link sameVanityParent}) — one press fixes `mail.…`/`smtp.…` together, which is
   * the shape provider-hosted custom domains almost always take.
   */
  const applySuggestion = (): void => {
    const s = suggestion;
    if (!s) return;
    setTyped((v) => {
      const both = sameVanityParent(v.imapHost, v.smtpHost);
      return {
        ...v,
        imapHost: s.transport === "imap" || both ? s.host : v.imapHost,
        smtpHost: s.transport === "smtp" || both ? s.host : v.smtpHost,
      };
    });
    setSuggestion(null);
    setError(null);
    // IT REWRITES A HOST, so it clears the verdict like every other write to one. This press can
    // change BOTH hosts at once (the vanity pair), which is exactly the case where a green tick
    // for the old IMAP host is most likely to be left standing over a new one.
    clearVerdict();
  };

  const fail = (err: unknown): void => {
    if (!alive.current) return;
    setError(messageOf(err));
    // The window closed mid-ceremony. Back to the FACTOR step, with the typed credentials
    // still in state — the one thing this pane exists to stop losing.
    if (codeOf(err) === "step_up_required") {
      setStage("password");
      setChallenge(null);
    }
    setBusy(false);
  };

  /** The last step, reached only from a verified second factor. */
  const connect = async (): Promise<void> => {
    // The form cannot be submitted without a provider, so this guard is structural —
    // it exists so the ceremony can never post a mailbox nobody described.
    const chosen = typed.provider;
    if (!chosen) {
      setStage("form");
      return;
    }
    setStage("saving");
    try {
      const address = typed.address.trim();
      await mailboxApi.create({
        provider: chosen.id,
        address,
        imap: {
          host: typed.imapHost.trim(),
          // A MANUAL provider sends no port/TLS mode: their absence asks the server's probe to
          // walk the standard ladder (993 implicit TLS, then 143 STARTTLS) and store what it
          // proved. Presets keep their known pair — nothing to detect there.
          ...(chosen.manual ? {} : { port: chosen.imap.port, secure: chosen.imap.secure }),
          user: typed.user.trim() || address, pass: typed.pass,
          // Only ever true after the server itself reported `tls_unavailable` (the checkbox
          // renders in no other state), and re-verified server-side before it is honored.
          ...(typed.allowInsecure ? { allowInsecure: true } : {}),
        },
        smtp: {
          host: typed.smtpHost.trim(),
          ...(chosen.manual ? {} : { port: chosen.smtp.port, secure: chosen.smtp.secure }),
          user: typed.user.trim() || address, pass: typed.pass,
        },
      });
      if (!alive.current) return;
      // The password leaves this component the moment the server has it.
      setTyped(emptyTyped());
      setPassword("");
      setChallenge(null);
      setError(null);
      setInsecureOffer(false);
      setSuggestion(null);
      // AND THE VERDICT GOES WITH THE FORM IT DESCRIBED. Without this a successful connect left
      // the tick standing, so reopening Connect later rendered it over an EMPTY form — a green
      // verdict about a mailbox that is already connected, presented as evidence about a mailbox
      // nobody has typed yet.
      clearVerdict();
      setStage("list");
      await refresh();
      // A mailbox that has just been connected is exactly the case the account strip exists for, so it
      // must learn about it now rather than on its next poll — otherwise the first thing a new
      // customer sees after the ceremony is a shell that still believes they have none.
      refreshMailState();
    } catch (err) {
      if (!alive.current) return;
      // A refused probe sends the user back to the FORM, not to the factor step.
      //
      // Everything else `connect()` can fail with is about the account (a spent step-up, an
      // entitlement, a duplicate); the factor step is a sensible place to stand for those. A probe
      // refusal is about the four fields that were typed, and the factor step has no way to change
      // them — its own escape hatch goes back only as far as the password. Leaving somebody there
      // with "check the IMAP host" is a dead end: the login token is single-use and spent, so the
      // one thing they can do is the one thing that screen cannot offer.
      //
      // `typed` is untouched, so the form comes back with the host and password still in it and
      // the correction is a keystroke. The ceremony does have to run again — the token is spent —
      // and that is the honest cost of having changed the credentials.
      const reason = probeReasonOf(err);
      if (reason) {
        setStage("form");
        setChallenge(null);
        setPassword("");
        setError(probeErrorCopy(err, reason));
        setBusy(false);
        return;
      }
      setStage("factor");
      fail(err);
    }
  };

  /**
   * The last step of an EDIT, reached only from a verified second factor — the PATCH sibling of
   * {@link connect}.
   *
   * ── A REFUSED PROBE LEAVES THE EXISTING MAILBOX RUNNING ──────────────────────────────────────
   *
   * This is the whole point of the flow and the reason it goes through the probe at all. The
   * server tries the new credentials BEFORE it stores them, so a wrong password (or a mistyped
   * host) is answered `mailbox_probe_failed` and NOTHING is written: the stored credential is left
   * in place, the mailbox's status is untouched, and the worker keeps organizing it on its stored
   * login. So a refusal returns to the EDIT form — the fields the user can correct are there and
   * `edited` still holds them — never to a state that has stood the mailbox down. Same shape as a
   * refused connect probe, one door over.
   */
  const saveEdit = async (): Promise<void> => {
    const target = editing;
    // Structural, like `connect`'s provider guard: the ceremony cannot be entered without a
    // mailbox to edit, so this only ever fires if the flow was left in an impossible state.
    if (!target) {
      setStage("list");
      return;
    }
    setStage("saving");
    try {
      // The `smtp` block only when an SMTP field was typed — see {@link smtpPatchOf}.
      const smtp = smtpPatchOf(edited);
      await mailboxApi.update(target.id, { imap: imapPatchOf(edited), ...(smtp ? { smtp } : {}) });
      if (!alive.current) return;
      // The password leaves this component the moment the server has it.
      setEdited(emptyEdit());
      setEditing(null);
      setPassword("");
      setChallenge(null);
      setError(null);
      setInsecureOffer(false);
      setSuggestion(null);
      setStage("list");
      await refresh();
      // The stored credential just changed, so a mailbox that was quarantined may recover on the
      // worker's next pass — the strip reads the same route and should not stay a poll behind.
      refreshMailState();
    } catch (err) {
      if (!alive.current) return;
      const reason = probeReasonOf(err);
      if (reason) {
        // Back to the EDIT form, not the factor step: the factor screen cannot change a host or a
        // password, and the login token is spent, so standing there with "check the IMAP host"
        // would be a dead end. `edited` is untouched, so the correction is a keystroke.
        setStage("edit");
        setChallenge(null);
        setPassword("");
        setError(probeErrorCopy(err, reason));
        setBusy(false);
        return;
      }
      setStage("factor");
      fail(err);
    }
  };

  /**
   * REMOVE THE MAILBOX — reached only from a verified second factor, like every other write here.
   *
   * The server does the whole of it in one transaction: the row goes `disabled` with its lease and
   * sync columns cleared, the credential rows are deleted, and the pending scheduled sends are
   * closed with a sentence. Nothing here reaches the IMAP mailbox, which is the claim the
   * confirmation makes.
   *
   * A failure returns to the CONFIRMATION rather than to the list, for `saveEdit`'s reason: the
   * person is mid-decision, and dropping them back to a list that still shows the mailbox says
   * nothing about whether the removal happened.
   */
  const removeMailbox = async (): Promise<void> => {
    const target = removing;
    if (!target) {
      setStage("list");
      return;
    }
    setStage("saving");
    try {
      await mailboxApi.remove(target.id);
      if (!alive.current) return;
      setRemoving(null);
      setPassword("");
      setChallenge(null);
      setError(null);
      setStage("list");
      await refresh();
      // The rail's strip reads the same route on its own slower clock; without this the pane and
      // the strip disagree about this mailbox for up to thirty seconds.
      refreshMailState();
    } catch (err) {
      if (!alive.current) return;
      setStage("remove");
      fail(err);
    }
  };

  /** Which write the verified factor makes. A removal DELETEs, an edit PATCHes, else it creates. */
  const finishCeremony = (): Promise<void> =>
    (removing ? removeMailbox() : editing ? saveEdit() : connect());

  const submitPassword = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const out = await auth.login({ email, password });
        setPassword("");
        if (out.status === "enrollment") {
          setNoFactor(true);
          setBusy(false);
          return;
        }
        setChallenge(out);
        setMethod(
          out.methods.includes("webauthn") && webauthnAvailable() ? "webauthn"
            : out.methods.includes("totp") ? "totp" : out.methods[0]!,
        );
        setStage("factor");
        setBusy(false);
      } catch (err) {
        fail(err);
      }
    })();
  };

  const finishWithPasskey = (): void => {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const { options } = await auth.webauthnAssertOptions({ loginToken: challenge.loginToken });
        const credential = await assertPasskey(options);
        await auth.webauthnAssertVerify({ loginToken: challenge.loginToken, credential });
        await finishCeremony();
      } catch (err) {
        fail(err);
      }
    })();
  };

  const finishWithCode = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (method === "recovery_code") {
          await auth.recoveryVerify({ loginToken: challenge.loginToken, code: code.trim() });
        } else {
          await auth.totpVerify({ loginToken: challenge.loginToken, code: code.trim() });
        }
        setCode("");
        await finishCeremony();
      } catch (err) {
        fail(err);
      }
    })();
  };

  const pickProvider = (id: string): void => {
    const p = providerById(id);
    // `hostsFor`, not the preset's hosts directly: the generic entry has none, and writing its
    // emptiness over a typed host is how the connect form used to lose one. See `providers.ts`.
    setTyped((v) => ({ ...v, provider: p, ...hostsFor(p, v, v.provider) }));
    // A fresh choice re-offers the default path for whatever was picked — the Microsoft tile means
    // sign-in first, never the app-password fields a previous visit may have revealed.
    setMsAppPassword(false);
    // AND THE VERDICT GOES WITH IT. A provider change changes which server would be dialled, so a
    // green tick from the previous choice is evidence about a different host entirely.
    clearVerdict();
    // SO DOES THE PLAINTEXT OPT-IN. It is a consent about ONE server that reported no TLS at all,
    // and carrying it into a different provider's attempt would offer that server the same
    // exemption on evidence gathered about somebody else's. The checkbox only reappears when a
    // server reports `tls_unavailable` again.
    setTyped((v) => ({ ...v, allowInsecure: false }));
  };

  /** Open the edit form for one mailbox. Starts empty — the stored settings are not on the wire. */
  const startEdit = (m: MailboxDTO): void => {
    setError(null);
    setNotice(null);
    setOrganizer(null);
    setOutlookOffer(false);
    setEditing(m);
    setEdited(emptyEdit());
    setStage("edit");
  };

  // ── The states that are not the form ──────────────────────────────────────────────────

  if (!apiConfigured()) {
    return <SettingsSection><p className="acct-lead">{t("unavailable")}</p></SettingsSection>;
  }
  if (noFactor) {
    return (
      <SettingsSection>
        <h2 className="acct-h">{t("noFactorTitle")}</h2>
        <p className="acct-lead">{t("noFactorBody")}</p>
      </SettingsSection>
    );
  }

  const connected = items ?? [];
  /**
   * "The mirror is growing" is an ACCOUNT-wide fact; a row is about ONE mailbox. With exactly
   * one live mailbox the two coincide and the row may say "Syncing now". With two it may not —
   * the growth could be entirely the other one's — so the row falls back to what it can prove
   * per mailbox and the strip carries the account sentence. Stating the limit rather than
   * quietly attributing.
   */
  const importingSole =
    mailState.key === "importing"
    && connected.filter((m) => m.status !== "disabled").length === 1;

  /**
   * `items === null` means the list has not arrived, and an unknown count must not be
   * read as zero — that would offer a connect to an account that is already full.
   */
  const block = connectBlock({
    emailVerified,
    entitlements: gate.entitlements,
    subscription: gate.subscription,
    enabledCount: items === null ? null : items.filter((m) => m.status !== "disabled").length,
  });

  /**
   * THE MICROSOFT TILE CONNECTS BY SIGN-IN, on a deployment whose Entra registration is armed.
   *
   * Picking it and pressing Continue enters the SAME consent ceremony the standalone "Connect
   * Outlook" button starts — no address, no host, no password, because Microsoft states the address
   * in the token it issues. The app-password fields are the SECONDARY path, for a work tenant that
   * blocks the sign-in, reached by an explicit "use an app password instead". When NEITHER door is
   * armed the tile falls back to the app-password form as before, because that path needs no
   * server-side registration.
   *
   * EITHER door counts. Which ceremony `startOutlook` then runs — the redirect, or the device code —
   * is the server's configuration and not something this tile has an opinion about; what matters
   * here is the one thing this predicate decides, which is whether Continue asks for a password.
   * Gating on the redirect flow alone would have shown an app-password form as the only way in on
   * exactly the installs where the device flow is the only way in.
   */
  const microsoftOauth =
    typed.provider?.id === "microsoft" && (oauthAvailable || deviceAvailable) && !msAppPassword;

  /* ── TEST CONNECTION ──────────────────────────────────────────────────────────────────────
   *
   * This form had no way to check a mailbox's login before storing it, and `POST /mailboxes/probe`
   * shipped with no caller at all. This block is that caller, and it is worth more
   * here than anywhere else in the product because of what stands between this form and a stored
   * mailbox: "Continue" leads to the ACCOUNT password and a step-up ceremony. Somebody who has
   * mistyped a host or pasted the wrong app password used to discover it only after paying that
   * ceremony, and the refusal arrives with the mailbox credentials still in a form they then have
   * to re-approach. One press, before any of it, answers the question the ceremony is for.
   *
   * IT WRITES NOTHING. No mailbox row, no credential, no folder — the endpoint opens one
   * connection, signs in, lists, and hangs up. The verdict says so, which is the whole reason it
   * can be offered before consent to store anything.
   *
   * THE SENTENCES ARE ALREADY WRITTEN. Failures are the fourteen `probe_*` lines this pane
   * already renders for a refused CREATE — the service throws the same refusal on both paths, so
   * one vocabulary covers them. Success is the flow's `probeOk`, reused rather than duplicated:
   * two spellings of "the server answered, signed in, N folders" is how one of them ends up
   * describing a different number.
   */
  const [probing, setProbing] = useState(false);
  /**
   * WHICH TEST IS THE NEWEST — the generation guard, and it is not defensive spelling.
   *
   * Clearing the verdict when a field changes is only half the rule. The other half is that a
   * test ALREADY IN FLIGHT resolves later, and its `setProbeOk` does not know the form has moved:
   * start a test against A, edit the host to B (the verdict clears, correctly), A's answer lands,
   * and A's green tick is now sitting over B. The clear made it worse rather than better, because
   * the tick reappears with nothing on screen having been pressed.
   *
   * So every landing checks that it is still the newest request. `appliedSeq`'s discipline, from
   * `consent-state.ts`, applied to a press instead of a poll.
   */
  const probeSeq = useRef(0);
  /**
   * ANY CHANGE TO A PROBED FIELD CLEARS THE VERDICT.
   *
   * A green tick describes ONE configuration — this host, this identity, this password. Edit any
   * of them and it describes a configuration that is no longer in the form, and the person is
   * looking at evidence for something they are not about to submit. The endpoint re-proves
   * everything before anything is stored, so nothing unproved can be written either way; what is
   * at stake is the SENTENCE on screen, which would be about a different mailbox than the one the
   * next press creates.
   *
   * The flow's own step 1 clears on the same rule and additionally gates its primary on the
   * verdict; this form's primary leads to a step-up ceremony rather than straight to a write, so
   * here the verdict informs rather than authorises — but it still may not be stale.
   */
  const clearVerdict = useCallback(() => {
    /* IT RETIRES THE REQUEST, not just the sentence — and believing the generation counter alone
       did that was the defect a third review round found in the second round's fix. Advancing the
       sequence only when a test STARTS orders concurrent presses and nothing else: press Test for
       A, edit a field to B while it is pending, and A's answer still carries the current
       generation, so it lands over B. The edit has to advance the sequence, which is what makes it
       invalidate a request rather than merely blank the screen.

       `setProbing(false)` with it: the request is no longer ours, so the pending line must stop
       claiming it and the button must come back. */
    probeSeq.current += 1;
    setProbeOk(null);
    setProbeBad(null);
    setProbing(false);
  }, []);
  const [probeOk, setProbeOk] = useState<{ host: string; user: string; folders: number | null } | null>(null);
  const [probeBad, setProbeBad] = useState<{ reason: string | null; message: string } | null>(null);
  /** Enough typed to ask the question at all — the same three fields the endpoint requires. */
  const canProbe = Boolean(typed.provider && typed.address.trim() && typed.pass);
  /**
   * THE OAUTH DOOR OPENING UNDER A RUNNING TEST RETIRES IT.
   *
   * `microsoftOauth` depends on a capability read that resolves after mount, so it can become true
   * while somebody is part-way through the app-password path they were correctly offered a moment
   * earlier. When it does, "Continue" stops being a password step and becomes the consent
   * ceremony — a different act entirely — so any verdict about the password, settled or still in
   * flight, is about a path nobody is taking any more.
   */
  useEffect(() => {
    if (microsoftOauth) clearVerdict();
  }, [microsoftOauth, clearVerdict]);

  const runProbe = useCallback(async () => {
    if (!typed.provider) return;
    const mine = ++probeSeq.current;
    setProbing(true);
    setProbeOk(null);
    setProbeBad(null);
    try {
      const address = typed.address.trim();
      /* ── THE TEST MUST DIAL WHAT THE CREATE WOULD DIAL, FIELD FOR FIELD ────────────────────
       *
       * Mirrors the `imap` block of `connect()` below EXACTLY, and the manual arm is the reason
       * this is spelled out rather than approximated. A manual provider sends NO port and NO TLS
       * mode: their absence is what asks the server to walk the standard ladder (993 implicit
       * TLS, then 143 STARTTLS) and keep whichever rung answered. Sending the generic preset's
       * nominal 993/TLS instead would pin the test to one rung — so a server that speaks only
       * STARTTLS on 143 would fail the test and then be accepted by the create on the very next
       * press. A test that disagrees with the thing it is testing is worse than no test.
       *
       * The username is defaulted here for the same reason: the service defaults an absent one to
       * the address, and the create sends it explicitly, so both must land on one string. */
      const chosen = typed.provider;
      const r = await mailboxApi.probe({
        address,
        imap: {
          host: (typed.imapHost || chosen.imap.host).trim(),
          ...(chosen.manual ? {} : { port: chosen.imap.port, secure: chosen.imap.secure }),
          user: typed.user.trim() || address,
          pass: typed.pass,
          /* THE PLAINTEXT OPT-IN RIDES THE TEST TOO. The create sends it, and it is the one field
             that changes whether a server with no TLS is acceptable at all — so a test that
             omitted it would refuse exactly the configuration the next press is about to store.
             It is only ever true after the server itself reported `tls_unavailable`. */
          ...(typed.allowInsecure ? { allowInsecure: true } : {}),
        },
      });
      if (probeSeq.current !== mine) return;
      setProbeOk(r);
    } catch (err) {
      if (probeSeq.current !== mine) return;
      setProbeBad({ reason: probeReasonOf(err), message: messageOf(err) });
    } finally {
      // The BUSY flag is the newest request's alone as well, or an overtaken test would leave the
      // button enabled while a later one is still running.
      if (probeSeq.current === mine) setProbing(false);
    }
  }, [typed]);

  return (
    <SettingsSection>
      {/* THE MODE THIS PANE IS SHOWING. An install is Cloud OR local, never both in parallel
          (desktop is per-install, not per-mailbox), so the pane names which one
          it is rather than leaving the reader to infer it from the connect ceremony below. The
          desktop's own pane heads itself "Local mailboxes on this computer" for the same reason. */}
      <h2 className="acct-h">{t("modeCloud")}</h2>
      {/* A failed read is not an empty result — "Reading your mailboxes…" is only true while a read is outstanding. A
          read that came back refused is not still running, and saying it is would trade one
          permanent false sentence for another. The reason renders below, in `error`. */}
      {items === null && !listFailed ? <p className="acct-lead">{t("loading")}</p> : null}

      {items !== null && connected.length === 0 && stage === "list" ? (
        <p className="acct-lead">{t("noneYet")}</p>
      ) : null}

      {/* ONE ROW PER ADDRESS. See `groupByAddress` for why a second row exists at all and
          why a disabled row with no live sibling still gets one of its own. */}
      {groupByAddress(connected).map(({ shown: m, superseded }) => {
        const stamp = m.lastSyncAt ? agoStamp(m.lastSyncAt, now) : null;
        /* WHY THIS MAILBOX IS DISABLED, when the ORGANIZER LEASE decided it and not a person
           (mail 0027). Null for every ordinary disconnect, which is the distinction the whole
           branch turns on: a mailbox the user removed has no explanation to offer and must not
           be handed one. `standDownToken` maps an unrecognised member onto the `:unknown`
           sentence rather than onto silence — the server narrows it too, and this is the half
           that survives a client older than the server. */
        const standDown = m.status === "disabled" ? standDownToken(m.disabledReason ?? null) : null;
        return (
          <div className="mbx-row" key={m.id}>
            <div className="mbx-main">
              {/* `title` carries the full address because the CSS ellipsizes rather than wraps:
                  a long address used to break mid-word ("…@examp / le-company.ch") and shove the
                  row's buttons into a cramped second column. The truncated form is recoverable
                  on hover; the buttons' column never moves. See `.mbx-addr` in app.css. */}
              {/* Both the row and the hover title read the address the way its owner wrote it —
                  `displayAddress` decodes an internationalized domain's `xn--` labels
                  (`shell/idn.ts`). `m.address` itself is untouched everywhere it is USED: the
                  edit form, `addressKey`'s collapse, the connect ceremony. */}
              <span className="mbx-addr" title={displayAddress(m.address)}>{displayAddress(m.address)}</span>
              {/* ── HOW MUCH MAIL IS IN HERE, IN THE ROW'S EXISTING META LINE ───────────────
                  It was asked for by name, and the row had every fact about a mailbox except this
                  one. It joins the provider and the status rather than taking an element of its
                  own: it is the same KIND of statement — a quiet, unchanging fact about the
                  mailbox — and the column to the right is reserved for what is happening NOW
                  (a stamp, a spinner, a failure), which this is not.

                  `typeof === "number"`, and the guard is the whole contract. The field is
                  present only on the response to `?counts=1`, which is the mount's read; the
                  10-second poll gets a response without it. Reading an absent field as `0`
                  would put "0 messages" on a full mailbox every time a poll landed, and the
                  optionality exists precisely for the case where we do not know. Absent renders
                  nothing; `0` renders "0 messages", because an empty mailbox has an answer.

                  Shown for a `disabled` row too, unlike everything else on this card that is
                  gated on status. It is not a claim about syncing — it is how much of this
                  mailbox's mail ohmail holds — so a disconnected mailbox reporting its size
                  contradicts nothing beside it. */}
              <span className="mbx-sub">
                {providerLabel(providerById(m.provider), tp)} · {t(statusKey(m))}
                {typeof m.messageCount === "number"
                  ? ` · ${t("messageCount", { count: m.messageCount })}`
                  : null}
              </span>
              {/* The dead row, as a footnote instead of a peer. Deliberately says nothing about
                  WHY the earlier one stopped: something else is organizing this address now, so
                  that reason is history, and repeating it would put two contradictory
                  explanations on one card — which is the defect, not the fix. */}
              {superseded > 0 ? <span className="mbx-sub">{t("superseded")}</span> : null}
              {/* ── WHY, AND THE ONE ACTION THERE IS ─────────────────────────────────────────
                  This block used to end at the two sentences and say, in a comment, that there
                  must never be a takeover control here because nothing in the Cloud tier wrote
                  `takeover_authorized_at`. That is no longer true — `MailboxService.organizeHere`
                  does — so the copy that told people to go and delete a message out of their own
                  `ohmail/_meta` folder by hand has gone with it.

                  TWO STEPS, and the first one is not a formality. The stored reason records what
                  was true at the moment Cloud stood down, and nothing has re-read the mailbox
                  since; a card cannot know whether that install is still running. So the check
                  opens one short-lived connection, reads the claim, and reports what is there —
                  and only then is anybody asked to decide. Confirming writes an authorization and
                  nothing else: the worker reads the claim again on its next pass and decides. */}
              {standDown ? (
                <>
                  <span className="mbx-bad">{t(`standDown_${standDown}`)}</span>
                  {organizer?.id === m.id ? (
                    <OrganizerPanel
                      state={organizer}
                      t={t}
                      now={now}
                      onCancel={() => { setOrganizer(null); }}
                      onConfirm={() => { void confirmTakeover(m.id); }}
                    />
                  ) : (
                    <>
                      <span className="mbx-sub">{t("standDownHow")}</span>
                      <Button
                        className="mbx-btn"
                        onClick={() => { void checkOrganizer(m.id); }}
                        disabled={organizer !== null}
                      >
                        {t("organizerCheck")}
                      </Button>
                    </>
                  )}
                </>
              ) : null}
              {/* ── THE FORWARDING-DETECTION NOTICE (mail 0078) ──────────────────────────────
                  A quiet, dismissible fact about a HEALTHY row: the worker judged this mailbox
                  to have received essentially nothing for a generous window while syncing fine —
                  the shape a provider-level forward without "keep a copy" leaves, which once
                  cost two days of debugging pointed at ohmail when the answer was upstream.
                  `showInboundQuiet` (exported above, bitten by the suite) carries the whole
                  gate: health on screen, and the dismissal-vs-episode comparison that makes a
                  dismissal durable until genuine inbound actually flows again. `mbx-sub`, not
                  `mbx-bad`: nothing is broken, and alarm styling would make the first sentence
                  a lie. Two keys because "the last mail came {when}" is false for a mailbox
                  that never received any — the pass stamps `createdAt` there, and the DTO's own
                  `createdAt` tells the two apart by identity. */}
              {showInboundQuiet(m, now) ? (
                <>
                  <span className="mbx-sub">
                    {m.createdAt && m.inboundQuietSince === m.createdAt
                      ? t("inboundQuietNever")
                      : t("inboundQuiet", { when: agoStamp(m.inboundQuietSince!, now).rel })}
                  </span>
                  <Button
                    className="mbx-btn"
                    onClick={() => { dismissQuiet(m.id); }}
                    disabled={dismissingQuiet.has(m.id)}
                  >
                    {t("inboundQuietDismiss")}
                  </Button>
                </>
              ) : null}
            </div>
            <div className="mbx-state">
              {/* ── THE ROW'S STATES, AND WHY "Waiting for first sync" IS GONE ─────────────
                  This read `status === 'connected' && lastSyncAt === null` and said "Waiting
                  for first sync" — ONE sentence for every state a first sync can be in.
                  Measured on a live account: it sat on this row for half an hour while the
                  first import poured messages in, and it was still on it once mail had
                  already landed. Two reasons, both in the column:

                   · `last_sync_at` is stamped for every mailbox a cycle served in ONE
                     `UPDATE … WHERE id IN (…)` (`apps/worker/src/mailboxes.ts`), which is why
                     two rows can report an identical age to the second; and
                   · it is pushed even when the cycle ended with `hasBacklog` true
                     (`apps/worker/src/index.ts:1281`), so it lands EARLY mid-import — which
                     means the `syncedAgo` branch below would otherwise say "Synced just now"
                     thirty seconds into a thirty-minute import.

                  So the row decides nothing about progress any more. It renders what is
                  strictly PER-MAILBOX — error, block, queued, connected-at — and the
                  account-wide "the mirror is growing" answer comes from the single derivation
                  in the shell (`shell/mail-state.ts`), which this pane reads and never
                  re-derives. */}
              {m.status === "disabled" ? null : m.status === "error" ? (
                /* ── A DISCONNECTED MAILBOX REPORTS NO PROGRESS. FIRST, SO IT CANNOT BE
                   OUTVOTED ──────────────────────────────────────────────────────────────────
                   Without this arm a `disabled` row matched none of the branches below and fell
                   all the way through to `stamp === null`, which turned a spinner and said
                   **"No mail yet — added 3 minutes ago"** about a mailbox nothing will ever sync
                   — observed live, four words to the right of the word
                   "disconnected" on the same card.
                   `null` and not a sentence: `.mbx-main` already carries the status and, for a
                   stand-down, the reason and what to do. A second phrase over here would be the
                   third statement about one mailbox, which is the shape of the defect itself.
                   FIRST in the chain, ahead of the block branch, because `MailboxService.delete`
                   is a soft delete: a mailbox that was sync-blocked when the user disconnected it
                   would otherwise report the old block on its tombstone. That is now also fixed
                   at the write, and this ordering is what makes the row right regardless. */
                /* WHY, not just THAT. `mailboxes.error_code` (mail 0023) is a stable key the
                   server never renders into a sentence, so the wording lives here and stays
                   translatable. `errorDetail` is an allowlisted diagnostic token — a response
                   code, an errno, an SQLSTATE, never a message — and belongs in the tooltip
                   beside how long this has been going on, not in the label. */
                <span className="mbx-bad" title={errorTitle(m, now, t)}>
                  {t(m.errorCode ? `err_${m.errorCode}` : "syncError")}
                </span>
              ) : m.syncBlockedSince ? (
                /* THE SYNC-BLOCK PROJECTION'S UI HALF, on the row. `status` IS `connected` and all four `error*`
                   columns are null — that asymmetry is mail 0029's entire design — so without
                   this branch the row says "Synced 4 minutes ago" about a mailbox nothing is
                   syncing. The wording is `sync.blocked_*`, shared with the shell's strip: one
                   owner of the closed set, so two surfaces cannot describe the same refusal
                   differently. A reason this build does not recognise still gets a sentence.

                   GATED ON `syncBlockedSince`, NOT ON THE REASON. `mailbox-service.ts:526`
                   narrows the reason to the closed set and forwards the timestamp unconditionally,
                   so a newer worker's fourth reason arrives here as `{reason: null, since: <ts>}`.
                   Gating on the reason sent that row back to "Synced 4 minutes ago" — the defect,
                   restored by version skew. `blockedUnknown` below is the copy for it. */
                <span className="mbx-bad">
                  {isSyncBlockReason(m.syncBlockedReason)
                    ? ts(`blocked_${m.syncBlockedReason}`)
                    : ts("blockedUnknown")}
                </span>
              ) : queued.has(m.id) ? (
                <span className="mbx-wait">
                  <span className="mbx-spin" aria-hidden="true" />
                  {t("syncQueued")}
                </span>
              ) : importingSole ? (
                /* THE MIRROR IS GROWING — and with exactly one live mailbox the attribution is
                   certain, so this row may say so. With two it may NOT: the growth could be
                   entirely the other mailbox's, and the strip above carries the account-wide
                   sentence instead. Deliberately count-free — the strip has the number, and the
                   same sentence twice on one screen is noise. */
                <span className="mbx-wait">
                  <span className="mbx-spin" aria-hidden="true" />
                  {t("syncRunning")}
                </span>
              ) : stamp === null ? (
                /* No cycle has completed for THIS mailbox and the mirror is not growing. The
                   honest replacement for the dead string: it says HOW LONG, from `createdAt` —
                   the one per-mailbox clock the shared `UPDATE` does not touch — so it cannot
                   be four words that never change for half an hour. */
                <span className="mbx-wait">
                  <span className="mbx-spin" aria-hidden="true" />
                  {t("syncFirstPending", {
                    when: m.createdAt ? agoStamp(m.createdAt, now).rel : AGO_COPY.justNow,
                  })}
                </span>
              ) : (
                <span className="mbx-ok" title={stamp.abs}>{t("syncedAgo", { when: stamp.rel })}</span>
              )}
              {m.status === "disabled" ? null : (
                <>
                  <Button
                    className="mbx-btn"
                    onClick={() => resync(m.id)}
                    disabled={queued.has(m.id)}
                  >
                    {t("syncNow")}
                  </Button>
                  {/* THE RECONNECT CTA FOR AN OAUTH MAILBOX, and it REPLACES the edit button rather
                      than sitting beside it.
                      There is nothing to type. An oauth mailbox's only credential is a refresh token
                      Microsoft issued, and when it dies (`error_code: 'auth'`, `error_detail:
                      'OAUTH_INVALID_GRANT'`) the fix is a fresh consent — not a password form. Showing
                      "Edit" here would offer a screen whose every field is meaningless for this row,
                      and whose PATCH would store a typed password beside an `authType: "oauth2"` meta
                      that `buildImapAuth` then refuses to dial with.
                      The ceremony lands on the SAME row: the address comes from the `id_token` and
                      mail 0021's unique index makes at most one live mailbox per address, so
                      re-consenting cannot produce a duplicate. */}
                  {m.authKind === "oauth" ? (
                    /* GATED ON `oauthAvailable` for the same reason the Connect door is: if the
                       deployment's registration has been disabled or lapsed, the consent cannot run,
                       and a "Reconnect Microsoft" button would 503. An oauth row has no password to
                       fall back to (that is the whole point of the branch), so when the door is shut
                       there is nothing actionable here — the row still shows its status and "Sync
                       now", and reconnect returns the moment the operator re-arms the registration. */
                    /* …and `deviceAvailable` counts as an armed door too. An install with only the
                       device flow can reconnect exactly as well: the address comes from the token
                       either way, so the fresh consent lands on this same row. Withholding
                       reconnect there would leave the one mailbox that CANNOT be fixed with a
                       password form with nothing actionable at all. */
                    oauthAvailable || deviceAvailable ? (
                      <Button
                        className="mbx-btn"
                        onClick={() => startOutlook(m.id)}
                        disabled={oauthBusy !== null || finishing || device !== null}
                      >
                        {oauthBusy === "starting" ? t("working") : t("oauthReconnect")}
                      </Button>
                    ) : null
                  ) : (
                    /* The reconnect/rotate door for a PASSWORD mailbox. Offered on every live row,
                       including an `error` one — a mailbox quarantined for a rejected password is
                       exactly the one whose credentials need re-entering. */
                    <Button className="mbx-btn" onClick={() => startEdit(m)}>
                      {t("edit")}
                    </Button>
                  )}
                  {/* REMOVE — the door out, and until now there was none on any surface. The
                      route has been served since the mailbox surface was built and no client
                      ever called it, so the only way to disconnect a mailbox was to ask
                      somebody with database access.

                      It opens a CONFIRMATION, never the removal: the press that destroys a
                      stored credential is two screens away, behind the account's own second
                      factor, which is the same gate connecting a mailbox passes. */}
                  <Button
                    className="mbx-btn"
                    onClick={() => { setError(null); setRemoving(m); setStage("remove"); }}
                  >
                    {t("remove")}
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}

      {/* THE CEREMONY COMING BACK. It runs on page load, so a silent pause here reads as a broken
          redirect — which is exactly what a user who has just been bounced through Microsoft is
          primed to believe. `role="status"`, because this is progress and not an alert. */}
      {finishing ? (
        <p className="acct-lead" role="status">
          <span className="mbx-spin" aria-hidden="true" />
          {t("oauthFinishing")}
        </p>
      ) : null}

      {/* ── THE DEVICE-CODE CEREMONY, ON SCREEN ───────────────────────────────────────────────
          The whole ceremony happens here: no redirect, no navigation, and nothing hidden. What it
          has to say, in the order somebody needs it: WHERE to go, WHAT to type, and HOW LONG they
          have. The code is the largest thing in the block because it is the one thing being
          transcribed, by eye, onto another device.
          `role="status"` and not `alert`: a live ceremony is progress. `aria-live="polite"` on the
          countdown alone would announce every tick, so the region is polite and the countdown is
          rendered as ordinary text inside it — a screen reader hears the instruction and the code,
          and is not interrupted once a minute by a clock. */}
      {device ? (
        <div className="acct-confirm" role="status">
          <p className="acct-lead">{t("deviceGoTo")}</p>
          {/* A real link, and it opens in a new tab: the ceremony is still running in THIS one, and
              navigating away from it loses the code from the screen. `rel="noreferrer"` so the
              settings URL is not handed to Microsoft's page. */}
          <p className="acct-lead">
            <a href={device.verificationUri} target="_blank" rel="noreferrer noopener">
              {device.verificationUri}
            </a>
          </p>
          <p className="acct-lead">{t("deviceEnterCode")}</p>
          {/* `<code>` because it IS one, and the class carries the size and letter-spacing that make
              a hyphenated Microsoft code readable in one glance. Selectable, so somebody on the same
              machine can copy it rather than retype it. */}
          <p className="mbx-device-code"><code>{device.userCode}</code></p>
          <p className="acct-fine">
            {/* THE HONEST COUNTDOWN. The deadline is Microsoft's own, so this is not a guess — and it
                is stated in whole minutes because a second-by-second clock on a fifteen-minute
                errand is pressure with no information in it. `now` ticks on the pane's existing
                timer, which is what re-renders this. */}
            {t("deviceExpiresIn", { minutes: Math.max(0, Math.ceil((device.expiresAt - now) / 60_000)) })}
          </p>
          <p className="acct-fine">{t("deviceWaiting")}</p>
          {/* THE POLL'S OWN failure line, inside the ceremony block and not the pane-wide one.
              It is `acct-warn` because something did go wrong, and `role="status"` rather than
              `alert` because the ceremony is still alive — the server says so in as many words, the
              grant's deadline is unchanged, and the loop is still running. An `alert` would
              interrupt a screen reader every few seconds on a flaky connection. */}
          {devicePollError ? (
            <p className="acct-warn" role="status">{devicePollError}</p>
          ) : null}
          <div className="acct-actions">
            {/* CANCEL is local, and says so by doing nothing else: it takes the code off this screen
                and stops polling. The grant itself is Microsoft's and expires on its own schedule —
                claiming otherwise ("cancelled") would be a sentence this button cannot make true. */}
            <Button onClick={clearDeviceFlow}>{t("deviceStopWaiting")}</Button>
          </div>
        </div>
      ) : null}

      {/* HOW IT ENDED, when it ended without a mailbox. Neither of these is a failure of anything:
          somebody declined at Microsoft, or the grant ran out of time. So they are `acct-lead` and
          `role="status"`, not the red alert line — and each one says what to do next. */}
      {deviceEnded ? (
        <p className="acct-lead" role="status">{t(`device_${deviceEnded}`)}</p>
      ) : null}

      {error ? <p className="acct-warn" role="alert">{error}</p> : null}
      {/* A settled outcome, not an alert. `role="status"` so it is announced without interrupting. */}
      {notice ? <p className="acct-lead" role="status">{notice}</p> : null}

      {stage === "list" && gateRead && !device ? (
        <>
          {/* THE REFUSAL, AT SCREEN ONE. See `connectBlock` for why each state gets its
              own sentence and why an unknown never produces one. The remedy for all three
              billing states is the Subscription pane (`BillingSection`), which renders the plan
              cards for an account with no subscription and the billing portal for one whose
              state is wrong — it is the adjacent entry in the settings nav beside this pane, so
              `blocked_where` names a control that is on screen rather than a destination. */}
          {block ? (
            <>
              <p className="acct-lead">{t(`blocked_${block}`)}</p>
              {block === "email_unverified" ? null : (
                <p className="acct-fine">{t("blocked_where")}</p>
              )}
            </>
          ) : outlookOffer ? (
            /* THE DISCLOSURE BEFORE THE REDIRECT (SET-L3). What is about to happen (a sign-in
               at microsoft.com), which mailboxes this door is for, and where the other door is
               — read BEFORE the app is left, because the click used to be the navigation. The
               note is the same sentence the picker's Microsoft tile shows, so the two doors
               describe the one ceremony identically. */
            <div className="acct-confirm">
              {/* WHICH DOOR THIS IS ABOUT TO BE — the disclosure has to describe the ceremony that
                  will actually run, and the two are genuinely different experiences: one leaves the
                  app for Microsoft's sign-in page, the other never leaves and hands you a code to
                  type somewhere else. `startOutlook` picks the same way this sentence does (the
                  operator's own registration first), so the promise and the behaviour are one
                  expression apart, not two. */}
              <p className="acct-lead">
                {oauthAvailable ? t("microsoftOauthNote") : t("deviceOauthNote")}
              </p>
              <p className="acct-fine">{t("oauthOfferWhich")}</p>
              <div className="acct-actions">
                <Button
                  variant="primary"
                  icon="open"
                  onClick={() => startOutlook()}
                  disabled={oauthBusy !== null || finishing}
                >
                  {oauthBusy === "starting" ? t("working") : t("oauthContinue")}
                </Button>
                <Button onClick={() => { setOutlookOffer(false); setError(null); }}>
                  {t("cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="acct-actions">
              <Button variant="primary" icon="plus" onClick={() => { setError(null); setMsAppPassword(false); setStage("form"); }}>
                {t("connect")}
              </Button>
              {/* CONNECT OUTLOOK — beside the password form and not instead of it.
                  It is a SECOND door and not a provider inside the first: the password ceremony asks
                  for an address, a host and a password, and this one asks for none of them. Microsoft
                  states the address in the token it issues, the host is fixed by the token issuer, and
                  there is no password to have — putting this behind the provider picker would mean a
                  form that empties itself when somebody chose Microsoft.
                  A modern Microsoft 365 tenant refuses basic IMAP authentication outright, so for
                  those accounts this is not an alternative to the password path but the only path.
                  `secondary`, because the generic path is still the one most mailboxes take.
                  GATED ON EITHER DOOR being armed, so this is never a button whose press returns a
                  raw 503 — and ONE button rather than two, because "Connect Outlook" is one thing a
                  person wants and which ceremony runs is the server's business, not theirs. The
                  password door beside it is unaffected: it needs no server-side registration.
                  THE PRESS OPENS THE DISCLOSURE ABOVE, which names the ceremony that will actually
                  run; only its continue starts anything. */}
              {oauthAvailable || deviceAvailable ? (
                <Button
                  icon="open"
                  onClick={() => { setError(null); setOutlookOffer(true); }}
                  disabled={oauthBusy !== null || finishing}
                >
                  {t("oauthConnect")}
                </Button>
              ) : null}
            </div>
          )}
          <SettingsNote icon="shield">{t("inPlace")}</SettingsNote>
        </>
      ) : null}

      {stage === "form" ? (
        <form
          className="acct-confirm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!typed.provider) return;
            setError(null);
            // Microsoft, armed door: Continue IS the consent ceremony — a top-level navigation to
            // Microsoft, not the account-password step. Every other provider (and Microsoft when the
            // door is shut or the app-password fallback was chosen) goes to the password step.
            if (microsoftOauth) { startOutlook(); return; }
            setStage("password");
          }}
        >
          {/* The shared picker (also the /join mailbox step — one component, so the two
              surfaces cannot drift again). It carries the provider's own instructions,
              verbatim from `providers.ts` — read BEFORE the user leaves to make an app
              password, which is the trip the five-minute window used to be spent on. On the
              Microsoft sign-in path that app-password note would be a false instruction, so it
              is overridden with the sign-in sentence and the app-password help link is dropped. */}
          <ProviderPicker
            value={typed.provider?.id ?? null}
            onChange={pickProvider}
            note={microsoftOauth ? t("microsoftOauthNote") : undefined}
            showHelp={!microsoftOauth}
          />

          {typed.provider && microsoftOauth ? (
            // No fields: the sign-in supplies the address, the host is fixed, and there is no
            // password. Continue (below) starts the ceremony; this is the escape hatch for a tenant
            // that blocks it — secondary, so it does not compete with the sign-in it sits under.
            <Button
              variant="ghost"
              type="button"
              onClick={() => { setError(null); setMsAppPassword(true); }}
            >
              {t("microsoftUseAppPassword")}
            </Button>
          ) : null}

          {typed.provider && !microsoftOauth ? (
            <>
              <label className="join-label" htmlFor="mb-address">{t("addressLabel")}</label>
              <input
                id="mb-address" className="join-input" type="email" autoComplete="off"
                value={typed.address} onChange={(e) => { setTyped((v) => ({ ...v, address: e.target.value })); clearVerdict(); }}
                required
              />

              {typed.provider.manual ? (
                <>
                  <label className="join-label" htmlFor="mb-imap">{t("imapLabel")}</label>
                  <input
                    id="mb-imap" className="join-input" autoComplete="off" spellCheck={false}
                    value={typed.imapHost}
                    onChange={(e) => { setTyped((v) => ({ ...v, imapHost: e.target.value })); clearVerdict(); }}
                    required
                  />
                  <label className="join-label" htmlFor="mb-smtp">{t("smtpLabel")}</label>
                  <input
                    id="mb-smtp" className="join-input" autoComplete="off" spellCheck={false}
                    value={typed.smtpHost}
                    onChange={(e) => { setTyped((v) => ({ ...v, smtpHost: e.target.value })); clearVerdict(); }}
                    required
                  />
                  {suggestion ? (
                    // The vanity-CNAME correction: the refused certificate is valid and names
                    // the provider's real host, so one press moves the field(s) to a name the
                    // server can prove. The ceremony still runs again — nothing is auto-sent.
                    <Button variant="ghost" type="button" onClick={applySuggestion}>
                      {t("useSuggestedHost", { host: suggestion.host })}
                    </Button>
                  ) : null}
                  {insecureOffer ? (
                    <>
                      <label className="join-label" htmlFor="mb-insecure">
                        <input
                          id="mb-insecure" type="checkbox"
                          checked={typed.allowInsecure}
                          onChange={(e) => {
                            setTyped((v) => ({ ...v, allowInsecure: e.target.checked }));
                            clearVerdict();
                          }}
                        />{" "}
                        {t("insecureConsentLabel")}
                      </label>
                      <SettingsNote icon="shield">{t("insecureConsentWarning")}</SettingsNote>
                    </>
                  ) : null}
                </>
              ) : null}

              <label className="join-label" htmlFor="mb-pass">{t("passwordLabel")}</label>
              <input
                id="mb-pass" className="join-input" type="password" autoComplete="off"
                value={typed.pass} onChange={(e) => { setTyped((v) => ({ ...v, pass: e.target.value })); clearVerdict(); }}
                required
              />
            </>
          ) : null}

          <div className="acct-actions">
            <Button
              variant="primary"
              type="submit"
              disabled={!typed.provider || (microsoftOauth && (oauthBusy !== null || finishing))}
            >
              {microsoftOauth
                ? (oauthBusy === "starting" ? t("working") : t("oauthContinue"))
                : t("continue")}
            </Button>
            {/* NOT on the Microsoft sign-in path: there is no password in this form to prove
                there, and a "Test connection" that dialled with none would answer a refusal about
                the wrong thing. */}
            {!microsoftOauth ? (
              <Button type="button" disabled={!canProbe || probing} onClick={() => void runProbe()}>
                {probeOk || probeBad ? tob("testAgain") : tob("test")}
              </Button>
            ) : null}
            <Button onClick={() => {
              setStage("list"); setTyped(emptyTyped()); setMsAppPassword(false); setError(null);
              setInsecureOffer(false); setSuggestion(null);
              // RETIRES, and it has to: cancelling mid-request used to reset the form and leave
              // the request live, so reopening Connect could receive the OLD answer with nothing
              // pressed — a verdict appearing over an empty form.
              clearVerdict();
            }}>
              {t("cancel")}
            </Button>
          </div>

          {/* ── THE VERDICT RENDERS ONLY WHERE THE TEST IS OFFERED ───────────────────────────
              `microsoftOauth` is not a stable fact about the form: the deployment's OAuth
              availability is read asynchronously, so it can flip to true UNDER a person who
              already chose Microsoft, typed an app password and pressed Test. The fields and the
              Test button vanish, "Continue" becomes the consent ceremony — and without this gate
              the app-password verdict stayed on screen, describing a path the next press no longer
              takes. The effect above retires it; this keeps the frame before that honest. */}
          {!microsoftOauth && probing ? (
            <SettingsVerdict
              state="wait"
              headline={tob("testing", {
                host: (typed.imapHost || typed.provider?.imap.host || "").trim(),
              })}
            />
          ) : null}
          {!microsoftOauth && !probing && probeOk ? (
            <SettingsVerdict
              state="ok"
              headline={tob("probeOk", {
                host: probeOk.host, user: probeOk.user, count: probeOk.folders ?? 0,
              })}
              detail={tob("probeOkDetail")}
            />
          ) : null}
          {/* THE SERVER'S OWN SENTENCE when the taxonomy has no member this build knows — a newer
              API that adds one must degrade to something true, and the message always is. */}
          {!microsoftOauth && !probing && probeBad ? (
            <SettingsVerdict
              state="bad"
              headline={probeBad.reason
                ? t(`probe_${probeBad.reason}` as "probe_auth")
                : probeBad.message}
            />
          ) : null}
        </form>
      ) : null}

      {stage === "edit" && editing ? (
        <form
          className="acct-confirm"
          onSubmit={(e) => {
            e.preventDefault();
            // The fields the browser cannot validate: a port, if typed, has to be a real one.
            // Everything else is optional and the server merges it over what is stored.
            if (
              (edited.port.trim() && !validPort(edited.port))
              || (edited.smtpPort.trim() && !validPort(edited.smtpPort))
            ) {
              setError(t("portInvalid"));
              return;
            }
            setError(null);
            setStage("password");
          }}
        >
          {/* The heading names the mailbox readably; `editing.address` is what the PATCH carries. */}
          <h3 className="acct-sub">{t("editTitle", { address: displayAddress(editing.address) })}</h3>
          {/* Says what an untouched field does, because a blank host box next to a working mailbox
              reads as "this will be erased" unless it says otherwise. */}
          <p className="acct-fine">{t("editIntro")}</p>

          <label className="join-label" htmlFor="mb-edit-pass">{t("passwordLabel")}</label>
          <input
            id="mb-edit-pass" className="join-input" type="password" autoComplete="off"
            value={edited.pass} onChange={(e) => setEdited((v) => ({ ...v, pass: e.target.value }))}
            required
          />

          <label className="join-label" htmlFor="mb-edit-host">{t("imapLabel")}</label>
          <input
            id="mb-edit-host" className="join-input" autoComplete="off" spellCheck={false}
            placeholder={t("keepCurrent")}
            value={edited.host} onChange={(e) => setEdited((v) => ({ ...v, host: e.target.value }))}
          />

          <label className="join-label" htmlFor="mb-edit-port">{t("imapPortLabel")}</label>
          <input
            id="mb-edit-port" className="join-input" inputMode="numeric" autoComplete="off"
            placeholder={t("keepCurrent")}
            value={edited.port} onChange={(e) => setEdited((v) => ({ ...v, port: e.target.value }))}
          />

          <label className="join-label" htmlFor="mb-edit-user">{t("imapUserLabel")}</label>
          <input
            id="mb-edit-user" className="join-input" autoComplete="off" spellCheck={false}
            placeholder={t("keepCurrent")}
            value={edited.user} onChange={(e) => setEdited((v) => ({ ...v, user: e.target.value }))}
          />

          {/* THE SENDING HALF (SET-M3). The connect form collects an SMTP host; without these
              two, a mistyped or migrated one was permanent. Blank keeps the stored value, like
              every field above — and only a touched SMTP field puts an `smtp` block on the
              PATCH at all ({@link smtpPatchOf}). */}
          <label className="join-label" htmlFor="mb-edit-smtp">{t("smtpLabel")}</label>
          <input
            id="mb-edit-smtp" className="join-input" autoComplete="off" spellCheck={false}
            placeholder={t("keepCurrent")}
            value={edited.smtpHost}
            onChange={(e) => setEdited((v) => ({ ...v, smtpHost: e.target.value }))}
          />

          <label className="join-label" htmlFor="mb-edit-smtp-port">{t("smtpPortLabel")}</label>
          <input
            id="mb-edit-smtp-port" className="join-input" inputMode="numeric" autoComplete="off"
            placeholder={t("keepCurrent")}
            value={edited.smtpPort}
            onChange={(e) => setEdited((v) => ({ ...v, smtpPort: e.target.value }))}
          />

          {suggestion ? (
            // The vanity-CNAME correction, applied to the transport whose probe refused. No
            // both-fields double move here, unlike the connect form's: a blank edit field means
            // "keep what is stored", so only the failing transport's field takes the hint.
            <Button
              variant="ghost" type="button"
              onClick={() => {
                const s = suggestion;
                setEdited((v) => ({
                  ...v,
                  host: s.transport === "imap" ? s.host : v.host,
                  smtpHost: s.transport === "smtp" ? s.host : v.smtpHost,
                }));
                setSuggestion(null);
                setError(null);
              }}
            >
              {t("useSuggestedHost", { host: suggestion.host })}
            </Button>
          ) : null}
          {insecureOffer ? (
            <>
              <label className="join-label" htmlFor="mb-edit-insecure">
                <input
                  id="mb-edit-insecure" type="checkbox"
                  checked={edited.allowInsecure}
                  onChange={(e) => setEdited((v) => ({ ...v, allowInsecure: e.target.checked }))}
                />{" "}
                {t("insecureConsentLabel")}
              </label>
              <SettingsNote icon="shield">{t("insecureConsentWarning")}</SettingsNote>
            </>
          ) : null}

          <div className="acct-actions">
            <Button variant="primary" type="submit" disabled={edited.pass.length === 0}>
              {t("continue")}
            </Button>
            <Button onClick={() => {
              setStage("list"); setEditing(null); setEdited(emptyEdit()); setError(null);
              setInsecureOffer(false); setSuggestion(null);
            }}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {/* ══ THE REMOVAL CONFIRMATION ═══════════════════════════════════════════════════════
          A real confirmation, which means it states CONSEQUENCES rather than asking "are you
          sure". Every line is a statement about what the server actually does, and the set is
          chosen by what a person is about to lose track of:

           · organizing stops — the visible change.
           · THE MAIL IS UNTOUCHED. This is the one somebody is actually afraid of, and it is the
             product's central promise: `MailboxService.delete` does not open an IMAP connection
             at all, so no folder and no message on their server is reachable from this press.
           · the stored password is deleted — the thing that cannot be undone by reconnecting
             without typing it again.
           · scheduled sends are closed rather than sent — a consequence with no other surface,
             and one a person who has queued mail would otherwise discover in Drafts.
           · THE COPY ALREADY SYNCED STAYS. Said plainly because it is true and unflattering:
             erasure here is account-scoped and there is no per-mailbox purge, so a confirmation
             claiming the local copy goes would be exactly the false statement this panel exists
             to avoid. It names the thing that does remove it.

          `role="alertdialog"` and the safe answer first in the DOM, the delete strip's discipline
          one surface over. */}
      {stage === "remove" && removing ? (
        <div className="acct-confirm" role="alertdialog" aria-label={t("removeTitle", { address: removing.address })}>
          <h3 className="acct-sub">{t("removeTitle", { address: removing.address })}</h3>
          <ul className="acct-fine mbx-remove-list">
            <li>{t("removeStops")}</li>
            <li>{t("removeMailSafe")}</li>
            <li>{t("removeCredential")}</li>
            <li>{t("removeScheduled")}</li>
            <li>{t("removeCopyStays")}</li>
          </ul>
          <p className="acct-fine">{t("removeReconnect")}</p>
          {error ? <p className="acct-error" role="alert">{error}</p> : null}
          <div className="acct-actions">
            {/* THE SAFE ANSWER FIRST. A destructive confirmation that puts the destructive
                button under the keyboard's first stop is a confirmation that confirms itself. */}
            <Button onClick={() => { setRemoving(null); setError(null); setStage("list"); }}>
              {t("removeCancel")}
            </Button>
            {/* It does not remove anything — it enters the step-up. The account asks for a fresh
                second factor before it will destroy a stored credential, and this button is
                honest about being the start of that rather than the end of it. */}
            {/* `primary danger` — the account section's own convention for a destructive
                confirm (`AccountSection.tsx`), so the two read as one product. */}
            <Button
              variant="primary" className="danger"
              onClick={() => { setError(null); setStage("password"); }}
            >
              {t("removeConfirm")}
            </Button>
          </div>
        </div>
      ) : null}

      {stage === "password" ? (
        <form className="acct-confirm" onSubmit={submitPassword}>
          <h3 className="acct-sub">{t("confirmTitle")}</h3>
          {/* Says WHY, because being asked to re-enter a password one screen after typing a
              different one is otherwise indistinguishable from a bug. */}
          <p className="acct-fine">{t("confirmBody")}</p>
          <label className="join-label" htmlFor="mb-acct-email">{t("accountEmailLabel")}</label>
          <input id="mb-acct-email" className="join-input" type="email" value={email ?? ""} readOnly />
          <label className="join-label" htmlFor="mb-acct-pw">{t("accountPasswordLabel")}</label>
          <input
            id="mb-acct-pw" className="join-input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required
          />
          <div className="acct-actions">
            <Button variant="primary" type="submit" disabled={busy || !email}>
              {busy ? t("working") : t("continue")}
            </Button>
            {/* Back to whichever form we came from — both still hold every typed field. */}
            <Button onClick={() => {
              setStage(removing ? "remove" : editing ? "edit" : "form");
              setPassword(""); setError(null);
            }}>
              {t("back")}
            </Button>
          </div>
        </form>
      ) : null}

      {stage === "factor" ? (
        <div className="acct-confirm">
          <h3 className="acct-sub">{t("factorTitle")}</h3>
          <p className="acct-fine">
            {/* WHICH write this factor authorises. A removal is not a save, and a screen that
                said "storing a mailbox password" over a delete would be asking for consent to
                the wrong act. */}
            {removing ? t("factorBodyRemove") : editing ? t("factorBodyEdit") : t("factorBody")}
          </p>

          {method === "webauthn" ? (
            <div className="acct-actions">
              <Button variant="primary" icon="shield" onClick={finishWithPasskey} disabled={busy}>
                {busy ? t("working") : t("passkey")}
              </Button>
            </div>
          ) : (
            <form onSubmit={finishWithCode}>
              <label className="join-label" htmlFor="mb-code">
                {method === "recovery_code" ? t("recoveryLabel") : t("totpLabel")}
              </label>
              <input
                id="mb-code" className="join-input join-code"
                inputMode={method === "totp" ? "numeric" : "text"}
                autoComplete="one-time-code"
                value={code} onChange={(e) => setCode(e.target.value)}
              />
              <div className="acct-actions">
                <Button variant="primary" type="submit" disabled={busy || code.trim().length === 0}>
                  {busy ? t("working") : editing ? t("verifySave") : t("verifyConnect")}
                </Button>
              </div>
            </form>
          )}

          <div className="acct-methods">
            {challenge?.methods.includes("webauthn") && method !== "webauthn" && webauthnAvailable() ? (
              <button type="button" className="join-alt" onClick={() => { setMethod("webauthn"); setCode(""); }}>
                {t("usePasskey")}
              </button>
            ) : null}
            {challenge?.methods.includes("totp") && method !== "totp" ? (
              <button type="button" className="join-alt" onClick={() => { setMethod("totp"); setCode(""); }}>
                {t("totpToggle")}
              </button>
            ) : null}
            {challenge?.methods.includes("recovery_code") && method !== "recovery_code" ? (
              <button type="button" className="join-alt" onClick={() => { setMethod("recovery_code"); setCode(""); }}>
                {t("useRecovery")}
              </button>
            ) : null}
            {/* A login token is single-use, so a retry starts from the password step — but
                the mailbox form is untouched and is still waiting behind it. */}
            <button
              type="button" className="join-alt"
              onClick={() => { setChallenge(null); setCode(""); setError(null); setStage("password"); }}
            >
              {t("back")}
            </button>
          </div>
        </div>
      ) : null}

      {stage === "saving" ? (
        <p className="acct-lead">
          {removing ? t("removeWorking") : editing ? t("savingEdit") : t("connecting")}
        </p>
      ) : null}

      {/* ── RUN SETUP AGAIN ──────────────────────────────────────────────────────────────────
       *
       * The way back into the first-run flow for somebody who has already been through it. It
       * opens on the consent statement and walks forward from there — what ohmail files, how far
       * back it screens, and AI — with what is set now filled in from what the account stored,
       * and nothing is written until the person agrees.
       *
       * ONLY WITH A MAILBOX. The flow's later screens are ABOUT a mailbox: the window is measured
       * from the consent on one, and the summary reports what happened to one. With none
       * connected, the row would open a re-run that immediately becomes a first run — which is
       * what "Connect a mailbox" above already is, said once instead of twice.
       *
       * `#/first-run/again` and not `#/first-run`: a finished account derives to "nothing to do",
       * correctly, so the RE-RUN INTENT has to ride the route. The bare hash would open, find the
       * completion stamp, and close again on the same render. */}
      {stage === "list" && connected.length > 0 ? (
        <SettingsRow
          label={t("setupAgain")}
          description={t("setupAgainWhy")}
          control={
            <Button onClick={() => goFirstRun({ rerun: true })}>{t("setupAgainAction")}</Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * How a sync time should read, and why it is RELATIVE here.
 *
 * The absolute stamp shipped first and was the wrong instrument. "Synced 1 Aug 2026, 10:08"
 * asks the reader to work out whether that is recent, which is the only thing they wanted to
 * know. This pane re-renders on a timer (see `TICK_MS`), so a relative stamp stays true.
 *
 * The absolute time is kept as the `title`, because "2 minutes ago" is the answer to "is it
 * working" and the timestamp is the answer to "when exactly", and both get asked.
 */
/** The takeover check for one mailbox. `peek: null` means the read is still in flight. */
interface OrganizerCheck {
  id: string;
  peek: OrganizerPeek | null;
}

/**
 * WHAT THE MAILBOX SAYS, AND WHAT TAKING OVER WOULD DO.
 *
 * ── THE SENTENCE IS CHOSEN FROM THE SERVER'S ANSWER, NEVER FROM THE STORED REASON ───────────
 *
 * `disabled_reason` says which KIND of organizer won, at the moment Cloud lost. It cannot say
 * whether that organizer is still running, because nothing re-reads the mailbox after a stand-down.
 * This panel renders the fresh read instead, and the distinction it draws is the one that decides
 * what the user is agreeing to: an install that is still checking in will be STOPPED by taking
 * over, and one that has gone quiet will not.
 *
 * `active` is the server's word for it. A holder is `active` when its claim is still being renewed
 * inside the same window the worker's own gate judges against, so this panel and the gate cannot
 * disagree about who is alive.
 *
 * The effect line is shown in BOTH cases and says exactly what the action does — including the two
 * things people would otherwise have to guess: that the other install stops on its own next check
 * rather than immediately, and that its local copy of the mail is left alone.
 */
function OrganizerPanel({ state, t, now, onCancel, onConfirm }: {
  state: OrganizerCheck;
  t: (k: string, v?: Record<string, string>) => string;
  now: number;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const { peek } = state;
  if (peek === null) return <span className="mbx-sub">{t("organizerChecking")}</span>;

  const holder = peek.holders[0];
  const when = holder ? agoStamp(holder.heartbeatAt, now).rel : "";
  const machine = holder?.displayName ?? null;
  const found =
    holder === undefined
      // No readable holder. An unreadable claim is still evidence somebody claimed, so it gets its
      // own sentence rather than being reported as an empty mailbox.
      ? (peek.unreadable > 0 ? t("organizerUnreadable") : t("organizerNone"))
      : holder.active
        ? (machine ? t("organizerHeldNamed", { machine, when }) : t("organizerHeld", { when }))
        : (machine ? t("organizerStoppedNamed", { machine, when }) : t("organizerStopped", { when }));

  return (
    <>
      <span className="mbx-sub">{found}</span>
      <span className="mbx-sub">{t("organizerEffect")}</span>
      <span className="mbx-actions">
        <Button variant="primary" className="mbx-btn" onClick={onConfirm}>{t("organizerConfirm")}</Button>
        <Button className="mbx-btn" onClick={onCancel}>{t("organizerCancel")}</Button>
      </span>
    </>
  );
}

/**
 * The tooltip on a failing mailbox: how long, how many attempts, and the diagnostic token.
 *
 * Deliberately NOT in the label. The label is the one sentence a person needs ("the mailbox
 * rejected the password"); `ETIMEDOUT` and `53100` are for the moment they ask us about it,
 * and putting them on the row would trade a readable pane for a log line. Every part is
 * optional because every part is nullable on the wire — a mailbox quarantined by a worker
 * older than mail 0023 has a status and nothing else, and the tooltip simply gets shorter.
 */
function errorTitle(
  m: MailboxDTO, now: number,
  t: (key: string, values?: Record<string, string | number>) => string,
): string | undefined {
  const parts: string[] = [];
  if (m.failedAt) parts.push(t("errSince", { when: agoStamp(m.failedAt, now).abs }));
  if (m.retryCount && m.retryCount > 1) parts.push(t("errAttempts", { count: m.retryCount }));
  // The allowlisted diagnostic token, unlocalized on purpose: `ETIMEDOUT` and `53100` are
  // identifiers, and translating an identifier makes it unsearchable.
  if (m.errorDetail) parts.push(m.errorDetail);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * How often the pane re-reads `GET /mailboxes` while it is open.
 *
 * A freshly connected mailbox reports `lastSyncAt: null` until the worker's next cycle, which
 * is up to sixty seconds away. Without polling the pane says "Not synced yet" and stays that
 * way until the user reloads — which is exactly what a fresh connect runs into thirty seconds
 * in: a true statement that looks like a failure because nothing ever changes it.
 */
const TICK_MS = 10_000;

/**
 * The FLOOR under a device-flow poll's delay — five seconds, matching the interval Microsoft
 * actually returns.
 *
 * It is a floor and not the cadence: every delay comes from the server's `retryAfterMs`, which
 * already carries Microsoft's interval plus every `slow_down` increment. This value covers the two
 * cases where that number is absent or zero — the answer to a poll the server refused as early, and
 * a retry after a failed request — so a client that lost the cadence cannot end up in a tight loop
 * against an application shared with other people's installs.
 */
const DEVICE_POLL_FLOOR_MS = 5_000;

/**
 * WHERE A LIVE DEVICE CEREMONY'S HANDLE SURVIVES A RELOAD — `sessionStorage`, per tab.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT OPTIONAL POLISH ─────────────────────────────────────
 *
 * The ceremony lives for about fifteen minutes on the server and the person is being asked to go to
 * another device and type a code. A reload in that window — an accidental refresh, a restored tab,
 * a phone rotating — used to lose the browser's ONLY copy of the handle, and nothing could recover
 * it: the code and the URI are re-supplied by a poll, but there was no handle left to poll with. The
 * grant then sat at Microsoft until it expired while the pane offered to start a new one.
 *
 * A review caught that the comments in this file already PROMISED reload recovery, which made them
 * false rather than merely optimistic. Comments here are the claim under test, so the promise is
 * implemented instead of softened.
 *
 * ── WHY `sessionStorage`, AND WHY STORING THIS IS SAFE ─────────────────────────────────────
 *
 * Per TAB and cleared when the tab closes, which matches the ceremony's own lifetime far better than
 * `localStorage` would: an abandoned ceremony should not greet somebody a week later.
 *
 * The handle is NOT a credential. The `device_code` — the bearer value that redeems the grant — is
 * sealed in the database and never reaches the browser at all. This is a 43-character lookup key
 * whose every use is re-checked against the session's own account server-side, so a reader who could
 * take it out of this tab's storage already holds the session that makes it useless to them.
 *
 * Every access is wrapped: a private window, a browser configured to refuse site data, or a
 * thumbnail capture can make the accessor itself throw, and a settings pane must not fail to render
 * because a storage read did.
 */
const DEVICE_STORE_KEY = "ohmail.deviceCeremony";

interface StoredDevice {
  state: string; userCode: string; verificationUri: string;
  expiresAt: number; retryAfterMs: number;
  /**
   * WHOSE CEREMONY THIS IS, and the reason it is stored rather than assumed.
   *
   * A tab is not a session. Sign out, or erase the account, and sign in as somebody else within
   * the fifteen minutes a grant lives, and the same tab's `sessionStorage` still holds the previous
   * account's record — so a restore with no owner check paints THEIR code and URI on the new
   * account's settings pane. The server would refuse the poll (403, account mismatch), but only
   * after the values were already on screen, which is exactly one beat too late.
   *
   * Found by review on the fix that introduced the persistence. The account id is the whole guard;
   * the sign-out sweep below is the tidy-up, and correctness does not depend on it running.
   */
  accountId: string;
}

function rememberDevice(d: StoredDevice): void {
  try {
    sessionStorage.setItem(DEVICE_STORE_KEY, JSON.stringify(d));
  } catch { /* storage refused — the ceremony still runs, it just will not survive a reload */ }
}

function forgetDevice(): void {
  try {
    sessionStorage.removeItem(DEVICE_STORE_KEY);
  } catch { /* nothing to do; a stale entry is discarded on read by the expiry check below */ }
}

/**
 * The stored ceremony, or null — and it REFUSES an expired one rather than restoring it.
 *
 * A handle whose grant has already run out would otherwise put a dead code on screen with a
 * countdown reading zero, and cost one pointless poll to be told what the deadline already said.
 * The shape is validated field by field because this value survives a reload and a browser upgrade,
 * so "it is whatever we wrote last time" is not something to assume.
 */
function recallDevice(now: number, accountId: string): StoredDevice | null {
  try {
    const raw = sessionStorage.getItem(DEVICE_STORE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<StoredDevice>;
    if (typeof d.state !== "string" || !/^[A-Za-z0-9._~-]{1,512}$/.test(d.state)) return null;
    if (typeof d.userCode !== "string" || typeof d.verificationUri !== "string") return null;
    if (typeof d.expiresAt !== "number" || !Number.isFinite(d.expiresAt) || d.expiresAt <= now) return null;
    /*
     * THE OWNER CHECK, and it is a REFUSAL rather than a filter: a record belonging to anyone else —
     * or one written before this field existed, which is the same unknown — is discarded outright,
     * and the stale entry with it. Nothing is rendered from another account's ceremony, not even
     * for the moment before the server would reject the poll.
     */
    if (typeof d.accountId !== "string" || d.accountId.length === 0 || d.accountId !== accountId) {
      forgetDevice();
      return null;
    }
    return {
      state: d.state, userCode: d.userCode, verificationUri: d.verificationUri,
      expiresAt: d.expiresAt, accountId: d.accountId,
      // Zero, so the first poll after a reload goes out at once: the server's own fence is what
      // decides whether it is too soon, and it knows when the last poll actually was.
      retryAfterMs: 0,
    };
  } catch {
    return null;
  }
}
