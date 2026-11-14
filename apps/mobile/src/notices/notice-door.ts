/**
 * THE NATIVE END OF THE ACT `notices.post`: what the phone does when the page asks for a mail notice. The guard has
 * read the request closed (`shell/bridge-kinds.ts`); this is the last reader before the native poster, and it decides
 * whether anything is drawn at all:
 *
 *  · THE iPHONE DRAWS NONE, and neither does the calendar's app or a build without the poster: the act answers
 *    `unsupported` and the native module is never asked, even where one is present;
 *  · only for the pairing whose session is the live one, and only while that pairing's id is of the minted shape;
 *  · only while the system lets this app post;
 *  · not while the app is the one being looked at: the page already shows what arrived.
 *
 * Native is handed the pairing and the notice's closed values (`notices-port.ts`), never the page's object, and
 * draws only while that pairing is the one it keeps as signed in.
 */
import {
  BRIDGE_NOTICE_KINDS, readNotice, type BridgeNoticeKind, type NoticePermission, type NoticePosted, type ShellApp,
} from "../shell/bridge-kinds";
import { isInstance, posterArgs, type NoticesNative } from "./notices-port";

export interface NoticeDoorDeps {
  /** The system this build runs on, as React Native names it. */
  readonly platform: string;
  /** The app this build is: mail's notices are the mail app's. */
  readonly app: ShellApp;
  /** The notices' native module, or null where the build has none. */
  readonly native: Pick<NoticesNative, "post"> | null;
  /** The pairing this door's session is: the profile's local id. */
  readonly instance: string;
  /** Whether that session is still the live one. */
  readonly live: () => boolean;
  /** What the system says about posting, as the phone last read it. */
  readonly permission: () => NoticePermission;
  /** Whether the app is the one being looked at. */
  readonly inFront: () => boolean;
}

/** Whether this build draws mail notices at all: the mail app on Android, with its poster. */
const draws = (d: Pick<NoticeDoorDeps, "platform" | "app" | "native">): boolean =>
  d.platform === "android" && d.app === "ohmail" && d.native !== null;

/** The kinds native draws here, which the page is told once: every kind the bridge carries, or none. */
export function noticeKindsHere(d: Pick<NoticeDoorDeps, "platform" | "app" | "native">): readonly BridgeNoticeKind[] {
  return draws(d) ? BRIDGE_NOTICE_KINDS : [];
}

export interface NoticeDoor {
  /** One notice as the page handed it. A notice that does not read closed is refused and nothing runs. */
  post(raw: unknown): Promise<{ readonly notice: NoticePosted } | { readonly refused: "malformed" }>;
}

export function noticeDoor(deps: NoticeDoorDeps): NoticeDoor {
  return {
    async post(raw) {
      const notice = readNotice(raw);
      if (notice === null) return { refused: "malformed" };
      const native = deps.native;
      if (!draws(deps) || native === null) return { notice: "unsupported" };
      if (!deps.live() || !isInstance(deps.instance)) return { notice: "denied" };
      if (deps.permission() !== "granted") return { notice: "denied" };
      if (deps.inFront()) return { notice: "inFront" };
      try {
        return { notice: (await native.post(deps.instance, ...posterArgs(notice))) === true ? "posted" : "denied" };
      } catch {
        // A notice that could not be drawn takes nothing down.
        return { notice: "denied" };
      }
    },
  };
}
