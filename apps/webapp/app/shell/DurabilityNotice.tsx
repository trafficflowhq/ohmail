"use client";

/**
 * "This browser is not keeping your decisions" — one quiet strip, said once per session.
 * The shell's app-level strip, for its reason: a fact about the APP has to be rendered by the
 * shell, or only the people standing in the view that remembered it ever see it. Absent from the
 * DOM until a durable write has actually been refused, and it can be put away — `durable.ts` holds
 * the latch, so a dismissal is not undone by the next refused write. The copy sits in `session`
 * rather than a namespace of its own: it is a statement about what this browsing session can keep,
 * and the desktop bundle carries only the namespaces the shell already reads.
 */

import { useTranslations } from "next-intl";

import { dismissDurabilityLost } from "@ohmail/app-logic/storage/durable";
// The reader moved beside the latch, so the mail ground's notice reads the same one on every host.
import { useDurabilityLost } from "@ohmail/app-logic/storage/durability-lost";

export { useDurabilityLost };

export function DurabilityNotice() {
  const t = useTranslations("session");
  const lost = useDurabilityLost();
  if (!lost) return null;
  return (
    <div className="ohx-durability" role="status">
      <span>{t("storageRefused")}</span>
      <button type="button" className="upd-later" onClick={dismissDurabilityLost}>
        {t("storageRefusedDismiss")}
      </button>
    </div>
  );
}
