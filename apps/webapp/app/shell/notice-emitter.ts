/**
 * THE BROWSER'S NOTICES, DRAWN BY THE PAGE. The one caller (`use-notices`) hands this emitter what
 * the gate answered; it draws it through the service worker's registration, in the app's own words
 * from the catalogue, and decides nothing about whether a kind is wanted.
 *
 * Every kind it carries is drawn while this tab lives and is not the one being looked at. New mail
 * is drawn only while the tab is visible as well: with no window visible the service worker draws
 * its own fixed "New mail" on the wake, so the page stays quiet then and one arrival is never drawn
 * twice (`public/sw.js`, unchanged).
 *
 * A notice is closed words and numbers: the title and the body are the catalogue's sentences over
 * a count or a closed word, composed by `noticeFields`, and a tag that is its kind's own closed word.
 * No `data` and no act rides on it: a tap reaches the worker's own handler, which brings this window
 * forward.
 */
import {
  noticeFields,
  type Notice, type NoticeFacts, type NoticeKind, type NoticeWording,
} from "@ohmail/client-engine";
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";

/** What the emitter asks of the page and its browser. */
export interface NoticePage {
  /** This tab is the one being looked at. */
  focused(): boolean;
  /** This tab is on screen, though perhaps not in front. */
  visible(): boolean;
  /** Draw one notice through the worker's registration, over any listed with the same tag. Never throws. */
  show(title: string, body: string, tag: string): void;
  /** Close every notice of this origin still listed; settles once they are closed. Never rejects. */
  closeAll(): Promise<void>;
}

/** A sentence of the catalogue's `frame.systemNotice` group, with its values. */
export type NoticeSay = (key: string, values?: Record<string, string | number>) => string;

/** The words of this surface: the catalogue's sentences over a notice's numbers and closed words. */
export function noticeWordingOf(say: NoticeSay): NoticeWording {
  const words = (facts: NoticeFacts): { title: string; body: string } => {
    switch (facts.kind) {
      case "ohbox":
        return { title: say("ohboxTitle"), body: say("ohboxBody", { count: facts.count }) };
      case "screener":
        return { title: say("screenerTitle"), body: say("screenerBody", { count: facts.count }) };
      case "scheduled":
        return facts.outcome === "sent"
          ? { title: say("sentTitle"), body: say("sentBody", { count: facts.count }) }
          : { title: say("failedTitle"), body: say("failedBody", { count: facts.count }) };
      case "pairing": {
        const device = facts.device ?? "unknown";
        return facts.change === "paired"
          ? { title: say("pairedTitle"), body: say("pairedBody", { device }) }
          : { title: say("revokedTitle"), body: say("revokedBody", { device }) };
      }
      default:
        // A calendar kind: this surface carries none yet, and draws nothing for one.
        return { title: "", body: "" };
    }
  };
  return {
    title: (facts) => words(facts).title,
    body: (facts) => words(facts).body,
    label: () => "",
  };
}

/**
 * The kinds the page draws. Not `scheduled` yet: the copy cannot tell a scheduled message that went
 * out from one cancelled and discarded elsewhere, and "went out" must not be said of one that did
 * not. It joins once the copy keeps its own mark of a sent draft.
 */
const CARRIES: readonly NoticeKind[] = ["ohbox", "screener", "pairing"];

/**
 * One tag per kind, so two tabs of one account draw one notice of a kind, the second over the
 * first. Closed words, never an id of a person or a letter. New mail's is the worker's own.
 */
const TAGS: Partial<Readonly<Record<NoticeKind, string>>> = {
  ohbox: "ohmail-new-mail",
  screener: "ohmail-screener",
  scheduled: "ohmail-scheduled",
  pairing: "ohmail-pairing",
};

/**
 * The page's emitter over `page`, in the words `wording` gives at the moment a notice is drawn (the
 * person's language may change while the tab lives).
 */
export function webNoticeEmitter(page: NoticePage, wording: () => NoticeWording): HostNoticeEmitter {
  return {
    carries: CARRIES,
    acts: [],
    ahead: "none",
    post(notice: Notice): void {
      try {
        if (!CARRIES.includes(notice.kind)) return;
        if (page.focused()) return;
        if (notice.kind === "ohbox" && !page.visible()) return;
        const tag = TAGS[notice.kind];
        if (tag === undefined) return;
        const { title, body } = noticeFields(notice, wording());
        if (title === "") return;
        page.show(title, body, tag);
      } catch {
        /* A notice that could not be drawn takes nothing down. */
      }
    },
    takeBack(): void {
      try {
        void page.closeAll();
      } catch {
        /* Nothing to close, or a browser that will not say. */
      }
    },
  };
}

/** The page as this browser has it. Every call is guarded: a browser without workers or notices draws nothing. */
export const browserNoticePage: NoticePage = {
  focused: () => typeof document !== "undefined" && document.hasFocus(),
  visible: () => typeof document !== "undefined" && document.visibilityState === "visible",
  show(title, body, tag) {
    void registration()
      .then((reg) => reg?.showNotification(title, { body, tag }))
      .catch(() => {});
  },
  closeAll() {
    return registration()
      .then((reg) => reg?.getNotifications())
      .then((shown) => { for (const n of shown ?? []) n.close(); })
      .catch(() => {});
  },
};

/** The worker's registration for this page, if one stands. The page registers none here: the wake does. */
async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker.getRegistration();
}
