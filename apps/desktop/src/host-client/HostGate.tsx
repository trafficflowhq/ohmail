/**
 * THE HOST-CLIENT GATE — which of two things this browser is looking at.
 *
 * Either this browser holds a pairing (a refresh token the BearerManager found in storage), and
 * the answer is the mail client: the SAME `AppShell` the desktop window and app.ohmail.app
 * render, over an engine this gate builds on the shared `HttpAdapter` in bearer mode. Or it does
 * not — a first visit, a signed-out visit, a `/pair` link — and the answer is the pairing
 * landing, which is also where a session that DIES mid-use lands: the manager's dead signal is
 * the server stating the family is revoked or reused-past (the window's take-back, mostly), and
 * rendering mail past that point would be a mailbox that silently stopped being live.
 *
 * ── THE ENGINE, AND WHAT IS DELIBERATELY NOT PASSED ─────────────────────────────────────────
 *
 * `baseUrl: ""` — every path stays root-relative on the one served origin.
 * The `headers` seam injects the Authorization header per request; the `fetch` is the manager's,
 * whose single 401 recovery rotates the pair and replays once. No cookie option is touched
 * anywhere, because the door never mints one — bearer-only in both directions, by construction.
 *
 * **No `store`.** The mirror is in memory and rebuilt per page load, the desktop window's own
 * choice for the same reason at one remove: the authoritative copy is the engine's database on
 * the computer this page is served FROM, and the drain that fills this mirror rides the user's
 * own tailnet — a LAN hop, not a bootstrap over somebody's metered connection. A persistent
 * IndexedDB mirror needs a server-confirmed owner id to be named by (the shared client's
 * cross-account lesson), and this door's surface has no session read to confirm one with; if the
 * reload cost ever proves real on big mailboxes, that is the named follow-up, not a default.
 *
 * **No `storePolicy`.** The absent branch is `full`, correct for an in-memory mirror.
 *
 * `sendSurfaceMaxTotalBytes` IS passed — {@link HOST_SEND_MAX_TOTAL_BYTES}'s value — because a
 * send from this page rides an HTTP body through the host door's adapter, and the door declares
 * exactly this ceiling on its service bag (`apps/sidecar/src/host-listener.ts`). Absent, the
 * compose form would promise the strict hosted constant, under-selling the door it actually has.
 */

import { useEffect, useMemo, useState } from "react";
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";
import { AppShell } from "../../../webapp/app/shell/AppShell";
import { dropLocalStorageKeys, type LocalSweep } from "../../../webapp/app/shell/boot-cache";
import { COMPOSE_DRAFT_PREFIX, LEGACY_COMPOSE_DRAFT_KEY } from "../../../webapp/app/shell/compose";
import { REPLY_DRAFT_PREFIX, REPLY_META_PREFIX } from "../../../webapp/app/shell/mail-send";
import { SCREENER_INTENTS_PREFIX } from "../../../webapp/app/shell/screener-intents";
import { SEND_LOCKS_PREFIX } from "../../../webapp/app/shell/send-lock";
import { setStorageOwner } from "../../../webapp/app/shell/storage-owner";
import { BearerManager } from "./bearer.js";
import { PairScreen } from "./PairScreen.js";
import { mailboxFactsOverBearer, olderBodyOverBearer, profileImportOverBearer } from "./transports.js";

/**
 * The host door's send-surface ceiling in raw attachment bytes — the FORM-side twin of
 * `HOST_SEND_MAX_TOTAL_BYTES` in `apps/sidecar/src/host-listener.ts`. A literal rather than an
 * import, because that module is the engine's (node-only: it imports node:http machinery) and
 * this bundle is a browser artifact; the two are held together by the suite instead.
 */
export const HOST_CLIENT_SEND_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * THE DURABLE-DECISION STORES THIS DOOR LEAVES AT REST, and what has to reach them when the
 * pairing ends.
 *
 * The shared shell keeps five things in `localStorage` past a reload: the compose scratch buffer,
 * the per-message reply body and its editor metadata, the durable send lanes, and the Screener's
 * intent journal. Three of those are MAIL TEXT. A phone that has been signed out of this door,
 * or whose session the computer revoked, must not still be holding somebody's half-written
 * message — the same rule, and the same prefix list, that `apps/webapp/app/sign-out.ts` applies
 * on the hosted door.
 *
 * By PREFIX and not by scope, deliberately: ending a pairing means this browser forgets, and a
 * key left behind under a retired scope is unreachable rather than gone. An exact key is a prefix
 * of itself, which is how the legacy un-owned compose key rides along.
 */
export const HOST_SCRATCH_PREFIXES: readonly string[] = [
  COMPOSE_DRAFT_PREFIX,
  LEGACY_COMPOSE_DRAFT_KEY,
  SEND_LOCKS_PREFIX,
  SCREENER_INTENTS_PREFIX,
  REPLY_DRAFT_PREFIX,
  REPLY_META_PREFIX,
];

/**
 * WHAT THE SWEEP COULD NOT DO IS A FACT, NOT A SHRUG.
 *
 * `dropLocalStorageKeys` returns a verdict — which matched keys are still present, and whether the
 * jar could be walked at all — precisely because a browser that refuses proves nothing by naming
 * no survivors. Both departure paths here discarded it and went straight to the landing, so a
 * private window or a refusing storage layer produced a signed-out screen over mail text that is
 * still on the device.
 *
 * This door has no toast host at the moment either path runs (one is unmounting the shell, the
 * other replacing it), so the verdict goes to the console rather than to a surface that is not
 * there. That is deliberately the weakest useful thing: it is on record, it is greppable, and it
 * does not pretend the sweep succeeded. A visible sentence belongs beside this door's own sign-out
 * copy, and is named as the follow-up rather than invented here.
 */
function reportSweep(sweep: LocalSweep): void {
  if (sweep.enumerated && sweep.survivors.length === 0) return;
  console.warn("ohmail host client: the scratch sweep did not complete", {
    enumerated: sweep.enumerated,
    survivors: sweep.survivors.length,
  });
}

export function HostGate({ bearer }: { bearer: BearerManager }) {
  const [paired, setPaired] = useState(bearer.paired());
  /** True when the CURRENT unpaired state was a mid-use death — the landing says so. */
  const [died, setDied] = useState(false);
  /** `/pair` opens the landing even while paired — that is what a fresh QR scan is. */
  const [onPairPath, setOnPairPath] = useState(
    typeof window !== "undefined" && window.location.pathname === "/pair",
  );

  useEffect(
    () =>
      bearer.onSessionDead(() => {
        // WHAT IS LEFT AT REST GOES WITH THE PAIRING. `bearer.die()` has already dropped the
        // refresh token and the pairing scope, so nothing on this page can read these keys again
        // — but unreachable is not gone, and three of them are mail text on a device somebody
        // just signed out of. See HOST_SCRATCH_PREFIXES.
        reportSweep(dropLocalStorageKeys(HOST_SCRATCH_PREFIXES));
        // Land on /pair with the plain sentence — the ruled shape for a rotation failure. The
        // path is replaced (not pushed) so Back cannot return to a dead mailbox.
        window.history.replaceState(null, "", "/pair");
        setDied(true);
        setPaired(false);
        setOnPairPath(true);
      }),
    [bearer],
  );

  /**
   * ONE engine per pairing, built only once this browser holds one. `paired` is the dependency
   * that matters: a re-pair after a death builds a fresh engine rather than reviving one whose
   * in-flight drains were refused.
   */
  /**
   * WHICH PAIRING THIS PAGE IS SERVING — read every render, because a re-pair changes it under us.
   *
   * `paired` is a boolean and `bearer` is one long-lived object, so neither of them CHANGES when a
   * `/pair` redeem swaps the credential while the tab is already paired — the explicitly supported
   * gesture one branch below. The engine memo therefore kept account A's in-memory mirror and
   * served it under account B's session: two accounts' mail in one mirror, which is the
   * cross-account lesson this door's own header cites as the reason it has no persistent one.
   */
  const scope = bearer.pairScope();

  const engine = useMemo(
    () =>
      paired
        ? new OhmailEngine({
            adapter: new HttpAdapter({
              baseUrl: "",
              headers: () => bearer.headers(),
              fetch: bearer.fetch,
            }),
          })
        : null,
    // `scope` is the dependency that matters on a RE-PAIR: a fresh redeem mints a new one, so the
    // engine (and the mirror inside it) is rebuilt for the account that is now being served.
    [paired, bearer, scope],
  );

  /* Stable identities: the shared hooks (`useProfileImport`, the mail-state probe) treat their
     transport as a dependency, and a fresh object per render would re-run them per render. */
  const mailboxFacts = useMemo(() => mailboxFactsOverBearer(bearer), [bearer]);
  const profileImport = useMemo(() => profileImportOverBearer(bearer), [bearer]);
  const olderBody = useMemo(() => olderBodyOverBearer(bearer), [bearer]);

  /**
   * WHOSE `localStorage` PARTITION THE SHARED SHELL USES ON THIS DOOR — established in render,
   * above the `AppShell` below, for the ordering reason `storage-owner.ts` states: the shell
   * reads the compose scratch in its own effect, and a child's effects run before its parent's.
   *
   * There is no cookie here by construction (bearer-only in both directions), so until this line
   * every pairing this origin has ever held shared one key. A host door's origin is an address on
   * a tailnet or a LAN and addresses are reused, so that is not hypothetical: the same phone,
   * paired to a second computer at an address the first one used, restored the first computer's
   * unfinished message into the second one's composer.
   *
   * `null` while unpaired, which is the correct answer and not a fallback — the branch below
   * renders the pairing landing, which stores nothing per account.
   */
  setStorageOwner(paired ? scope : null);

  if (onPairPath || !paired || engine === null) {
    return (
      <PairScreen
        bearer={bearer}
        revoked={died}
        onPaired={() => {
          // A FRESH PAIRING IS ALSO A DEPARTURE, and only the death path used to say so.
          // `/pair` opens this landing while still paired — the case just above — so a person can
          // move this browser from one computer to another without ever signing out. `adopt`
          // retires the old scope, which makes the previous pairing's records unreachable; it does
          // not make them GONE, and three of them are mail text. Swept here for the same reason
          // and by the same list as the death path.
          reportSweep(dropLocalStorageKeys(HOST_SCRATCH_PREFIXES));
          window.history.replaceState(null, "", "/");
          setDied(false);
          setOnPairPath(false);
          setPaired(true);
        }}
      />
    );
  }

  return (
    <AppShell
      /**
       * KEYED BY THE PAIRING, for the reason `DesktopGate` states: partitioning the storage does
       * not move the SHELL STATE that writes into it. A tab whose pairing changes underneath it —
       * another tab redeems a new QR on this origin, and this tab's next rotation adopts the
       * stored token — would otherwise keep the previous pairing's compose in state while the
       * owner beneath it has already become the new one.
       */
      key={scope ?? "unpaired"}
      demo={false}
      engine={engine}
      /* The sync strip's mailbox facts, over the same bearer socket — the door serves
         `GET /mailboxes` out of the store on the computer hosting this page. */
      mailboxFacts={mailboxFacts}
      sendSurfaceMaxTotalBytes={HOST_CLIENT_SEND_MAX_TOTAL_BYTES}
      /* The profile-import card, free through the shared shell: the card, the counts and the
         fingerprint-as-consent are one implementation, and this door serves the three routes
         (they ride `localRoutes`) — only the wire is injected. */
      profileImportTransport={profileImport}
      /* The reach-past body door over the bearer — see `olderBodyOverBearer` for why this page
         needs one at all: its `api-client` is the refusing stub, so the shared shell's Cloud
         fallback never arms here. */
      olderBodyWire={olderBody}
    />
  );
}
