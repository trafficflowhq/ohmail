"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
// The ONE correct way out — revokes server-side and wipes the local mirror. The sign-out guard
// asserts every `auth.logout` call in this app goes through it, so never call logout directly.
import { signOut } from "../../sign-out";
import { readOwner } from "../../shell/owner-cookie";
import type { AccessRefusedFacts } from "../../api-client";

/**
 * THE LOCK SCREEN — what an account the service has refused sees instead of its mail.
 *
 * Two things it must do, and they are the reason it exists rather than a banner:
 *
 *  · say that NOTHING IS GONE. The refusal is about a payment, and the mail is on the customer's
 *    own IMAP server either way. A screen that only says "no" reads as data loss;
 *  · leave the two doors that must never be behind a lock open — signing out (this may be a
 *    shared machine) and the way back to paying, when the service supplies one. A lock with no
 *    way out is a trap, not a control.
 *
 * It deletes nothing and it wipes nothing on its own; only the sign-out button does, and that is
 * the same wipe the Settings pane's own control performs.
 */
export function AccessLock({ facts }: { facts: AccessRefusedFacts }) {
  const t = useTranslations("accessLock");
  const [signingOut, setSigningOut] = useState(false);

  const doSignOut = useCallback(async () => {
    setSigningOut(true);
    // `owner` is captured before the call: afterwards there is nobody to ask which mirror to wipe.
    await signOut(readOwner() ?? undefined);
    // `signOut` navigates on success. A refusal leaves the session live and the button available
    // again, which is the honest state — this screen has nothing else to fall back to.
    setSigningOut(false);
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">
        {facts.reason === "suspended" ? t("suspendedTitle") : t("title")}
      </h1>
      <p className="text-base leading-relaxed opacity-80">{t("kept")}</p>
      <div className="flex flex-wrap items-center gap-3">
        {/* Rendered ONLY when the service supplied a URL. A button that goes nowhere is worse
            than no button: it is the one control on this screen a person will press. */}
        {facts.manageUrl
          ? <a className="btn primary" href={facts.manageUrl}>{t("manage")}</a>
          : null}
        <Button onClick={doSignOut} disabled={signingOut}>
          {t("signOut")}
        </Button>
      </div>
    </main>
  );
}
