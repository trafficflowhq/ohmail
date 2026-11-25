/**
 * THE CONNECTION STATES: one closed set, read off the mail state ladder, the browser's network, the session
 * and the paired host's own signal. `connectionOf` is pure; `useConnectionNotice` says the state as the
 * notice the slot draws, in the frame's words. A failing read is "reconnecting", never "no mailbox": could
 * not look is not nothing there.
 */
import { useEffect, useState } from "react";
import {
  mailboxErrorNeedsAction,
  noticeDelayPassed,
  NOTICE_DELAY_MS,
  type MailState,
  type StoreRefusals,
} from "@ohmail/app-logic/mail-state/mail-state";
import { MIRROR_STORE_REFUSED_DETAIL, mailboxErrorKey } from "@ohmail/app-logic/mail-state/mailbox-error-key";
import type { HostConnectionState, HostSession } from "../host/index.js";
import type { ConnectionReason } from "./commands.js";
import type { FrameNotice, Recover } from "./contract.js";
import { useLocale, useText, useTimeZone, type Locale, type Text } from "../text/index.js";

export const CONNECTION_KINDS = [
  "signedOut",
  "ownerLost",
  "noMailbox",
  "offline",
  "hostQuiet",
  "mailServerDown",
  "mailboxPassword",
  "mailboxSync",
  "reconnecting",
  "late",
  "behind",
  "firstSync",
  "filing",
  "filingElsewhere",
  "filingStuck",
  "filingWaits",
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export interface ConnectionInput {
  /** The ladder's reading, or null before the first. */
  readonly mail: MailState | null;
  /** The browser's network. */
  readonly online: boolean;
  readonly session: HostSession["state"];
  /** The paired host's own signal: the link to the other computer has gone quiet. */
  readonly host: HostConnectionState | null;
  /** When the copy on screen last finished a sync, as the host's copy-age read says it; null where none is known. */
  readonly copyAsOf?: string | null;
}

/* `behind` is the server's word as last read: offline it cannot be read again, and being offline is the nearer fact. */
const OFFLINE_SAYS: ReadonlySet<string> = new Set(["stale", "catchingUp", "failing", "behind"]);
const SERVER_DOWN: ReadonlySet<string> = new Set([
  "err_connect",
  "err_tls",
  "err_timeout",
  "err_timeout_local",
]);

/** The class of a mailbox's refusal, by the key its sentence is said with. */
export function mailboxErrorClass(mail: MailState): "mailServerDown" | "mailboxPassword" | "mailboxSync" {
  const { key } = mailboxErrorKey(
    mail.errorCode,
    mail.errorDetail,
    undefined,
    undefined,
    mail.errorLocalServer,
  );
  if (mail.unreachable === true || SERVER_DOWN.has(key)) return "mailServerDown";
  if (key.startsWith("err_auth") || key.startsWith("err_credential")) return "mailboxPassword";
  return "mailboxSync";
}

export function connectionOf(input: ConnectionInput): ConnectionKind | null {
  /* A refused session: the host's own card speaks. */
  if (input.session === "refused") return null;
  const key = input.mail?.key ?? null;
  if (key === "stopped") return "signedOut";
  if (key === "ownerLost") return "ownerLost";
  if (key === "noMailbox") return "noMailbox";
  if (!input.online && key !== null && OFFLINE_SAYS.has(key)) return "offline";
  /* The host's silence outranks every lower reading, catching up among them. */
  if (input.host !== null) return "hostQuiet";
  if (key === "mailboxError" && input.mail) return mailboxErrorClass(input.mail);
  if (key === "blocked") return "mailboxSync";
  if (key === "failing") return "reconnecting";
  /* The server answers and says it is not fetching new mail: calm, nothing to press, gone when it fetches again. */
  if (key === "behind") return "late";
  if (key === "stale" || key === "catchingUp") return "behind";
  if (key === "importing" || key === "awaiting") return "firstSync";
  if (key === "filing") {
    const arm = input.mail?.filing?.arm;
    return arm === "stuck"
      ? "filingStuck"
      : arm === "waiting"
        ? "filingWaits"
        : arm === "elsewhere"
          ? "filingElsewhere"
          : "filing";
  }
  return null;
}

/** What a connection notice's answers do. A `none` recovery withholds the control. */
export interface ConnectionActs {
  readonly recover: Recover;
  readonly mailboxes: () => void;
  /** Where Write to us leads: a copy this computer cannot store into is ours to fix. */
  readonly help: () => void;
  readonly follow: (href: string) => void;
  /** Where Connect leads a person with no mailbox; absent, to the mailboxes. */
  readonly connect?: () => void;
}

/** The first sync's sentence is spoken at most once a poll and once a twentieth of the way: a sentence, not a stutter. */
export const ANNOUNCE_MS = 8_000;
const ANNOUNCE_STEP = 0.05;

export function useGatedWords(say: string | null, progress: number | null): string | null {
  const [last, setLast] = useState<{ words: string; at: number; step: number } | null>(null);
  const step = progress === null ? -1 : Math.floor(progress / ANNOUNCE_STEP);
  const changed =
    say !== null &&
    (last === null || ((step === -1 || step !== last.step) && (say !== last.words || step !== last.step)));
  const remaining = last === null ? 0 : ANNOUNCE_MS - (Date.now() - last.at);

  // Publish an eligible count in the render that received it. Only a count still inside
  // the throttle window needs a timer and a later render.
  if (say === null && last !== null) setLast(null);
  if (changed && remaining <= 0) setLast({ words: say, at: Date.now(), step });

  useEffect(() => {
    if (!changed || remaining <= 0) return;
    const timer = setTimeout(() => setLast({ words: say, at: Date.now(), step }), remaining);
    return () => clearTimeout(timer);
  }, [changed, remaining, say, step]);

  return say === null ? null : (last?.words ?? say);
}

/** A refusal count as a person reads it: the figure in the reader's locale, or "more than N" for a floor. */
function refusalsFigure(r: StoreRefusals, locale: Locale, tm: Text): string {
  const figure = new Intl.NumberFormat(locale).format(r.count);
  return r.exact ? figure : tm("storeRefusalsFloor", { count: figure });
}

function mailboxDetails(
  kind: "mailServerDown" | "mailboxPassword" | "mailboxSync",
  mail: MailState,
  t: Text,
  tm: Text,
  locale: Locale,
): FrameNotice {
  const notice = mailboxNotice(kind, mail, t);
  if (mail.key !== "mailboxError") return notice;
  const sentence = mailboxErrorKey(
    mail.errorCode,
    mail.errorDetail,
    mail.storeRefusals,
    (r) => refusalsFigure(r, locale, tm),
    mail.errorLocalServer,
  );
  const title = mail.address
    ? t("connection.mailboxFailed.named", { address: mail.address })
    : t("connection.mailboxFailed.title");
  return { ...notice, title, line: tm(sentence.key, sentence.values) || undefined };
}

function mailboxNotice(
  kind: "mailServerDown" | "mailboxPassword" | "mailboxSync",
  mail: MailState,
  t: Text,
): FrameNotice {
  const key = mail.address ? "named" : "title";
  return {
    kind,
    id: mail.mailboxId,
    title: t(`connection.${kind}.${key}`, mail.address ? { address: mail.address } : undefined),
    hot: true,
  };
}

/** The calendar day of an instant in a zone, as one comparable string. */
const dayIn = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    at,
  );

/** Offline, and since when the copy last synced: the hour and minute today, the date before today, or nothing known. */
function offlineTitle(copyAsOf: string | null | undefined, t: Text, timeZone: string): string {
  const at = copyAsOf ? new Date(copyAsOf) : null;
  if (at === null || Number.isNaN(at.getTime())) return t("connection.offline.title");
  const today = dayIn(at, timeZone) === dayIn(new Date(), timeZone);
  return t(today ? "connection.offline.since" : "connection.offline.sinceDay", { time: at });
}

/** The words of each state; `acts` are added by the caller. */
function noticeOf(
  kind: ConnectionKind,
  input: ConnectionInput,
  t: Text,
  recovers: boolean,
  timeZone: string,
): FrameNotice {
  const mail = input.mail;
  switch (kind) {
    case "signedOut":
      return {
        kind,
        title: t("connection.signedOut.title"),
        hot: true,
        ...(recovers ? {} : { line: t("connection.signedOut.restart") }),
      };
    case "offline":
      return { kind, title: offlineTitle(input.copyAsOf, t, timeZone) };
    case "ownerLost":
      return { kind, title: t("connection.ownerLost.title"), line: t("connection.ownerLost.line") };
    case "noMailbox":
      return { kind, title: t("connection.noMailbox.title"), hot: true };
    case "hostQuiet":
      return { kind, title: input.host?.words.title ?? "" };
    case "mailServerDown":
    case "mailboxPassword":
    case "mailboxSync":
      return mailboxNotice(kind, mail!, t);
    case "reconnecting":
      return { kind, title: t("connection.reconnecting.title") };
    case "late":
      return {
        kind,
        id: mail?.mailboxId,
        title: t("connection.late.since", { time: new Date(mail!.asOf!) }),
      };
    case "behind":
      return {
        kind,
        title: mail?.asOf
          ? t("connection.behind.asOf", { time: new Date(mail.asOf) })
          : t("connection.behind.title"),
      };
    case "firstSync": {
      const count = mail?.count ?? 0;
      const line = mail?.total
        ? t("connection.firstSync.of", { count, total: mail.total })
        : count > 0
          ? t("connection.firstSync.count", { count })
          : undefined;
      return { kind, title: t("connection.firstSync.title"), line };
    }
    case "filing":
      return {
        kind,
        title: mail?.pending
          ? t("connection.filing.count", { count: mail.pending })
          : t("connection.filing.title"),
      };
    case "filingElsewhere":
    case "filingWaits":
      return { kind, title: t(`connection.${kind}.title`) };
    case "filingStuck":
      return { kind, title: t("connection.filingStuck.title"), hot: true };
  }
}

function actsOf(
  kind: ConnectionKind,
  input: ConnectionInput,
  t: Text,
  acts: ConnectionActs,
  href: string | null,
): FrameNotice["acts"] {
  const recover = acts.recover;
  /* Where the shell's words name the place the state is fixed in, its act leads there. */
  const mailboxes = href !== null ? () => acts.follow(href) : acts.mailboxes;
  /* This computer's copy refusing its own pull is ours to fix: the person's step is telling us. */
  const mailboxError = kind === "mailServerDown" || kind === "mailboxPassword" || kind === "mailboxSync";
  if (mailboxError && input.mail?.errorDetail === MIRROR_STORE_REFUSED_DETAIL)
    return [{ label: t("connection.act.writeToUs"), onPress: acts.help }];
  switch (kind) {
    case "signedOut":
      return recover === "none"
        ? undefined
        : [{ label: t("connection.act.signIn"), onPress: () => recover("signIn") }];
    case "ownerLost":
      return recover === "none"
        ? undefined
        : [{ label: t("connection.act.reload"), onPress: () => recover("reload") }];
    case "noMailbox":
      return [{ label: t("connection.act.connect"), onPress: acts.connect ?? acts.mailboxes }];
    case "late":
    case "mailServerDown":
    case "mailboxPassword":
    case "mailboxSync":
    case "filingElsewhere":
    case "filingStuck":
    case "filingWaits":
      return [{ label: t("connection.act.mailboxes"), onPress: mailboxes }];
    case "firstSync":
    case "filing":
      return href !== null ? [{ label: t("connection.act.mailboxes"), onPress: mailboxes }] : undefined;
    case "hostQuiet": {
      const link = input.host?.words.link;
      return link ? [{ label: link.label, onPress: () => acts.follow(link.href) }] : undefined;
    }
    default:
      return undefined;
  }
}

/** The states whose why a shell may say in its own words; the others are the frame's alone. */
const REASONED: ReadonlySet<ConnectionKind> = new Set([
  "late",
  "mailboxSync",
  "firstSync",
  "filing",
  "filingElsewhere",
  "filingStuck",
  "filingWaits",
]);

const ACTIONABLE_BLOCKS = new Set([
  "awaiting_credentials",
  "clock_off",
  "meta_folder_full",
  "meta_undeletable",
  "mailbox_full",
]);

function needsNotice(kind: ConnectionKind | null, input: ConnectionInput): boolean {
  const { mail } = input;
  if (kind === "late") return noticeDelayPassed(mail?.asOf, Date.now());
  if (kind === "hostQuiet")
    return input.host?.words.link != null && noticeDelayPassed(input.copyAsOf, Date.now());
  if (kind === "mailServerDown" || kind === "mailboxPassword" || kind === "mailboxSync") {
    if (mail?.key === "mailboxError") {
      return mailboxErrorNeedsAction(mail) || (mail.minutes ?? 0) >= NOTICE_DELAY_MS / 60_000;
    }
    return ACTIONABLE_BLOCKS.has(mail?.reason ?? "") || (mail?.minutes ?? 0) >= NOTICE_DELAY_MS / 60_000;
  }
  return kind === "signedOut" || kind === "ownerLost" || kind === "noMailbox";
}

/** The connection state, as the one notice the slot draws, or null where nothing is said. */
export function useConnectionNotice(
  input: ConnectionInput,
  acts: ConnectionActs,
  reason: ConnectionReason | null = null,
  placement: "frame" | "mailboxes" = "frame",
): FrameNotice | null {
  const t = useText("frame");
  const tm = useText("mailboxes");
  const locale = useLocale();
  const timeZone = useTimeZone();
  const details = placement === "mailboxes";
  const current = connectionOf(input);
  const kind = details ? (current === "late" ? null : current) : needsNotice(current, input) ? current : null;
  const said = kind !== null && REASONED.has(kind) && input.mail?.key !== "mailboxError" ? reason : null;
  const mailboxError = kind === "mailServerDown" || kind === "mailboxPassword" || kind === "mailboxSync";
  const framed =
    kind === null
      ? null
      : details && mailboxError && input.mail
        ? mailboxDetails(kind, input.mail, t, tm, locale)
        : noticeOf(kind, input, t, acts.recover !== "none", timeZone);
  const progress = kind === "firstSync" && input.mail?.total ? input.mail.count / input.mail.total : null;
  const countLine = useGatedWords(kind === "firstSync" ? (framed?.line ?? null) : null, progress);
  if (kind === null || framed === null) return null;

  let notice = framed;
  if (said && details) {
    notice = {
      ...framed,
      title: said.title ?? framed.title,
      line:
        countLine !== null && said.line
          ? `${countLine} · ${said.line}`
          : (countLine ?? said.line ?? framed.line),
    };
  } else if (countLine !== null) {
    notice = { ...framed, line: countLine };
  } else if (kind === "late" && said?.title) {
    notice = { ...framed, title: said.title };
  } else if (said?.line && input.mail?.reason === "mailbox_full") {
    const where = input.mail.address ? `${input.mail.address}: ` : "";
    notice = { ...framed, title: where + said.line.replace(/[.]$/u, "") };
  }

  const href = !details && input.mail?.mailboxId ? null : (said?.href ?? null);
  const answers = actsOf(kind, input, t, acts, href);
  return answers ? { ...notice, acts: answers, more: undefined } : notice;
}
