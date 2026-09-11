"use client";

/**
 * The invite, opened — one form, one submit, and the person has an account. The operator minted
 * `<origin>/join/invite#<token>`; this page takes the token out of the fragment, asks for the three things an account
 * is, and drives `POST /pair/redeem` → `POST /auth/register` → an enrollment session → `/join`, resuming at the
 * second-factor step.
 */

/**
 * `SetupScreen`'s proven ceremony minus the token field, one submit for the same reason: the pairing token is
 * SINGLE-USE, so a two-screen flow would strand anyone who fell between. A register refusal after a successful redeem
 * KEEPS the minted code, keyed to the address it is bound to, so a retry re-uses it; changing the address after that
 * point is the one unrecoverable edit, refused with the true remedy (ask for a fresh link).
 */

/**
 * The threat posture, plainly: possession of the link IS the invitation — handed over a channel the operator already
 * trusts — and everything else bounds a leak. The token rides the FRAGMENT (never sent in a request; a `?token=`
 * query is refused outright so the safe shape cannot regress); the fragment is scrubbed from the address bar the
 * moment it is in state (`JoinScreen`'s `?code=` discipline); the token is single-use, expires and is revocable, and
 * the redeem's email-bound invite code lives fifteen minutes; the ONLY request carrying the token is the redeem's
 * JSON body (a test pins that no fetch URL contains it); `middleware.ts` serves this path under the strict nonce CSP
 * — the mitigation that matters, since injected inline script reading `location.hash` is the exposure that remains.
 */

/**
 * A wrong or spent token gets THIS form's sentence: the wire message ("ask whoever minted it") names nobody, and the
 * person holding an invite link knows exactly one human to ask.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import { apiConfigured, auth, codeOf, messageOf, pair } from "../../../api-client";

/** What this page knows, in order of discovery. `reading` is the mount tick before the hash is read. */
type Phase = "reading" | "form" | "missing" | "unconfigured";

export function InviteScreen() {
  const t = useTranslations("joinInvite");
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("reading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The pairing token, held in state and nowhere else once the address bar is scrubbed. */
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  /** A redeem that succeeded while register did not — kept so a retry never re-burns the token. */
  const [minted, setMinted] = useState<{ code: string; email: string } | null>(null);

  /**
   * The fragment, read ONCE and kept in a ref — because the read is destructive. This effect
   * scrubs the hash the moment the token is held, and React 18's Strict Mode replays the
   * mount effect: a replay that re-read `location.hash` would find the emptiness the first
   * pass created and overwrite the phase with the incomplete-link screen — every valid link
   * broken under `pnpm dev`. Review finding, watched red under a Strict Mode mount. The ref
   * survives the replay (Strict Mode remounts effects, not the instance), so both passes
   * agree on what the address bar originally said.
   */
  const fragment = useRef<string | null>(null);
  useEffect(() => {
    if (!apiConfigured()) {
      setPhase("unconfigured");
      return;
    }
    // THE FRAGMENT, AND ONLY THE FRAGMENT. A token someone moved into the query is refused
    // rather than accepted-with-a-shrug: accepting it would put the credential in access logs
    // and referrers on every open, and the incomplete-link screen tells the holder to ask for
    // a fresh link — which the minting pane produces in one click.
    if (fragment.current === null) {
      const hash = window.location.hash;
      fragment.current = hash.startsWith("#") ? hash.slice(1).trim() : "";
      if (fragment.current !== "") {
        // Scrub: out of the visible URL, out of history, out of the bar of an abandoned tab.
        // The token lives on in the ref and component state for exactly as long as this
        // mount does.
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      }
    }
    if (fragment.current === "") {
      setPhase("missing");
      return;
    }
    setToken(fragment.current);
    setPhase("form");
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const address = email.trim();
        // The redeem answers the server's NORMALIZED recipient (trimmed, lowercased — the
        // mail port's rule), and `minted.email` stores that answer verbatim. So the "same
        // address?" question is asked normalized on both sides: a retry that only changes
        // the casing is the same address and must re-use the kept code, not be refused as
        // spent-for-somebody-else. Review finding, watched red.
        const norm = (s: string): string => s.trim().toLowerCase();
        let code = minted !== null && norm(minted.email) === norm(address) ? minted.code : null;
        if (code === null && minted !== null) {
          // The token was already spent for a DIFFERENT address. Re-redeeming cannot work and
          // the register below would refuse the mismatched code — say the real remedy instead.
          setError(t("tokenSpent", { email: minted.email }));
          return;
        }
        if (code === null) {
          try {
            const out = await pair.redeemInvite({ token, email: address });
            code = out.invite.code;
            // The SERVER's copy of the address, not this form's: it is the one the invite is
            // actually bound to, and the one the spent-token refusal should name.
            setMinted({ code, email: out.invite.email });
          } catch (err) {
            // The one wire refusal that needs this form's own sentence — see the header.
            setError(codeOf(err) === "pairing_invalid" ? t("badToken") : messageOf(err));
            return;
          }
        }
        await auth.register({
          email: address, password, displayName: displayName.trim(), inviteCode: code,
        });
        setPassword("");
        // The invite path answers an enrollment session; `/join` resumes at the factor step
        // and carries the ceremony through recovery codes and the first mailbox. `replace`,
        // not `push`: this form must not sit in the back stack once its token is spent.
        router.replace("/join");
      } catch (err) {
        // Register refusals carry the SERVICE's own human sentences (invite taxonomy, password
        // policy) — shown verbatim, the api-client's standing rule.
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="login">
      <div className="login-card join-card">
        {/* oh | mail, split so `.wordmark em` carries accent-ink — the rendered textContent is
            what the brand suite asserts. */}
        <span className="wordmark"><b><em>oh</em>mail</b></span>

        {phase === "reading" && (
          <>
            <h1>{t("readingTitle")}</h1>
            <p className="sub">{t("reading")}</p>
          </>
        )}

        {phase === "unconfigured" && (
          <>
            <h1>{t("unavailableTitle")}</h1>
            <p className="sub" role="alert">{t("unavailableBody")}</p>
          </>
        )}

        {phase === "missing" && (
          <>
            {/* No token in the fragment — a truncated paste, a link opened without its `#…`
                half, or a token someone moved into the query (refused on purpose, see the
                mount effect). The remedy is human and one sentence long. */}
            <h1>{t("missingTitle")}</h1>
            <p className="sub" role="alert">{t("missingBody")}</p>
          </>
        )}

        {phase === "form" && (
          <>
            <h1>{t("title")}</h1>
            <p className="sub">{t("lead")}</p>

            {error && <p className="join-error" role="alert">{error}</p>}

            <form onSubmit={submit}>
              <label className="join-label" htmlFor="invite-email">{t("emailLabel")}</label>
              <input
                id="invite-email" className="join-input" type="email" autoComplete="email"
                value={email} onChange={(e) => setEmail(e.target.value)} required
              />
              <p className="join-hint">{t("emailHint")}</p>

              <label className="join-label" htmlFor="invite-name">{t("nameLabel")}</label>
              <input
                id="invite-name" className="join-input" autoComplete="name"
                value={displayName} onChange={(e) => setDisplayName(e.target.value)} required
              />

              <label className="join-label" htmlFor="invite-pw">{t("passwordLabel")}</label>
              <input
                id="invite-pw" className="join-input" type="password" autoComplete="new-password"
                minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required
              />
              <p className="join-hint">{t("passwordHint")}</p>

              <div className="join-actions">
                <Button variant="primary" type="submit" disabled={busy}>
                  {busy ? t("working") : t("createAccount")}
                </Button>
              </div>
              {/* What comes AFTER the button, said before it is pressed: a second factor and
                  recovery codes before the first mailbox connects. */}
              <p className="join-note">{t("nextNote")}</p>
            </form>
          </>
        )}
      </div>
      <p className="login-foot">
        <Icon name="shield" /> {t("footer")}
      </p>
    </div>
  );
}
