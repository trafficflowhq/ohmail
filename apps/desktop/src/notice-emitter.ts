/**
 * THE DESKTOP'S NOTICES, FROM THE WINDOW'S SIDE. The one caller (`use-notices`) hands this emitter
 * what the gate answered; it hands the shell the notice itself, a kind with its numbers and closed
 * words, and the shell writes the words in its own language (`src-tauri/src/notice.rs`). No title
 * and no body leave this window: there is no sentence here for a page to bend.
 *
 * Every kind it carries is handed over while this window is not the one being looked at. A tap
 * brings ohmail forward; a notice has no act and names no place.
 *
 * THE CALENDAR'S ALERTS are not posted: the caller hands this emitter the account's whole set
 * ahead, read closed, and the shell keeps and rings it with the window minimized or hidden
 * (`src-tauri/src/alerts.rs`). The window carries no act, so no alert crosses with one.
 *
 * Taking back: the shell is handed the account's empty set, so nothing set ahead under the account
 * left rings (the shell also clears at its own sign-out, and asks again at each alert's minute who
 * is signed in). The operating system's notification centre gives no way to withdraw a notice this
 * process already posted: a notice already listed stays where the system put it (a declared limit);
 * the shell's sign-out takes the badge off.
 */
import { readAheadSet, type AheadSet, type MailNotice, type Notice, type NoticeKind, type NoticeTaken } from "@ohmail/client-engine";
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
import { postOsNotice, setOsAlerts, type NoticeWriter } from "./native.js";

/** What the emitter asks of the window and its shell. */
export interface NoticeShell {
  /** This window is the one being looked at. */
  focused(): boolean;
  /** Hand the shell one notice to word and show. A refusal rejects. */
  post(notice: MailNotice): Promise<void>;
  /** Hand the shell the account's alerts, whole: they replace the ones before, and an empty set takes all back. */
  alerts(set: AheadSet): Promise<unknown>;
}

/**
 * The kinds the window hands over. Not `scheduled` yet: the copy cannot tell a scheduled message
 * that went out from one cancelled and discarded elsewhere, and "went out" must not be said of one
 * that did not. It joins once the copy keeps its own mark of a sent draft. `cal_alert` is handed
 * ahead and never posted.
 */
const CARRIES: readonly NoticeKind[] = ["ohbox", "screener", "pairing", "cal_alert"];

/**
 * The notice as the shell reads it: exactly its own members, copied by name. Whatever else an
 * object handed in carried stays behind, and the shell refuses a member it does not know anyway.
 */
function crossing(notice: Notice): MailNotice | null {
  switch (notice.kind) {
    case "ohbox":
      return { kind: "ohbox", count: notice.count };
    case "screener":
      return { kind: "screener", count: notice.count };
    case "scheduled":
      return { kind: "scheduled", outcome: notice.outcome, count: notice.count };
    case "pairing":
      return { kind: "pairing", change: notice.change, device: notice.device };
    default:
      return null;
  }
}

// All mounts in the same window share the receipt sequence. A retired emitter's late
// acknowledgement cannot compile a new command after its replacement has handed a set.
let windowRevision = 0;

/** The window's emitter over `shell`. */
export function desktopNoticeEmitter(shell: NoticeShell): HostNoticeEmitter {
  /** The account whose set the shell was last handed: the one taken back. */
  let handed: string | null = null;
  // Withdraw immediately even if an earlier command's acknowledgement never arrives.
  // Keep one current set. If a slower adapter finishes a superseded installation last,
  // submit the current set again without retaining the superseded event data.
  let latest: AheadSet | null = null;
  let revision = 0;
  let confirmed = false;
  const send = (at: number): void => {
    if (latest === null) return;
    confirmed = false;
    void shell.alerts(latest).then(() => {
      if (at === revision) confirmed = true;
      else if (confirmed && revision === windowRevision) send(revision);
    }, () => {});
  };
  const hand = (set: AheadSet): void => {
    latest = set;
    revision = ++windowRevision;
    send(revision);
  };
  return {
    carries: CARRIES,
    acts: [],
    ahead(set: AheadSet): void {
      try {
        // Read closed before it crosses: a copy with exactly its members, or nothing at all.
        const read = readAheadSet(set);
        if (read === null) return;
        handed = read.scope;
        hand(read);
      } catch {
        /* A set that could not be handed over takes nothing down. */
      }
    },
    post(notice: Notice): NoticeTaken {
      try {
        if (!CARRIES.includes(notice.kind)) return false;
        if (shell.focused()) return false;
        const handed = crossing(notice);
        if (handed === null) return false;
        /* A refusal: notifications are off for ohmail, or this platform has none. Not a reason to fail. */
        return shell.post(handed).then(() => true, () => false);
      } catch {
        /* A notice that could not be handed over takes nothing down. */
        return false;
      }
    },
    takeBack(): void {
      try {
        if (handed === null) return;
        const scope = handed;
        handed = null;
        hand({ scope, alerts: [] });
      } catch {
        /* Nothing to take back, or a shell that is gone. */
      }
    },
  };
}

/** The emitter this window hands in: the shell's own doors, and the window's focus. */
export function desktopEmitterFor(writer: NoticeWriter | null): HostNoticeEmitter {
  return desktopNoticeEmitter({
    focused: () => typeof document !== "undefined" && document.hasFocus(),
    post: (notice) => postOsNotice(notice),
    alerts: (set) => setOsAlerts(set, writer),
  });
}

export const desktopEmitter = desktopEmitterFor(null);
