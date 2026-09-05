"use client";

import { useCallback, useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import type { MailboxFacts } from "../../shell/mail-state";
import { toMailboxFacts } from "./mailbox-facts";
import { buildToken } from "../../shell/app-update";
import { startBuildWatch } from "../../shell/build-watch";
import { COMPOSE_ATTACH_STAGED_SURFACE_BYTES } from "../../components/ComposeAttach";
import { bindApiOwner, mailboxes as mailboxApi, pendApiOwner } from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import { resolveOwnerOutcome } from "../session-outcome";
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
import { useCloudFirstRun } from "./useCloudFirstRun";

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
/*
 * ── THE BOUNDARY CLOSES BEFORE THE CEREMONY COMPLETES, NOT AFTER ─────────────────────────────
 *
 * `beginOAuthReturn()` runs at MODULE SCOPE — the moment this file is imported, which is before
 * any render and therefore before the render-time `pendApiOwner` below. It sends the consent
 * completion, and it sent it while the client was still `public`.
 *
 * The sequence: a consent return for A loads while the shared jar has become B. The completion
 * goes out under B's session; the server consumes A's single-use ceremony and only then rejects
 * the account mismatch. No mailbox is attached to anybody — and A's ceremony is destroyed, so the
 * person has to start the consent flow over with nothing on screen explaining why.
 *
 * So the pend happens first, on the same synchronous line. `readOwner()` is a cookie read with no
 * side effects and no imports of its own, which is what makes it safe at module scope.
 */
pendApiOwner(readOwner());
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
 * to open a mailbox, here for the same reason it is not allowed to at the gate.
 *
 * ── AND A FAILURE TO ASK IS NOT AN ANSWER, WHICH THIS PARAGRAPH USED TO DENY ──────────────
 *
 * It read: "Every other outcome, including a network failure, is `null`, and `EngineProvider`
 * renders an explanation instead of a shell." True of the code and false about the world —
 * the "explanation" was "You are signed out.", and a network failure is not evidence for it.
 * `session-outcome.ts` now classifies into three, `EngineProvider` retries the middle one on
 * a bounded schedule, and only an ANSWERED refusal reaches that screen. The production
 * request that forced the change is in `AUTH-FLICKER-DIAGNOSIS.md`.
 */
export function CloudShell({ demo }: { demo: boolean }) {
  /**
   * IS THIS TAB STILL THE APP THIS ORIGIN SERVES? A browser client is downloaded once and then
   * left running, and nothing about a deployment tells the tabs already open that they are
   * looking at an older program. The watch asks `/version` occasionally and, when the answer is
   * a build this document is not, raises the shell's quiet strip — at most once a day per build.
   *
   * ARMED HERE rather than in `AppShell`, and that is the same boundary every prop below draws:
   * the shared shell is also the desktop app's window, which reaches no network at all and
   * updates from a signed release feed instead. A build watch there would be a request that
   * cannot be made about a build that does not update that way.
   *
   * NOT ON THE DEMO. The landing page's mailbox is a fixtures world with nothing to reload into,
   * and a bar about a newer ohmail over invented mail is a sentence about the wrong thing.
   *
   * The token is computed from the constants `next.config.mjs` inlined into THIS bundle, so it
   * names the build the reader is running by construction rather than by configuration.
   */
  useEffect(() => {
    if (demo) return;
    return startBuildWatch({
      token: buildToken(process.env.NEXT_PUBLIC_APP_VERSION, process.env.NEXT_PUBLIC_BUILD),
    });
  }, [demo]);

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

  /**
   * THE FIRST-RUN FLOW'S DOOR — the same seam as the panes below, one layer up.
   *
   * `AppShell` renders the setup stage and may not call `POST /mailboxes/probe`, `POST
   * /mailboxes`, `POST /mailboxes/:id/organize` or `PATCH /consent/settings` itself, for the
   * reason every prop on this component exists. `undefined` on the demo, which withholds the
   * stage structurally rather than rendering one whose buttons refuse.
   *
   * The PAIRING panel rides along wherever this server pairs — the same `features.pairing` gate
   * the Devices pane is built on, so the last step of setup exists exactly where the surface it
   * links to does.
   */
  const firstRun = useCloudFirstRun(demo, devicePairing ? <DevicesSection /> : undefined);

  /**
   * The shell's confirm, which is now nothing but a pass-through to the shared classifier.
   *
   * It used to hold the predicate itself, and the predicate was one line long:
   *
   *     } catch { return null; }
   *
   * with a comment stating the conflation as the design — "ApiError (401/403/5xx) and a dead
   * network are the same answer". They are not. `null` was also what an enrollment-scoped
   * session returned, so a `503 db_busy` and a revoked family reached `EngineProvider` as the
   * same value and got the same screen: "You are signed out.", over a cookie that answered
   * `200 scope=full` a moment later. Measured in production 2.7 s before it was reported.
   *
   * `session-outcome.ts` is that predicate now, shared with `/login` so the two screens that
   * ask this question cannot answer it differently — which they demonstrably did, inside the
   * same ten seconds. Nothing is classified here any more; `EngineProvider` schedules the
   * retries and decides what to render.
   *
   * Not wrapped in `useCallback`: it is already the same function object on every render, which
   * is what `EngineProvider`'s confirm effect needs of its `resolveOwner` dependency. A
   * `useCallback` around an imported function would add a hook to say what the import already
   * guarantees.
   */
  const resolveOwner = resolveOwnerOutcome;

  /**
   * ═══ A NAMED SHELL IS NEVER A PUBLIC SURFACE ══════════════════════════════════════════════
   *
   * The account boundary in `api-client.ts` had one nullable state meaning both "there is no
   * account here" and "there is an account here and the server has not answered yet", and it let
   * the second one through because the first one must go through. Review walked the consequence:
   * a deep-linked settings pane over a warm mirror for A mounts, renders and issues requests
   * while the confirmation is still in flight; another tab establishes B in that window; Security,
   * Devices, Billing and Mailboxes all pass the boundary and read or change B. A freshly signed-in
   * B is also exactly when a step-up window is open, which is what puts recovery-code generation
   * and TOTP enrolment inside the window.
   *
   * So the moment a Cloud shell exists, the client stops being public. `readOwner()` is the same
   * synchronous read the shell uses to choose which mirror to open, so where there is a warm
   * mirror this names the account it is for and the boundary is as strict as it will be after the
   * confirm; on a cold load it is `null`, which still fails closed on an absent or signed-out
   * marker and merely cannot yet say WHICH account — one round trip later the confirm says.
   *
   * DURING RENDER, not in an effect, and that is the whole point: an effect runs after the commit
   * that mounted the panes, and the panes issue their reads from their own effects. React orders
   * a child's effect BEFORE its parent's, so a pane's first request would go out before an effect
   * here could have closed the door. `pendApiOwner` never widens — a client already bound or
   * blocked ignores it — so calling it on every render is idempotent and safe under StrictMode's
   * double invocation.
   */
  pendApiOwner(readOwner());

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
    // The narrowing itself is `toMailboxFacts`, in its own module and tested directly. It used to
    // be inline here, which is what kept its absent-field defaults — including the one that
    // decides whether a claim banner appears at all — out of reach of every test in this app.
    return items.map(toMailboxFacts);
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
        /* The classifier answers; THIS commits. See `EngineProvider.onConfirmed` for why the
           binding cannot live inside `resolveOwnerOutcome`. */
        onConfirmed={bindApiOwner}
        mailboxFacts={mailboxFacts}
        /* ACKNOWLEDGING THE ORGANIZER NOTICE, which the shared shell cannot do for itself: the
           publish denies it `app/api-client`, so the route is reached from here on this door and
           from the window's own pipe on the desktop. One route, two transports, one sentence.

           `demo` keeps its own gate inside the shell — a fixture world has no row to stamp — so
           this is handed over unconditionally, exactly as `mailboxFacts` above is. */
        organizerNoticeTransport={(id) => mailboxApi.dismissOrganizerNotice(id)}
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
        /* THE FIRST-RUN STAGE'S CALLS. Withheld on the demo — see `useCloudFirstRun`. */
        {...(firstRun ? { firstRun } : {})}
      />
    </AccountLocale>
  );
}
