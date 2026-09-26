import { useEffect, useState } from "react";
import { ACCOUNT_ACCESS_PATH, bridgeFetch, lifecycleOf, type AccessRefusedFacts } from "./bridge-fetch.js";
import { FIRST_PAINT_VERDICT_MS, readStoredVerdict } from "../../webapp/app/shell/wall-lift.js";

/**
 * THE WALL BEFORE MAIL, IN THE WINDOW — the browser tab's rule on the Cloud door. A window whose
 * last word for this mailbox was `open` paints at once; any other asks the account's own read
 * first, bounded, and paints anyway past the bound (the bridge's 402 notice stays armed). `key` is
 * the storage owner the bridge stores the verdict under, or `null` where no hosted account is.
 */

/** A refused answer's facts, the fields the 402 carries. */
export function refusedFactsOfAnswer(body: unknown): AccessRefusedFacts | null {
  const b = body as { metered?: unknown; access?: unknown; manageUrl?: unknown; lifecycle?: unknown } | null;
  if (b === null || b.metered !== true || b.access !== "refused") return null;
  const lifecycle = lifecycleOf(b.lifecycle);
  const url = typeof b.manageUrl === "string" && b.manageUrl.length > 0 ? b.manageUrl : undefined;
  return {
    reason: lifecycle?.closedReason === "suspended" ? "suspended" : "payment_required",
    ...(url ? { manageUrl: url } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  };
}

export function useDesktopFirstPaint(
  key: string | null,
  onRefused: (facts: AccessRefusedFacts) => void,
): "open" | "asking" {
  const [opened, setOpened] = useState<string | null>(null);
  const known = key === null || readStoredVerdict(key) === "open";
  useEffect(() => {
    if (key === null || known) return;
    let live = true;
    const open = (): void => { if (live) setOpened(key); };
    const bound = setTimeout(open, FIRST_PAINT_VERDICT_MS);
    void (async () => {
      try {
        const res = await bridgeFetch(ACCOUNT_ACCESS_PATH);
        const facts = res.ok ? refusedFactsOfAnswer(await res.json().catch(() => null)) : null;
        if (live && facts !== null) onRefused(facts);
      } catch { /* no verdict: the mirror paints and the 402 notice stays armed */ }
      clearTimeout(bound);
      open();
    })();
    return () => { live = false; clearTimeout(bound); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onRefused` is a state setter
  }, [key, known]);
  return known || opened === key ? "open" : "asking";
}
