/**
 * THE /pair FRAGMENT LANDING — what the QR on the desktop's Devices pane sends a phone to.
 *
 * The QR encodes `https://<magicdns>/pair#<raw-device-pair-token>` — the flow-3 fragment-link
 * idiom (`app/(product)/join/invite/InviteScreen.tsx` is the pattern, discipline for discipline):
 *
 *  · the token rides the FRAGMENT, never the path or query, so it cannot reach an access log or
 *    a `Referer`; a token someone moved into the query is refused outright (`?token=` renders
 *    the scan-again screen), so the safe shape cannot regress by convenience.
 *  · the fragment is READ ONCE into a ref (Strict Mode replays the mount effect; the address bar
 *    read is destructive) and SCRUBBED from the bar the moment it is held, so an abandoned tab
 *    is not a standing credential display.
 *  · the ONLY request that carries the token is the redeem's JSON body.
 *  · the document arrives under the static handler's `script-src 'self'` policy with no inline
 *    script — the mitigation that matters for a fragment credential (`host-static.ts`).
 *
 * Where the invite landing asks for three fields, this one asks for NOTHING: a device pairing is
 * autonomous — the token IS the ceremony (possession of the QR is the desktop's own screen), so
 * the redeem fires on mount, declares `kind: "web"`, and a success hands the bearer pair to the
 * manager and enters the shell. The same screen, without a fragment, is the signed-out landing:
 * the gate sends a dead session here, and the sentence says the one true remedy — scan a fresh
 * QR on the computer that hosts the mail.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@ohmail/ui";
import type { BearerManager, BearerTokens } from "./bearer.js";

/** What this page knows, in order of discovery. `reading` is the mount tick before the hash. */
type Phase =
  | { kind: "reading" }
  | { kind: "redeeming" }
  /** No token in the fragment — the scan-the-QR landing, doubling as the signed-out screen. */
  | { kind: "missing" }
  | { kind: "failed"; message: string | null };

/** The redeem wire, narrowed to what this screen acts on. */
interface RedeemAnswer {
  tokens?: BearerTokens;
  error?: { code?: string; message?: string };
}

export function PairScreen({
  bearer,
  /** True when the gate sent a DEAD session here — the sentence then says the pairing ended. */
  revoked = false,
  onPaired,
}: {
  bearer: BearerManager;
  revoked?: boolean;
  onPaired: () => void;
}) {
  const t = useTranslations("pairLanding");
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });

  /**
   * The fragment, read ONCE and kept in a ref — the read is destructive (the scrub below), and
   * React 18 Strict Mode replays the mount effect: a replay that re-read `location.hash` would
   * find the emptiness the first pass created and land every valid link on the missing screen.
   * The InviteScreen's exact discipline, kept for the exact reason it records.
   */
  const fragment = useRef<string | null>(null);
  useEffect(() => {
    if (fragment.current === null) {
      const hash = window.location.hash;
      fragment.current = hash.startsWith("#") ? hash.slice(1).trim() : "";
      if (fragment.current !== "") {
        // Scrub: out of the visible URL, out of history, out of the bar of an abandoned tab.
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
    const token = fragment.current;
    if (token === "") {
      setPhase({ kind: "missing" });
      return;
    }
    setPhase({ kind: "redeeming" });
    let cancelled = false;
    void (async () => {
      let answer: RedeemAnswer;
      let ok: boolean;
      try {
        // A BARE fetch, deliberately not the manager's: there is no session yet, and the
        // manager's 401 recovery has nothing to recover here. `kind: "web"` is this redeemer's
        // own honest declaration — a browser, not an app.
        const res = await fetch("/pair/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant: "device-pair", token, kind: "web" }),
        });
        ok = res.ok;
        answer = (await res.json()) as RedeemAnswer;
      } catch {
        if (!cancelled) setPhase({ kind: "failed", message: null });
        return;
      }
      if (cancelled) return;
      if (ok && answer.tokens?.accessToken && answer.tokens.refreshToken) {
        bearer.adopt(answer.tokens);
        onPaired();
        return;
      }
      // A wrong, spent or expired token gets THIS screen's sentence: the wire's message is
      // technically right but the holder's remedy is one click on the computer in front of
      // them, so the screen says that. Everything else shows the server's own words.
      setPhase({
        kind: "failed",
        message: answer.error?.code === "pairing_invalid" ? null : (answer.error?.message ?? null),
      });
    })();
    return () => {
      cancelled = true;
    };
    // `bearer`/`onPaired` are stable for the life of the page; the redeem must run exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="login">
      <div className="login-card join-card">
        <span className="wordmark"><b><em>oh</em>mail</b></span>

        {(phase.kind === "reading" || phase.kind === "redeeming") && (
          <>
            <h1>{t("title")}</h1>
            <p className="sub">{phase.kind === "reading" ? t("reading") : t("redeeming")}</p>
          </>
        )}

        {phase.kind === "missing" && (
          <>
            <h1>{t("missingTitle")}</h1>
            <p className="sub" role="alert">{revoked ? t("revokedBody") : t("missingBody")}</p>
          </>
        )}

        {phase.kind === "failed" && (
          <>
            <h1>{t("failedTitle")}</h1>
            <p className="sub" role="alert">{phase.message ?? t("badToken")}</p>
          </>
        )}
      </div>
      <p className="login-foot">
        <Icon name="shield" /> {t("footer")}
      </p>
    </div>
  );
}
