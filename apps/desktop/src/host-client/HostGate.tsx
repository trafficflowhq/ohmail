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
import { BearerManager } from "./bearer.js";
import { PairScreen } from "./PairScreen.js";
import { mailboxFactsOverBearer, profileImportOverBearer } from "./transports.js";

/**
 * The host door's send-surface ceiling in raw attachment bytes — the FORM-side twin of
 * `HOST_SEND_MAX_TOTAL_BYTES` in `apps/sidecar/src/host-listener.ts`. A literal rather than an
 * import, because that module is the engine's (node-only: it imports node:http machinery) and
 * this bundle is a browser artifact; the two are held together by the suite instead.
 */
export const HOST_CLIENT_SEND_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

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
    [paired, bearer],
  );

  /* Stable identities: the shared hooks (`useProfileImport`, the mail-state probe) treat their
     transport as a dependency, and a fresh object per render would re-run them per render. */
  const mailboxFacts = useMemo(() => mailboxFactsOverBearer(bearer), [bearer]);
  const profileImport = useMemo(() => profileImportOverBearer(bearer), [bearer]);

  if (onPairPath || !paired || engine === null) {
    return (
      <PairScreen
        bearer={bearer}
        revoked={died}
        onPaired={() => {
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
    />
  );
}
