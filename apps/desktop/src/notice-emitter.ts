/**
 * THE DESKTOP'S NOTICES, FROM THE WINDOW'S SIDE. The one caller (`use-notices`) hands this emitter
 * what the gate answered; it hands the shell the notice itself, a kind with its numbers and closed
 * words, and the shell writes the words in its own language (`src-tauri/src/notice.rs`). No title
 * and no body leave this window: there is no sentence here for a page to bend.
 *
 * Every kind it carries is handed over while this window is not the one being looked at. A tap
 * brings ohmail forward; a notice has no act and names no place.
 *
 * Taking back: the window has nothing pending to stop, and the operating system's notification
 * centre gives no way to withdraw a notice this process already posted. A notice already listed
 * stays where the system put it (a declared limit); the shell's sign-out takes the badge off.
 */
import { type MailNotice, type Notice, type NoticeKind } from "@ohmail/client-engine";
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
import { postOsNotice } from "./native.js";

/** What the emitter asks of the window and its shell. */
export interface NoticeShell {
  /** This window is the one being looked at. */
  focused(): boolean;
  /** Hand the shell one notice to word and show. A refusal rejects. */
  post(notice: MailNotice): Promise<void>;
}

/**
 * The kinds the window hands over. Not `scheduled` yet: the copy cannot tell a scheduled message
 * that went out from one cancelled and discarded elsewhere, and "went out" must not be said of one
 * that did not. It joins once the copy keeps its own mark of a sent draft.
 */
const CARRIES: readonly NoticeKind[] = ["ohbox", "screener", "pairing"];

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

/** The window's emitter over `shell`. */
export function desktopNoticeEmitter(shell: NoticeShell): HostNoticeEmitter {
  return {
    carries: CARRIES,
    acts: [],
    ahead: "none",
    post(notice: Notice): void {
      try {
        if (!CARRIES.includes(notice.kind)) return;
        if (shell.focused()) return;
        const handed = crossing(notice);
        if (handed === null) return;
        void shell.post(handed).catch(() => {
          /* Notifications are off for ohmail, or this platform has none. Not a reason to fail. */
        });
      } catch {
        /* A notice that could not be handed over takes nothing down. */
      }
    },
    takeBack(): void {
      /* Nothing pending in this window; see the header for what the system keeps. */
    },
  };
}

/** The emitter this window hands in: the shell's own door, and the window's focus. */
export const desktopEmitter: HostNoticeEmitter = desktopNoticeEmitter({
  focused: () => typeof document !== "undefined" && document.hasFocus(),
  post: (notice) => postOsNotice(notice),
});
