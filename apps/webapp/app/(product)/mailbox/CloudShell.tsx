"use client";

import { useCallback } from "react";
import { AppShell } from "../../shell/AppShell";
import type { MailboxFacts } from "../../shell/mail-state";
import { COMPOSE_ATTACH_STAGED_SURFACE_BYTES } from "../../components/ComposeAttach";
import { auth, mailboxes as mailboxApi } from "../../api-client";
import { AboutSection } from "./AboutSection";
import { AccountLocale } from "./AccountLocale";
import { AiCreditNotice } from "./AiCreditNotice";
import { BillingSection } from "./BillingSection";
import { DevicesSection, useDevicePairing } from "./DevicesSection";
import { InvitesSection, useUserInvites } from "./InvitesSection";
import { SecuritySection } from "./SecuritySection";
import { AccountSection } from "./AccountSection";
import { MailboxSection } from "./MailboxSection";
import { beginOAuthReturn } from "./oauth-return";

/**
 * THE MICROSOFT CONSENT RETURN, AT MODULE SCOPE — before the router, before the first render.
 *
 * Not an effect, and not inside a component: the ceremony has to be finished on any page load that
 * carries its parameters, including the ones where the shell routes somewhere else entirely. That is
 * not hypothetical — it is the production failure `oauth-return.ts` documents, where a dropped URL
 * fragment put the browser on the Ohbox and the `POST …/complete` that lived in the Mailboxes pane's
 * mount effect was therefore never called at all.
 *
 * This is the earliest client code on this route. It is idempotent, it is a no-op on every page load
 * that is not a consent return, and it is guarded for the server render inside.
 */
beginOAuthReturn();

/**
 * THE CLOUD CLIENT'S SEAM.
 *
 * `AppShell` is shared with `apps/desktop`, a standalone AGPL-3.0-only program whose build
 * deliberately does NOT bundle this app's session client
 * (`apps/desktop/vite.config.ts` aliases the `/sync` adapter to a stub that throws). So the
 * shell cannot import "ask the API who is signed in" — it takes it as a function, and this
 * file is where the Cloud client supplies one.
 *
 * ── WHY THE SHELL NEEDS AN ACCOUNT ID AT ALL ────────────────────────────────────────────
 *
 * Because the mail mirror persists. `packages/client-engine/src/idb.ts` used to default to
 * ONE IndexedDB database name for every account that ever signed in on a browser, so the
 * second person to use a shared machine inherited the first one's cursor and their
 * persisted records — `/sync` is account-filtered but it only merges pages, so nothing
 * removed the first account's mail and it rendered. The database is now named for the
 * account and stamped with it, and the id has to be a SERVER-verified one: `middleware.ts`
 * proved a session exists but says nothing about whose, and a client-side guess is exactly
 * the guess that produced the bug.
 *
 * `GET /auth/session` answers `{ user: SessionUser, scope }`. Only `scope === "full"`
 * counts — an enrollment-scoped session (the password factor alone) is not allowed
 * to open a mailbox, here for the same reason it is not allowed to at the gate. Every other
 * outcome, including a network failure, is `null`, and `EngineProvider` renders an
 * explanation instead of a shell.
 */
export function CloudShell({ demo }: { demo: boolean }) {
  /**
   * Does this deployment invite users? Two gates in one hook: the COMPILED flavor (the
   * managed bundle's branch is a constant `false` — no `/hello` round trip is even paid) and
   * the server's own `features.pairing` word. The pane node is built only when both hold, so
   * on managed the Settings nav structurally cannot grow an Invites entry.
   */
  const userInvites = useUserInvites();

  /**
   * Does this server pair devices? ONE gate, the server's runtime `features.pairing` word —
   * no compiled flavor arm, because BOTH flavors mount the device-pair ceremony (the managed
   * table and the self-host table each spread the same `pairRoutes`; see `routes/index.ts`).
   * `false` while `/hello` is pending or on an older server: no nav entry, never a dead pane.
   * The DEMO flag rides in and settles the question first: a fixtures world pays no `/hello`
   * round trip and grows no pane whose every verb mutates real credentials — the hook's own
   * header carries the measured leak this closed.
   */
  const devicePairing = useDevicePairing(demo);

  const resolveOwner = useCallback(async (): Promise<string | null> => {
    try {
      const { user, scope } = await auth.session();
      if (scope !== "full") return null;
      const accountId = user?.accountId;
      return typeof accountId === "string" && accountId !== "" ? accountId : null;
    } catch {
      // ApiError (401/403/5xx) and a dead network are the same answer: we cannot prove
      // whose mailbox this is, so we do not open one.
      return null;
    }
  }, []);

  /**
   * WHAT STATE ARE THIS ACCOUNT'S MAILBOXES IN? Same seam, same reason.
   *
   * `GET /mailboxes` is the only surface that knows whether a mailbox is connected, in error,
   * or `connected` and nevertheless not being synced (`syncBlockedReason`, mail 0029) — and
   * `app/shell/**` may not call it, because the shell ships inside the desktop program,
   * whose build carries no session client.
   *
   * **It DELIBERATELY does not catch.** `resolveOwner` above maps every failure to `null`
   * because "we cannot prove whose mailbox this is" has exactly one safe answer. Here the two
   * outcomes are NOT interchangeable: an empty array means "this account has no mailboxes",
   * and a 503 mapped to `[]` would put "No mailbox connected, so nothing can arrive" on the
   * screen of somebody with five. So a failure propagates, and `MailStateProvider` keeps the
   * last thing it actually knew.
   *
   * Narrowed to `MailboxFacts` here rather than passing the DTO: the ladder in
   * `app/shell/mail-state.ts` may only consult the fields it names, and mapping at the seam is
   * what makes that enforceable instead of aspirational.
   */
  const mailboxFacts = useCallback(async (): Promise<MailboxFacts[]> => {
    const { items } = await mailboxApi.list();
    return items.map((m) => ({
      // The From selector's value, and the only handle that stays unambiguous the day one
      // mailbox carries several addresses. The ladder in `mail-state.ts` does not read it.
      id: m.id,
      address: m.address,
      // The label the "me" recipient chip wears as the account's name. Nullable on the
      // wire and forwarded as such; the chip's fallback is the bare address.
      displayName: m.displayName ?? null,
      status: m.status,
      errorCode: m.errorCode ?? null,
      // WHY a `disabled` mailbox is disabled (mail 0027), when the organizer lease decided
      // it. Without this line the strip cannot tell a mailbox another install has claimed from a
      // mailbox the user removed, and answers both with "No mailbox connected, so nothing can
      // arrive" — which was true of neither. The RAW wire token travels; `mail-state.ts` owns
      // the mapping to copy, for the reason it owns `SYNC_BLOCK_REASONS`.
      disabledReason: m.disabledReason ?? null,
      syncBlockedReason: m.syncBlockedReason ?? null,
      syncBlockedSince: m.syncBlockedSince ?? null,
      lastSyncAt: m.lastSyncAt,
      // WHEN the first import finished (mail 0038), or null while it has not. The ladder in
      // `mail-state.ts` reads it as a FLOOR — a null keeps the strip saying "still importing" past
      // the point this client's own mirror stops growing, so a partial mailbox cannot read as
      // complete. FORWARDED UNTOUCHED, and the missing `?? null` is the fix: the DTO field is
      // optional, and a bundle older than the column sends it ABSENT. Collapsing that `undefined`
      // to `null` — which is what `?? null` did — is exactly the value the floor reads as "not
      // finished", so it would pin "Syncing your mail" permanently over every non-empty mirror on
      // a deploy skew. The ladder distinguishes `=== null` (a real, ongoing import) from a missing
      // field (`undefined`, degrade to growth-only), and that distinction only survives if the
      // absent field arrives absent.
      initialImportCompletedAt: m.initialImportCompletedAt,
      // How many of the user's own filings this mailbox has not applied yet. FORWARDED
      // UNTOUCHED, for the same reason the line above is: the field is optional, an older
      // server omits it, and the ladder gates on `typeof === "number"`. A `?? 0` here would
      // turn "this build cannot tell" into "nothing is outstanding" — the wrong answer in
      // precisely the case the field was added for.
      pendingMoves: m.pendingMoves,
      // What this mailbox's submission server said it will accept. FORWARDED UNTOUCHED, on
      // the same rule as the two lines above: the field is optional, an older API omits it, and a
      // `?? null` here would erase the difference between "this API cannot say" and "the server
      // announced no ceiling". Both fall back to the same number at the compose surface today, so
      // nothing breaks either way — the `??` is left off because the seam is where that distinction
      // was destroyed the last two times, not because this consumer needs it.
      smtpMaxSizeBytes: m.smtpMaxSizeBytes,
      // The server has sent this since mail 0001 and always will (`toDTO` reads a NOT NULL
      // column). The fallback exists so a stale cached bundle cannot crash the strip on a
      // field it was compiled without, and it degrades to "no elapsed time", never to a wrong
      // one — `minutesSince(null)` is `null`, which the copy renders as "moments ago".
      createdAt: m.createdAt ?? new Date().toISOString(),
    }));
  }, []);

  // Three injected panes, all for the same reason `resolveOwner` is a prop: `AppShell`,
  // `SettingsView` and the (i) panel are shared with `apps/desktop`, which is standalone,
  // has no account, and builds without `app/api-client`. `AppShell` withholds all three in demo mode.
  //
  //  · accountSection — the "Leave anytime" control.
  //  · mailboxSection — connect a mailbox, and the REAL list. The shared pane renders the
  //    mirror's `"mailbox"` entities, which only the FixturesAdapter ever emits, so for a
  //    live account it was permanently empty; and `JoinScreen` was the only caller of
  //    `POST /mailboxes` in the product, which left anyone whose step-up window expired
  //    during onboarding with no way to connect a mailbox at all.
  //  · aboutSection — the (i) body. Which mailbox, synced when, which build.
  //
  // `AccountLocale` is the same seam expressed as a CONTEXT instead of a node, and it has to be:
  // the language row is the one control in Settings that a standalone install also has, so the ROW
  // is shared and only the account write is injected. See its header.
  return (
    <AccountLocale>
      <AppShell
        demo={demo}
        resolveOwner={resolveOwner}
        mailboxFacts={mailboxFacts}
        /* WHAT A SEND FROM THIS WINDOW RIDES — the staging bucket's per-object ceiling.

           This used to declare nothing, which `composeAttachCap` resolves to the 3 MB constant,
           and that was the truth while attachment bytes travelled base64 inside the send request:
           the ~4.5 MB serverless body limit was a real ceiling between this form and the wire. It
           is no longer between them. `createEngine` builds this window's adapter with
           `stageAttachments: true`, so a send whose files do not fit that limit puts them straight
           into storage and sends references — no request body carries them.

           It then declared `null`, EXPLICITLY UNCAPPED, and that went one step too far. Removing
           the request-body limit did not remove every limit: the staging bucket refuses an object
           over its configured size, in the browser's own PUT, after the grant was minted and after
           the person waited — and all the client can report is "try again", which is a retry that
           can never succeed. So the surface is the bucket's per-object ceiling, which the mint
           applies server-side as the same bound.

           `composeAttachCap` still refuses to read a missing announcement as "unbounded": a
           mailbox that has never announced a SIZE falls back to the constant, because an unknown
           limit read as no limit costs the user a message they composed and waited for.

           THE DESKTOP'S CLOUD DOOR KEEPS THE CONSTANT and must: it forwards this send verbatim to
           the hosted API and does not stage, so its bytes really do ride a request body. That is
           declared in `apps/desktop/src/DesktopGate.tsx` and guarded from source there. */
        sendSurfaceMaxTotalBytes={COMPOSE_ATTACH_STAGED_SURFACE_BYTES}
        accountSection={<AccountSection />}
        securitySection={<SecuritySection />}
        mailboxSection={<MailboxSection />}
        billingSection={<BillingSection />}
        /* SELF-HOST ONLY — see `userInvites` above. `undefined` (managed, an old server, the
           answer still pending) means no nav entry, never an empty pane. */
        invitesSection={userInvites ? <InvitesSection /> : undefined}
        /* WHEREVER `/hello` says the server pairs devices — managed and self-host both, since
           each mounts the device-pair ceremony. Same absence rule as the invites pane. */
        devicesSection={devicePairing ? <DevicesSection /> : undefined}
        aboutSection={<AboutSection />}
        /* The Screener's AI-allowance line. The same seam again — it reads
           `GET /billing/subscription`, which `app/shell` may not call — and a FUNCTION because
           the shell binds the one thing the node cannot know: where "start a plan" lands. */
        aiCredits={({ onStartPlan }) => <AiCreditNotice onStartPlan={onStartPlan} />}
      />
    </AccountLocale>
  );
}
