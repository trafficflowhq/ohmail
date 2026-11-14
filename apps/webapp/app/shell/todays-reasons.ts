/**
 * WHY, IN TODAY'S WORDS. The frame's connection states name a state in one closed set and in its own sentences; the
 * sync strip that stood before it also said why a mailbox is blocked, who files it and why a filing waits or is stuck,
 * and where a first sync continues. Those sentences are kept: this maps the ladder's reading to today's sentence, as
 * the strip worded it, and the frame says it as the notice's line (or title, where the strip's title was the fact).
 * `todaysReason` is pure; each arm is the strip's own (`SyncBar.tsx` until the frame replaced it), and leaves when `mailboxes` (task
 * 51) words these states against their pictures.
 */
import { useTranslations } from "next-intl";
import { useConnectionFeed, type ConnectionReason } from "@ohmail/app/frame";
import { useManagedService } from "@ohmail/app-logic/doors/managed-service";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";
import { useBrowserOnline } from "@ohmail/app-logic/session/browser-online";
import { filingElsewhereKey, phoneHolder, phoneHolderKey } from "@ohmail/app-logic/reading/reader-holder";
import { readingAlong } from "@ohmail/app-logic/reading/reading-along";
import { clock } from "@ohmail/client-engine";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { waterlineStamp } from "./format";
import { activeFormatLocale, activeFormatZone } from "./locale";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The Mailboxes pane: where a mailbox's state, its block and its reconnect live. */
const MAILBOXES = "#/settings/mailboxes";

/** "14:32" in the reader's own zone, or null for an instant that does not parse. */
function clockTime(iso: string): string | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : clock(at, activeFormatZone());
}

/** How long a block has been in force, from a whole minute on. */
function since(minutes: number | null, t: Translate): string | null {
  if (minutes === null || minutes < 1) return null;
  return minutes < 60 ? t("sinceMinutes", { minutes }) : t("sinceHours", { hours: Math.floor(minutes / 60) });
}

const DAY_MS = 86_400_000;

const joined = (...parts: Array<string | null | undefined>): string => parts.filter((p) => p).join(" · ");

/**
 * Today's sentence for the states the frame's set names but does not word. `t` reads the `sync` namespace, `tm` the
 * `mailboxes` one; `managed` says whether a server's claim is ohmail Cloud's.
 */
export function todaysReason(state: MailState | null, t: Translate, tm: Translate, managed: boolean): ConnectionReason | null {
  if (state === null) return null;
  switch (state.key) {
    case "behind": {
      /* NEW MAIL IS LATE: since when, whole days from 24 hours on; "on us" only of our own service, which alone is Cloud. */
      const at = state.asOf === null ? NaN : Date.parse(state.asOf);
      const stamp = Number.isNaN(at) ? "" : waterlineStamp(state.asOf!, new Date(), activeFormatLocale());
      const hasSince = stamp === "" ? "no" : "yes";
      const days = Number.isNaN(at) ? 0 : Math.max(0, Math.floor((Date.now() - at) / DAY_MS));
      return {
        title: days >= 1 ? t("behindTitleDays", { days }) : t("behindTitle"),
        line: !managed ? t("behindLineServer", { hasSince, since: stamp })
          : days >= 1 ? t("behindLineCloudDay", { since: stamp }) : t("behindLineCloud", { hasSince, since: stamp }),
      };
    }
    case "blocked": {
      /* A reason this build does not know still gets a sentence: the server owns a closed set a deploy can widen. */
      const why = state.reason === "organized_elsewhere_cloud" && !managed ? t("blockedClaimedByServer")
        : state.reason ? t(`blocked_${state.reason}`) : t("blockedUnknown");
      /* The reason is the fact, as the strip's title was; the mailbox and how long under it. */
      return { title: why, line: joined(state.address === null ? null : displayAddress(state.address), since(state.minutes ?? null, t)) || undefined, href: MAILBOXES };
    }
    case "importing": {
      if (state.continuesAtFolder === null || state.continuesAtFolder === undefined) return null;
      return { line: t("importingContinuesAt", { folder: state.continuesAtFolder }) };
    }
    case "awaiting":
      return {
        line: state.address
          ? t("awaitingWhere", { address: displayAddress(state.address), minutes: state.minutes ?? 0 })
          : t("awaitingFor", { minutes: state.minutes ?? 0 }),
        ...(state.slow ? { title: t("awaitingSlow"), href: MAILBOXES } : {}),
      };
    case "filing":
      return filingReason(state, t, tm, managed);
    default:
      return null;
  }
}

function filingReason(state: MailState, t: Translate, tm: Translate, managed: boolean): ConnectionReason | null {
  const f = state.filing ?? null;
  /* An older server says no more than the count: today's sentence for it, and the mailbox where known. */
  if (f === null) {
    return { title: t("filing", { count: state.pending }), ...(state.address ? { line: t("filingWhere", { address: displayAddress(state.address) }) } : {}) };
  }
  /* Somebody who chose to read along here is not told again who files it; the strip fell through to our own side. */
  const along = Boolean(f.who && readingAlong(f.who.mailboxId, { kind: f.who.kind, name: f.who.name, stopped: f.who.stopped, since: f.who.since }));
  if (f.arm === "elsewhere" && !along) {
    const name = f.who?.name ?? "";
    const phone = phoneHolder(f.who, f.who?.stopped === true);
    const title = phone
      ? tm(phoneHolderKey(phone, "full"), { name })
      : t(filingElsewhereKey({ kind: f.who?.kind ?? null, name: f.who?.name ?? null, stopped: f.who?.stopped === true }, "takeover", managed), { name });
    return { title, line: t("filingElsewhere", { count: f.count }), href: MAILBOXES };
  }
  const where = f.mailboxes > 1 ? t("filingMailboxes", { count: f.mailboxes })
    : f.first ? (f.first.displayName?.trim() || displayAddress(f.first.address)) : null;
  const why = f.reasonsDiffer ? t("filingReasonsDiffer") : t(`filingReason_${f.reason ?? "none"}`);
  const href = f.first ? `${MAILBOXES}?mailbox=${encodeURIComponent(f.first.id)}` : MAILBOXES;
  if (f.arm === "stuck") {
    const minutes = f.waitedMinutes ?? 0;
    return {
      title: minutes >= 60 ? t("filingStuckHours", { count: f.count, hours: Math.floor(minutes / 60) }) : t("filingStuck", { count: f.count, minutes }),
      line: where === null ? why : t("filingStuckWhy", { where, reason: why }),
      href,
    };
  }
  if (f.arm === "waiting") {
    return {
      title: t("filingWaiting", { count: f.count }),
      line: t("filingWaitingWhy", { where: where ?? "—", reason: why, at: (f.nextAttemptAt && clockTime(f.nextAttemptAt)) || "—" }),
      href,
    };
  }
  const asOf = f.asOf ? clockTime(f.asOf) : null;
  /* Working: today's count sentence ("on your mail server" is the half that matters), with the last pass or the mailbox. */
  const title = t("filing", { count: state.pending });
  if (f.lastPassSeconds !== null && f.lastPassSeconds !== undefined && asOf) {
    const ago = f.lastPassSeconds < 90 ? t("filingPassSeconds", { seconds: f.lastPassSeconds })
      : t("filingPassMinutes", { minutes: Math.floor(f.lastPassSeconds / 60) });
    return { title, line: t("filingPass", { ago, at: asOf }) };
  }
  if (state.address === null) return { title };
  return { title, line: asOf ? t("filingWhereAsOf", { address: displayAddress(state.address), at: asOf }) : t("filingWhere", { address: displayAddress(state.address) }) };
}

/* Where the connection's words lead, a browser goes: one function for the life of the page. */
const follow = (href: string): void => window.location.assign(href);

/** Today's reading of the connection, fed to the frame: the ladder's state, the network, and today's why. */
export function useTodaysConnection(mail: MailState | null, setupHref: string | null, copyAsOf: string | null = null): void {
  const t = useTranslations("sync");
  const tm = useTranslations("mailboxes");
  const managed = useManagedService();
  const online = useBrowserOnline();
  useConnectionFeed({ mail, online, setupHref, copyAsOf, follow, reason: todaysReason(mail, t as unknown as Translate, tm as unknown as Translate, managed) });
}
