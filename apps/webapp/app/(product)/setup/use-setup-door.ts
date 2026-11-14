"use client";

/**
 * First-run setup — the guided ceremony a fresh self-host server opens with. `docker compose up` leaves a server with
 * zero accounts, one ownerless setup token in its own log, and `/hello` answering `needsSetup: true`; the operator
 * pastes the token, chooses their sign-in, and the page drives `POST /pair/redeem` → `POST /auth/register` (the
 * token's record makes the account start email-verified) → an enrollment session → `/join`, which resumes at the
 * second-factor step.
 */

/**
 * It replaces the hand-typed `curl /pair/redeem` the guides described. The gate: the form renders only after a FRESH
 * `GET /hello` answers `needsSetup: true` — a database fact (users == 0), not a build flag. Every other answer gets
 * an honest screen: `false` + a live session → `/join` (the mid-enrollment reload); `false`, no session → "already
 * set up"; no answer → retry, never a form whose submit would fail one step later.
 */

/**
 * Redeem and register are ONE submit because the setup token is single-use: a two-screen ceremony would strand anyone
 * who fell between. If the register half fails after a successful redeem, the minted invite code (15-minute life) is
 * KEPT, keyed to the address it is bound to, so a retry re-uses it instead of burning a token that can no longer be
 * redeemed; changing the address after a successful redeem is the one unrecoverable edit, and the refusal says the
 * true remedy — restart the server for a fresh token.
 */

/**
 * The wrong-token refusal is THIS form's own sentence, not the service's: `pairing_invalid` ends "ask whoever minted
 * it", right for every pairing token except this one — the setup token's minter is the server itself. Same mapping
 * discipline as `LoginScreen`.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { apiConfigured, auth, codeOf, messageOf, pair } from "../../api-client";
import { serverHello } from "../../hello";
import { revokedWipeSettled } from "../../revoked-door";

/**
 * What this page knows about the server, in order of discovery. `checking` is the mount state;
 * everything else is a `/hello` answer wearing a screen.
 */
export type Phase = "checking" | "setup" | "settled" | "unreachable";

/** What the setup's ceremony holds, and its acts: the four blanks it reads, the gate and the one submit. */
export interface SetupCeremony {
  phase: Phase;
  busy: boolean;
  error: string | null;
  token: string;
  setToken(v: string): void;
  email: string;
  setEmail(v: string): void;
  displayName: string;
  setDisplayName(v: string): void;
  password: string;
  setPassword(v: string): void;
  checkServer(): Promise<void>;
  submit(e: { preventDefault(): void }): void;
}

export function useSetupDoor(): SetupCeremony {
  const t = useTranslations("setup");
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  /** A redeem that succeeded while register did not — kept so a retry never re-burns the token. */
  const [minted, setMinted] = useState<{ code: string; email: string } | null>(null);

  /**
   * The gate, re-runnable (the unreachable screen's "try again" is this function). The session
   * probe runs only on the settled branch: a fresh server has nobody to have a session, and the
   * probe's one job is to route a mid-enrollment reload back to `/join` instead of telling the
   * person who JUST created the account that somebody else already did.
   */
  const checkServer = useCallback(async () => {
    setPhase("checking");
    if (!apiConfigured()) {
      setPhase("unreachable");
      return;
    }
    const hello = await serverHello();
    if (hello === null) {
      setPhase("unreachable");
      return;
    }
    if (hello.needsSetup) {
      setPhase("setup");
      return;
    }
    let live = false;
    try {
      await auth.session();
      live = true;
    } catch {
      /* no session: the settled screen */
    }
    // A revoke this read heard: that account's copy is gone before the page sends anyone on.
    await revokedWipeSettled();
    // Any live session — enrollment or full. `/join`'s bootstrap derives the true step.
    if (live) router.replace("/join");
    else setPhase("settled");
  }, [router]);

  useEffect(() => { void checkServer(); }, [checkServer]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        // A revoke's wipe this browser still owes is done before the token is spent.
        await revokedWipeSettled();
        const address = email.trim();
        let code = minted !== null && minted.email === address ? minted.code : null;
        if (code === null && minted !== null) {
          // The token was already spent for a DIFFERENT address. Re-redeeming cannot work and
          // the register below would refuse the mismatched code — say the real remedy instead.
          setError(t("tokenSpent", { email: minted.email }));
          return;
        }
        if (code === null) {
          try {
            const out = await pair.redeemInvite({ token: token.trim(), email: address });
            code = out.invite.code;
            setMinted({ code, email: address });
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
        // The invite path answers an enrollment session; `/join` resumes at the factor step and
        // carries the ceremony through recovery codes and the first mailbox. `replace`, not
        // `push`: the setup form must not sit in the back stack once its token is spent.
        // (The public-path `{status:"ok"}` arm is unreachable with an invite code; routing to
        // `/join` would still land on the right step if it ever answered.)
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

  return {
    phase, busy, error, token, setToken, email, setEmail, displayName, setDisplayName, password, setPassword,
    checkServer, submit,
  };
}
