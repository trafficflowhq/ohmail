"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "../../shell/AppShell";
import type { MailboxFacts } from "../../shell/mail-state";
import { toMailboxFacts } from "./mailbox-facts";
import { buildToken } from "../../shell/app-update";
import { startBuildWatch } from "../../shell/build-watch";
import { COMPOSE_ATTACH_STAGED_SURFACE_BYTES } from "../../components/ComposeAttach";
import {
  bindApiOwner, mailboxes as mailboxApi, onAccessRefused, pendApiOwner,
  type AccessRefusedFacts,
} from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import { resolveOwnerOutcome } from "../session-outcome";
import { AboutSection } from "./AboutSection";
import { AccessLock } from "./AccessLock";
import { AccountLocale } from "./AccountLocale";
import { AiSection } from "./AiSection";
import { DevicesSection, useDevicePairing } from "./DevicesSection";
import { InvitesSection, useUserInvites } from "./InvitesSection";
import { SecuritySection } from "./SecuritySection";
import { AccountSection } from "./AccountSection";
import { MailboxSection } from "./MailboxSection";
import { SubscriptionSection, useManageLink } from "./SubscriptionSection";
import { beginOAuthReturn } from "./oauth-return";
import { useCloudFirstRun } from "./useCloudFirstRun";

/**
 * The Microsoft consent return, at module scope — before the router, before
 * the first render. Not an effect: the ceremony must be finished on any
 * page load that carries its parameters, including ones the shell routes
 * somewhere else entirely — the production failure `oauth-return.ts`
 * documents, where a dropped URL fragment put the browser on the Ohbox and
 * the `POST …/complete` in a pane's mount effect was never called. This is
 * the earliest client code on this route: idempotent, a no-op on every
 * non-return load, guarded for the server render inside.
 */
/*
 * The boundary closes before the ceremony completes, not after. `beginOAuthReturn()` runs at module
 * scope — before any render, so before the render-time `pendApiOwner` — and it used to send the
 * completion while the client was still `public`: a consent return for A loading while the jar had
 * become B sent the completion under B's session; the server consumed A's single-use ceremony and
 * only then rejected the mismatch — no mailbox attached, A's ceremony destroyed, nothing on screen
 * saying why. So the pend happens first, on the same synchronous line: `readOwner()` is a cookie
 * read with no side effects, safe at module scope.
 */
pendApiOwner(readOwner());
beginOAuthReturn();

/**
 * The Cloud client's seam. `AppShell` is shared with `apps/desktop`, whose build does not bundle this
 * app's session client, so the shell takes "ask the API who is signed in" as a function and this file
 * supplies it. The shell needs an account id because the mirror persists: one shared database once let
 * the second person on a machine inherit the first's cursor and mail — the database is now named for the
 * account, and the id must be SERVER-verified (`middleware.ts` proves a session exists, not whose). Only
 * `scope === "full"` counts: an enrollment-scoped session may not open a mailbox. A failure to ask is not
 * an answer: `session-outcome.ts` classifies into three, `EngineProvider` retries the middle one, and
 * only an ANSWERED refusal reaches the signed-out screen (`AUTH-FLICKER-DIAGNOSIS.md`).
 */
export function CloudShell({ demo }: { demo: boolean }) {
  /**
   * Is this tab still the app this origin serves? A browser client is downloaded once and left
   * running, and nothing tells open tabs about a deployment. The watch asks `/version` occasionally
   * and raises the quiet strip — at most once a day per build. Armed here, not in `AppShell`: the
   * shared shell is also the desktop window, which reaches no network and updates from a signed
   * release feed. Not on the demo: a bar about a newer ohmail over invented mail is a sentence
   * about the wrong thing. The token is computed from constants `next.config.mjs` inlined into THIS
   * bundle, so it names the running build by construction.
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
  /**
   * Has the service refused this account? Subscribed once, for the whole
   * client: any door may answer `402 subscription_required`, so it is
   * raised here rather than at two hundred call sites, and the whole
   * surface swaps for the lock screen — mail beside a refusal is the state
   * this prevents. It never unsets itself: a refusal is a fact about the
   * account, and a later request that happens to succeed is not evidence it
   * was lifted — signing in again after paying is what clears it. Not on
   * the demo: no server, no account to refuse.
   */
  const [refused, setRefused] = useState<AccessRefusedFacts | null>(null);
  useEffect(() => {
    if (demo) return;
    return onAccessRefused((facts) => setRefused((held) => held ?? facts));
  }, [demo]);

  const userInvites = useUserInvites();

  /**
   * WHERE THIS ACCOUNT MANAGES ITS SUBSCRIPTION — `null` on every install that has nowhere.
   *
   * The same absence rule as `userInvites` and `devicePairing`: a node is built only when the
   * answer is known to be a place, so a self-hosted or unmetered deployment structurally cannot
   * grow a Subscription entry rather than growing one that opens an empty pane.
   */
  const manageUrl = useManageLink(demo);

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
   * The first-run flow's door — the same seam as the panes below, one layer up. `AppShell` renders
   * the setup stage and may not call `POST /mailboxes/probe`, `POST /mailboxes`, `POST
   * /mailboxes/:id/organize` or `PATCH /consent/settings` itself. `undefined` on the demo, which
   * withholds the stage structurally rather than rendering one whose buttons refuse. The pairing
   * panel rides along wherever this server pairs — the same `features.pairing` gate the Devices
   * pane is built on, so setup's last step exists exactly where the surface it links to does.
   */
  const firstRun = useCloudFirstRun(demo, devicePairing ? <DevicesSection /> : undefined);

  /**
   * The shell's confirm — now nothing but a pass-through to the shared classifier. It used to hold
   * the predicate itself: `} catch { return null; }`, with the conflation stated as design. `null`
   * was also what an enrollment-scoped session returned, so a `503 db_busy` and a revoked family
   * got the same "You are signed out." over a cookie that answered `200 scope=full` a moment later
   * (measured in production). `session-outcome.ts` is the predicate now, shared with `/login` so
   * the two screens cannot answer differently — which they demonstrably did. Not wrapped in
   * `useCallback`: an imported function already has a stable identity, which is all
   * `EngineProvider`'s effect needs.
   */
  const resolveOwner = resolveOwnerOutcome;

  /**
   * A named shell is never a public surface. The account boundary's one nullable state meant both "no
   * account here" and "account here, server not answered yet", and let the second through: a deep-linked
   * settings pane over a warm mirror for A issues requests while the confirm is in flight, another tab
   * establishes B, and Security, Devices, Billing and Mailboxes read or change B — with a step-up window
   * open. So the moment a Cloud shell exists the client stops being public: `readOwner()` is the same
   * synchronous read that names the mirror; a cold load pends `null`, still failing closed. DURING
   * RENDER, not an effect: React runs a child's effects before its parent's, so a pane's first request
   * would beat an effect here. `pendApiOwner` never widens — idempotent under StrictMode.
   */
  pendApiOwner(readOwner());

  /**
   * What state are this account's mailboxes in? Same seam, same reason: `GET /mailboxes` is the
   * only surface that knows, and `app/shell/**` may not call it. It DELIBERATELY does not catch:
   * `resolveOwner` maps every failure to `null` because that question has one safe answer; here the
   * outcomes are not interchangeable — an empty array means "no mailboxes", and a 503 mapped to
   * `[]` would put "No mailbox connected" on the screen of somebody with five. A failure propagates
   * and `MailStateProvider` keeps the last thing it knew. Narrowed to `MailboxFacts` at the seam,
   * so the ladder may only consult the fields it names — enforceable rather than aspirational.
   */
  const mailboxFacts = useCallback(async (): Promise<MailboxFacts[]> => {
    const { items } = await mailboxApi.list();
    // The narrowing itself is `toMailboxFacts`, in its own module and tested directly. It used to
    // be inline here, which is what kept its absent-field defaults — including the one that
    // decides whether a claim banner appears at all — out of reach of every test in this app.
    return items.map(toMailboxFacts);
  }, []);

  // Three injected panes, for the reason `resolveOwner` is a prop: the
  // shell is shared with the standalone desktop, which builds without
  // `app/api-client`; `AppShell` withholds all three in demo mode.
  // accountSection is the "Leave anytime" control; mailboxSection connects
  // a mailbox and shows the REAL list (the shared pane renders fixture-only
  // entities, so it was empty for live accounts); aboutSection is the (i)
  // body. `AccountLocale` is the same seam as a CONTEXT: the language row
  // is the one Settings control a standalone install also has, so the row
  // is shared and only the account write is injected. The lock replaces the
  // shell entirely — after the hooks, inside `AccountLocale`.
  if (refused) {
    return (
      <AccountLocale>
        <AccessLock facts={refused} />
      </AccountLocale>
    );
  }

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
        /* What a send from this window rides — the staging bucket's
           per-object ceiling. Declaring nothing meant the 3 MB constant,
           true while attachment bytes rode the send request base64;
           `createEngine` now builds this adapter with
           `stageAttachments: true`, so oversized files go to storage as
           references. `null` (explicitly uncapped) went one step too far:
           the bucket refuses an over-size object in the browser's own PUT,
           with an unfixable "try again". So the surface is the bucket's
           ceiling, applied server-side at the mint too. The desktop's cloud
           door keeps the constant: it forwards verbatim (`DesktopGate.tsx`). */
        sendSurfaceMaxTotalBytes={COMPOSE_ATTACH_STAGED_SURFACE_BYTES}
        accountSection={<AccountSection />}
        securitySection={<SecuritySection />}
        mailboxSection={<MailboxSection />}
        /* UNCONDITIONAL, unlike the row below it: every host this shell runs on has an account
           and mounts `GET/PATCH /account/ai`, including a self-hosted server whose operator pays
           the model bill themselves. `AppShell` withholds it on the demo. */
        aiSection={<AiSection />}
        /* ONE GENERIC ROW, and only where the service supplies a page for it. This app holds no
           plan, no balance and no payment method, so it states none of them; the row is a link
           out. Same absence rule as `invitesSection` below — see `manageUrl`. */
        billingSection={manageUrl ? <SubscriptionSection url={manageUrl} /> : undefined}
        /* SELF-HOST ONLY — see `userInvites` above. `undefined` (managed, an old server, the
           answer still pending) means no nav entry, never an empty pane. */
        invitesSection={userInvites ? <InvitesSection /> : undefined}
        /* WHEREVER `/hello` says the server pairs devices — managed and self-host both, since
           each mounts the device-pair ceremony. Same absence rule as the invites pane. */
        devicesSection={devicePairing ? <DevicesSection /> : undefined}
        aboutSection={<AboutSection />}
        /* THE FIRST-RUN STAGE'S CALLS. Withheld on the demo — see `useCloudFirstRun`. */
        {...(firstRun ? { firstRun } : {})}
      />
    </AccountLocale>
  );
}
