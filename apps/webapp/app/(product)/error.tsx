"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { buildId } from "../build-id";
import { reportRenderError } from "../error-report";
import { readOwner } from "../shell/owner-cookie";
import { signOut } from "../sign-out";
import { signOutTrouble } from "../sign-out-trouble";

/**
 * THE MAIL CLIENT'S OWN ERROR PAGE. `ViewBoundary` keeps a throw inside one pile; this catches
 * the level above it — a page, the shell chrome around it, a provider under this group's layout —
 * where the alternative is Next's "Application error", a blank tab with no sentence and no way
 * out. It renders INSIDE `(product)/layout.tsx`, so unlike `app/error.tsx` it has the stylesheet,
 * the locale and the API client: the words come from the catalogue and the way out is the app's
 * real sign-out rather than a second copy of one.
 */
export default function ProductError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("appError");
  /* Settings → Account's sentences, not new ones: one sign-out, one taxonomy, one set of words. */
  const ta = useTranslations("account");
  const [signedIn, setSignedIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { reportRenderError(error.digest); }, [error.digest]);
  /* In an effect and not in the render: the cookie is invisible to the server, and reading it
     while rendering would paint a control on the client that the server's HTML did not have. */
  useEffect(() => { setSignedIn(readOwner() !== null); }, []);

  /* The outcomes and their order are `signOutTrouble`'s; only a finished sign-out leaves.
     Pressing again is safe: the session and the cookie are already gone. */
  const doSignOut = useCallback(async () => {
    setSigningOut(true);
    setTrouble(null);
    const said = signOutTrouble(await signOut(readOwner() ?? undefined));
    if (said !== null) {
      setTrouble(said.key === "signOutServerRefused" ? ta(said.key, { reason: said.reason }) : ta(said.key));
      setSigningOut(false);
      return;
    }
    window.location.assign("/login");
  }, [ta]);

  return (
    <main className="page-fail">
      <div className="view-fail-card">
        <h1>{t("title")}</h1>
        <p>{t("body")}</p>
        <div className="page-fail-acts">
          {/* A reload and not Next's `reset()`: `reset` re-renders the tree that just threw, which
              on a broken record throws again and reads as a dead button. The view boundary's
              fallback reloads for the same reason. */}
          <Button onClick={() => { window.location.reload(); }}>{t("reload")}</Button>
          {signedIn ? (
            <Button onClick={doSignOut} disabled={signingOut}>
              {signingOut ? ta("signOutBusy") : t("signOut")}
            </Button>
          ) : null}
        </div>
        {/* `acct-warn` and not a near-copy of it: these ARE the account pane's sentences. */}
        {trouble ? <p className="acct-warn" role="alert">{trouble}</p> : null}
        <p className="page-fail-fact">{buildId()}</p>
        {error.digest ? (
          <p className="page-fail-fact">
            <span>{t("reference")}</span>{" "}
            <code>{error.digest}</code>{" "}
            <button
              type="button"
              className="page-fail-copy"
              onClick={() => {
                // Refused outright in an insecure context and deniable at any time. It must not
                // throw, and it need not succeed: the reference is selectable text either way.
                void navigator.clipboard?.writeText(error.digest!).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? t("copied") : t("copy")}
            </button>
          </p>
        ) : null}
      </div>
    </main>
  );
}
