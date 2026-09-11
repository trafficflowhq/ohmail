"use client";

/**
 * "This browser is not keeping your decisions" — one quiet strip, said once per session.
 * `UpdateNotice`'s shape and slot, for its reason: a fact about the APP has to be rendered by the
 * shell, or only the people standing in the view that remembered it ever see it. Absent from the
 * DOM until a durable write has actually been refused, and it can be put away — `durable.ts` holds
 * the latch, so a dismissal is not undone by the next refused write. The copy sits in `session`
 * rather than a namespace of its own: it is a statement about what this browsing session can keep,
 * and the desktop bundle carries only the namespaces the shell already reads.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { DURABILITY_LOST_EVENT, dismissDurabilityLost, durabilityLost } from "./durable";

/**
 * Adopt what the module already knows at mount, then listen. Not the current value as the
 * initial state: a server render has none, and reading one during render would be a hydration
 * mismatch — `useUpdateOffer`'s own reason.
 */
export function useDurabilityLost(): boolean {
  const [lost, setLost] = useState(false);
  useEffect(() => {
    const read = () => { setLost(durabilityLost()); };
    read();
    window.addEventListener(DURABILITY_LOST_EVENT, read);
    return () => { window.removeEventListener(DURABILITY_LOST_EVENT, read); };
  }, []);
  return lost;
}

export function DurabilityNotice() {
  const t = useTranslations("session");
  const lost = useDurabilityLost();
  if (!lost) return null;
  return (
    <div className="upd-bar ohx-durability" role="status">
      <span>{t("storageRefused")}</span>
      <button type="button" className="upd-later" onClick={dismissDurabilityLost}>
        {t("storageRefusedDismiss")}
      </button>
    </div>
  );
}
