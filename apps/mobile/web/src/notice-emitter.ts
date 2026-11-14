/**
 * THE PHONE'S NOTICES, FROM THE PAGE'S SIDE. The one caller (`use-notices`) hands this emitter what the gate
 * answered; it hands native the notice itself over the bridge's act `notices.post`: a kind with its count or its
 * closed words, copied member by member. No title, no sentence and no name leaves this page: native writes the
 * words, and reads what it is handed through closed records (`src/shell/bridge-kinds.ts`).
 *
 * It carries the kinds native says it draws on this phone (`ShellConfig.notices`): none on the iPhone, none in the
 * calendar's app. With none there is no emitter at all, so the pane offers no switch and nothing is ever asked.
 *
 * Whether a notice is drawn is native's: not while the app is the one being looked at, not without the system's
 * permission, and only for the pairing that is signed in.
 *
 * TAKING BACK is native's too. This page is one pairing's and is gone when that pairing is left; what was drawn
 * for it is closed by the native side the moment another pairing, or none, becomes the signed-in one
 * (`src/notices/live-instance.ts`). Nothing is set to ring later here, so there is nothing of this page's to stop.
 */
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
import { BRIDGE_NOTICE_KINDS, type BridgeNotice, type BridgeNoticeKind } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import type { Notice, NoticeTaken } from "./engine-package";

/**
 * The notice as it crosses: exactly its own members, copied by name. Whatever else an object handed in carried
 * stays behind, and native's guard refuses a member it does not know anyway. A kind the bridge does not carry
 * (a scheduled send, every calendar kind) is no notice here.
 */
function crossing(notice: Notice): BridgeNotice | null {
  switch (notice.kind) {
    case "ohbox":
      return { kind: "ohbox", count: notice.count };
    case "screener":
      return { kind: "screener", count: notice.count };
    case "pairing":
      return { kind: "pairing", change: notice.change, device: notice.device };
    default:
      return null;
  }
}

/** The page's emitter over the bridge, for the kinds native draws here; `none` where it draws none. */
export function phoneNoticeEmitter(
  bridge: Pick<Bridge, "request">, draws: readonly BridgeNoticeKind[],
): HostNoticeEmitter | "none" {
  // Only kinds the bridge itself carries, whatever the list names.
  const carries = BRIDGE_NOTICE_KINDS.filter((kind) => draws.includes(kind));
  if (carries.length === 0) return "none";
  return {
    carries,
    acts: [],
    ahead: "none",
    post(notice: Notice): NoticeTaken {
      try {
        const handed = crossing(notice);
        if (handed === null || !carries.includes(handed.kind)) return false;
        /* Taken only where native says it posted: not in front, not denied, not on a phone that draws none.
           Native refused it, or the page is going away: not a reason to fail. */
        return bridge.request("act", { act: "notices.post", notice: handed })
          .then((answer) => answer.notice === "posted", () => false);
      } catch {
        /* A notice that could not be handed over takes nothing down. */
        return false;
      }
    },
    takeBack(): void {
      /* Native's: see the header. */
    },
  };
}
