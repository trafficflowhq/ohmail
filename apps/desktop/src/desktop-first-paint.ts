import { useEffect, useState } from "react";
import { ACCOUNT_ACCESS_PATH, bridgeFetch, lifecycleOf, type AccessRefusedFacts } from "./bridge-fetch.js";
import { FIRST_PAINT_VERDICT_MS, readStoredVerdict } from "@ohmail/app-logic/doors/wall-lift";

/**
 * THE WALL BEFORE MAIL, IN THE WINDOW — the browser tab's rule on the Cloud door. A window whose
 * last word for this mailbox was `open` paints at once; any other asks the account's own read
 * first, bounded, and paints anyway past the bound (the bridge's 402 notice stays armed). `key` is
 * the storage owner the bridge stores the verdict under, or `null` where no hosted account is.
 * Before the engine has named a mailbox, {@link useDesktopUnnamedWall} asks instead.
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

/** How often the window asks the account again while its engine has named no mailbox. */
export const UNNAMED_ACCESS_MS = 10_000;

/** The engine's answer to a relayed request while its mirror cannot reach the server. */
const OFFLINE_CODE = "offline_read_only";

/**
 * THE WALL BEFORE A MAILBOX IS NAMED. A Cloud door's engine names its mailbox from the account's
 * list, and a refused account's list is a 402: no mailbox is shown, so neither the first paint nor
 * a relayed 402 can raise the lock. While `asking` (an account door signed in, no mailbox shown, no
 * lock up) the account's own read is asked at once and every {@link UNNAMED_ACCESS_MS}; a refused
 * answer is the lock's facts. `"unreachable"` while the engine answers it offline: its pulls have
 * not reached the server, which the boot line then says instead of "Opening your mailbox…".
 */
export function useDesktopUnnamedWall(
  asking: boolean,
  onRefused: (facts: AccessRefusedFacts) => void,
): "asking" | "unreachable" {
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    setUnreachable(false);
    if (!asking) return;
    let live = true;
    const ask = async (): Promise<void> => {
      try {
        const res = await bridgeFetch(ACCOUNT_ACCESS_PATH);
        const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
        if (!live) return;
        setUnreachable(res.status === 503 && body?.error?.code === OFFLINE_CODE);
        const facts = res.ok ? refusedFactsOfAnswer(body) : null;
        if (facts !== null) onRefused(facts);
      } catch { /* the engine did not answer: asked again on the clock */ }
    };
    void ask();
    const clock = setInterval(() => void ask(), UNNAMED_ACCESS_MS);
    return () => { live = false; clearInterval(clock); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onRefused` is a state setter
  }, [asking]);
  return asking && unreachable ? "unreachable" : "asking";
}
