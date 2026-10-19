"use client";

/**
 * WHERE THE OHBOX'S MAIL WENT — one quiet line under the Ohbox title (row
 * OHBOX-QUIET-READS-AS-STALLED). A calm Ohbox over mail the sender rules filed elsewhere read as a
 * stopped sync, so the line says when the mailboxes were last checked and how many letters went to
 * which pile since the person was here, each count a link to its pile. When the sync is unhealthy it
 * says the strip's own title instead (`useStripTitle`), never a second opinion. Not a live region:
 * the sync strip stays the one place a screen reader hears about sync.
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { lastCheckedAt, type FiledPile, type FiledSince } from "@ohmail/client-engine";
import { useMailState } from "./MailStateProvider";
import { useStripTitle } from "./SyncBar";
import { agoStamp } from "./format";
import { documentHidden } from "./document-hidden";
import { go, goScreener } from "./routing";
import type { MailStateKey } from "./mail-state";

/** States the line says nothing in: the strip's import and first-sync sentences carry them. */
const SILENT: ReadonlySet<MailStateKey> = new Set(["importing", "awaiting", "noMailbox"]);
/** States the line reports its own facts in; every other key yields to the strip's title. */
const CALM: ReadonlySet<MailStateKey> = new Set(["quiet", "filing"]);

/** The relative "Checked" time moves by the minute. */
export const WHERE_TICK_MS = 60_000;

const PILE_HREF: Readonly<Record<FiledPile, string>> = {
  reads: "#/reads",
  receipts: "#/receipts",
  screened: "#/screener/screened",
  spam: "#/screener/spam",
};

/** Through the routing verbs, so the view-switch timing mark starts at the press. */
function openPile(pile: FiledPile): void {
  if (pile === "reads" || pile === "receipts") go(pile);
  else goScreener(pile);
}

export function OhboxWhereLine({ filed, hostOffline = false, demo, junkReadable = false }: {
  /** `filedSinceVisit` over the presented mirror, or `null` where no count can be stated. */
  filed: FiledSince | null;
  /** A paired desktop whose host is not answering — the strip's own withholding of `stale`. */
  hostOffline?: boolean;
  demo: boolean;
  /**
   * The Screener's third segment is the live Junk window: the shell's `junkReadable`, the gate it
   * hands ScreenerView its `junk` on ("Use folders" on and a server to read it from). That window
   * lists the provider's own Junk folder, not the Spam pile counted here, and what ohmail's own
   * patterns set aside, or a mailbox with no Junk folder keeps, never reaches it. So the spam count
   * is left out, and every count the line shows opens a view that lists those letters.
   */
  junkReadable?: boolean;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("rail");
  const ts = useTranslations("screener");
  const binding = useMailState();
  const { state, mailboxes } = binding;
  const title = useStripTitle(hostOffline);
  const [, setTick] = useState(0);

  const silent = demo || !state.settled || state.owed || SILENT.has(state.key);
  const calm = !silent && CALM.has(state.key);
  /* The line's own clock, only while it may show a "Checked" time and somebody can see it. It also
     wakes on the tab's return, so facts too old to say "Checked" give way as soon as they are read. */
  const ticking = calm && mailboxes !== null;
  useEffect(() => {
    if (!ticking) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const arm = (): void => {
      if (id !== null) clearInterval(id);
      id = null;
      if (documentHidden()) return;
      setTick((n) => n + 1);
      id = setInterval(() => setTick((n) => n + 1), WHERE_TICK_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      if (id !== null) clearInterval(id);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [ticking]);

  if (silent) return null;
  if (!calm) return title === null ? null : <p className="ohbox-where">{title}</p>;

  const nowMs = Date.now();
  const checked = lastCheckedAt(mailboxes, binding.factsReadAt?.() ?? null, nowMs);
  /* Only piles whose linked view lists the counted letters (`junkReadable`). */
  const counts = (filed?.counts ?? []).filter((c) => !(junkReadable && c.pile === "spam"));
  if (checked === null && counts.length === 0) return null;

  let checkedPart: ReactNode = null;
  if (checked !== null) {
    const ago = agoStamp(checked, nowMs);
    checkedPart = t.rich("whereChecked", {
      when: ago.rel,
      time: (chunks) => <time dateTime={checked} title={ago.abs}>{chunks}</time>,
    });
  }
  const label = (pile: FiledPile): string =>
    pile === "reads" ? tr("reads")
      : pile === "receipts" ? tr("receipts")
        : pile === "screened" ? ts("segScreened") : ts("segSpam");

  return (
    <p className="ohbox-where">
      {checkedPart}
      {checkedPart !== null && counts.length > 0 ? " · " : null}
      {counts.length > 0 ? (
        <>
          {t("whereSince", { lead: checkedPart === null ? "true" : "false" })}{" "}
          {counts.map((c, i) => (
            <span key={c.pile}>
              {i > 0 ? ", " : null}
              <a
                href={PILE_HREF[c.pile]}
                onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                  e.preventDefault();
                  openPile(c.pile);
                }}
              >
                {t("whereTo", { count: c.count, pile: label(c.pile) })}
              </a>
            </span>
          ))}
        </>
      ) : null}
    </p>
  );
}
