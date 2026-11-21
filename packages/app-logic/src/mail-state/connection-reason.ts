/**
 * WHY, IN THE WORDS THE SYNC STRIP SAID IT. The frame's connection states name a state in one closed set and in its own
 * sentences; the sync strip that stood before it also said why a mailbox is blocked, who files it and why a filing
 * waits or is stuck, and where a first sync continues. Those sentences are kept: this maps the ladder's reading to the
 * strip's sentence, and the frame says it as the notice's line (or title, where the strip's title was the fact).
 *
 * Moved word for word from the web shell (`todays-reasons.ts`), so the mail ground says it on every host. A pure
 * function: what the web shell read of itself (the reader's locale and zone) is handed in as `reader`.
 */
import { clock } from "@ohmail/client-engine";
import { filingElsewhereKey, phoneHolder, phoneHolderKey } from "../reading/reader-holder.js";
import { readingAlong } from "../reading/reading-along.js";
import type { StorageScope } from "../storage/scope.js";
import { waterlineStamp } from "../text/format.js";
import { displayAddress } from "../text/idn.js";
import type { AppLocale } from "../text/locale.js";
import type { MailState } from "./mail-state.js";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * What the frame's connection notice says in a shell's own words (the frame's `ConnectionReason`, said where the frame
 * cannot be read): `title` and `line` replace the frame's; `href` is where the state's act leads instead of Settings'
 * Mailboxes.
 */
export interface ConnectionReason {
  readonly title?: string;
  readonly line?: string;
  readonly href?: string;
}

/** The reader's own language and zone, the two things the sentences read besides the state. */
export interface ReaderClock {
  readonly locale: AppLocale;
  readonly zone: string;
}

/** The Mailboxes pane: where a mailbox's state, its block and its reconnect live. */
const MAILBOXES = "#/settings/mailboxes";

/** "14:32" in the reader's own zone, or null for an instant that does not parse. */
function clockTime(iso: string, zone: string): string | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : clock(at, zone);
}

/** How long a block has been in force, from a whole minute on. */
function since(minutes: number | null, t: Translate): string | null {
  if (minutes === null || minutes < 1) return null;
  return minutes < 60 ? t("sinceMinutes", { minutes }) : t("sinceHours", { hours: Math.floor(minutes / 60) });
}

const DAY_MS = 86_400_000;

const joined = (...parts: Array<string | null | undefined>): string => parts.filter((p) => p).join(" · ");

/**
 * The strip's sentence for the states the frame's set names but does not word. `t` reads the `sync` namespace, `tm` the
 * `mailboxes` one; `managed` says whether a server's claim is ohmail Cloud's; `scope` is whose choice to read along
 * is asked, the frame's own.
 */
export function connectionReason(
  state: MailState | null,
  t: Translate,
  tm: Translate,
  managed: boolean,
  scope: StorageScope,
  reader: ReaderClock,
): ConnectionReason | null {
  if (state === null) return null;
  switch (state.key) {
    case "behind": {
      /* NEW MAIL IS LATE: since when, whole days from 24 hours on; "on us" only of our own service, which alone is Cloud. */
      const at = state.asOf === null ? NaN : Date.parse(state.asOf);
      const stamp = Number.isNaN(at) ? "" : waterlineStamp(state.asOf!, new Date(), reader.locale);
      const hasSince = stamp === "" ? "no" : "yes";
      const days = Number.isNaN(at) ? 0 : Math.max(0, Math.floor((Date.now() - at) / DAY_MS));
      return {
        title: days >= 1 ? t("behindTitleDays", { days }) : t("behindTitle"),
        line: !managed
          ? t("behindLineServer", { hasSince, since: stamp })
          : days >= 1
            ? t("behindLineCloudDay", { since: stamp })
            : t("behindLineCloud", { hasSince, since: stamp }),
      };
    }
    case "blocked": {
      /* A reason this build does not know still gets a sentence: the server owns a closed set a deploy can widen. */
      const why =
        state.reason === "organized_elsewhere_cloud" && !managed
          ? t("blockedClaimedByServer")
          : state.reason
            ? t(`blocked_${state.reason}`)
            : t("blockedUnknown");
      /* These remedies belong on the notice's line, not as a long bold heading. */
      if (state.reason === "mailbox_full" || state.reason === "provider_unavailable") {
        return { line: joined(why, since(state.minutes ?? null, t)), href: MAILBOXES };
      }
      /* The reason is the fact, as the strip's title was; the mailbox and how long under it. */
      return {
        title: why,
        line:
          joined(
            state.address === null ? null : displayAddress(state.address),
            since(state.minutes ?? null, t),
          ) || undefined,
        href: MAILBOXES,
      };
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
      return filingReason(state, t, tm, managed, scope, reader.zone);
    default:
      return null;
  }
}

function filingReason(
  state: MailState,
  t: Translate,
  tm: Translate,
  managed: boolean,
  scope: StorageScope,
  zone: string,
): ConnectionReason | null {
  const f = state.filing ?? null;
  /* An older server says no more than the count: the strip's sentence for it, and the mailbox where known. */
  if (f === null) {
    return {
      title: t("filing", { count: state.pending }),
      ...(state.address ? { line: t("filingWhere", { address: displayAddress(state.address) }) } : {}),
    };
  }
  /* Somebody who chose to read along here is not told again who files it; the strip fell through to our own side. */
  const along = Boolean(
    f.who &&
    readingAlong(
      f.who.mailboxId,
      { kind: f.who.kind, name: f.who.name, stopped: f.who.stopped, since: f.who.since },
      scope,
    ),
  );
  if (f.arm === "elsewhere" && !along) {
    const name = f.who?.name ?? "";
    const phone = phoneHolder(f.who, f.who?.stopped === true);
    const title = phone
      ? tm(phoneHolderKey(phone, "full"), { name })
      : t(
          filingElsewhereKey(
            { kind: f.who?.kind ?? null, name: f.who?.name ?? null, stopped: f.who?.stopped === true },
            "takeover",
            managed,
          ),
          { name },
        );
    return { title, line: t("filingElsewhere", { count: f.count }), href: MAILBOXES };
  }
  const where =
    f.mailboxes > 1
      ? t("filingMailboxes", { count: f.mailboxes })
      : f.first
        ? f.first.displayName?.trim() || displayAddress(f.first.address)
        : null;
  const why = f.reasonsDiffer ? t("filingReasonsDiffer") : t(`filingReason_${f.reason ?? "none"}`);
  const href = f.first ? `${MAILBOXES}?mailbox=${encodeURIComponent(f.first.id)}` : MAILBOXES;
  if (f.arm === "stuck") {
    const minutes = f.waitedMinutes ?? 0;
    return {
      title:
        minutes >= 60
          ? t("filingStuckHours", { count: f.count, hours: Math.floor(minutes / 60) })
          : t("filingStuck", { count: f.count, minutes }),
      line: where === null ? why : t("filingStuckWhy", { where, reason: why }),
      href,
    };
  }
  if (f.arm === "waiting") {
    return {
      title: t("filingWaiting", { count: f.count }),
      line: t("filingWaitingWhy", {
        where: where ?? "—",
        reason: why,
        at: (f.nextAttemptAt && clockTime(f.nextAttemptAt, zone)) || "—",
      }),
      href,
    };
  }
  const asOf = f.asOf ? clockTime(f.asOf, zone) : null;
  /* Working: the strip's count sentence ("on your mail server" is the half that matters), with the last pass or the mailbox. */
  const title = t("filing", { count: state.pending });
  if (f.lastPassSeconds !== null && f.lastPassSeconds !== undefined && asOf) {
    const ago =
      f.lastPassSeconds < 90
        ? t("filingPassSeconds", { seconds: f.lastPassSeconds })
        : t("filingPassMinutes", { minutes: Math.floor(f.lastPassSeconds / 60) });
    return { title, line: t("filingPass", { ago, at: asOf }) };
  }
  if (state.address === null) return { title };
  return {
    title,
    line: asOf
      ? t("filingWhereAsOf", { address: displayAddress(state.address), at: asOf })
      : t("filingWhere", { address: displayAddress(state.address) }),
  };
}
