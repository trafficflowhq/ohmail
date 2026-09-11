/**
 * THE /pair FRAGMENT LANDING — what the QR on the desktop's Devices pane sends a phone to.
 * The QR encodes `https://<magicdns>/pair#<raw-device-pair-token>`, the flow-3 fragment idiom
 * (`InviteScreen.tsx` is the pattern): the token rides the FRAGMENT, never the path or query
 * (`?token=` renders the scan-again screen); it is READ ONCE into a ref and SCRUBBED from the
 * bar; the ONLY request carrying it is the redeem's JSON body; the document arrives under
 * `script-src 'self'` with no inline script (`host-static.ts`). Where the invite asks three
 * fields, this asks NOTHING: the token IS the ceremony, so the redeem fires on mount,
 * declares `kind: "web"`, and a success enters the shell. Without a fragment, this same
 */

/*
 * screen is the signed-out landing — the remedy is a fresh QR on the computer hosting the mail.
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
   * The fragment, read ONCE and kept in a ref — the read is destructive (the scrub below) and
   * Strict Mode replays the mount effect: a replay re-reading `location.hash` would find the
   * emptiness the first pass created and land every valid link on the missing screen
   * (InviteScreen's discipline). The REDEEM rides the same ref discipline: the request is as
   * destructive as the hash read — the token is single-use — and a `cancelled`-flag cleanup
   * only DISCARDED the first request's answer while the token was already consumed, so the
   * second pass answered `pairing_invalid` and a valid scan failed. The effect starts the
   * redeem at most once ({@link redeem}); both passes await the SAME promise.
   */
  const fragment = useRef<string | null>(null);
  const redeem = useRef<Promise<{ ok: boolean; answer: RedeemAnswer } | null> | null>(null);
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
    // A BARE fetch, deliberately not the manager's: there is no session yet, and the manager's
    // 401 recovery has nothing to recover here. `kind: "web"` is this redeemer's own honest
    // declaration — a browser, not an app. `null` resolution = network failure.
    redeem.current ??= (async () => {
      try {
        const res = await fetch("/pair/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant: "device-pair", token, kind: "web" }),
        });
        return { ok: res.ok, answer: (await res.json()) as RedeemAnswer };
      } catch {
        return null;
      }
    })();
    let cancelled = false;
    void redeem.current.then((outcome) => {
      if (cancelled) return;
      if (outcome === null) {
        setPhase({ kind: "failed", message: null });
        return;
      }
      const { ok, answer } = outcome;
      if (ok && answer.tokens?.accessToken && answer.tokens.refreshToken) {
        // `fresh` — a REDEEM, which is a new pairing and therefore a new scratch partition. The
        // rotation inside the manager adopts without it, because a rotated token is the same
        // pairing and re-minting there would discard a half-written message every time an access
        // token aged out. See `PAIR_SCOPE_STORAGE_KEY`.
        bearer.adopt(answer.tokens, { fresh: true });
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
    });
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
