/**
 * EVERY LINK THE SYSTEM HANDS THE ROUTER PASSES HERE FIRST. A link on the switch's path is native's alone: the switch
 * module takes it up before the router is asked, so the router is answered with the app's root and the link (its
 * fragment holds the payload) never enters navigation state, history or a log. Every other link is left as it came.
 */
import { isSwitchPath } from "../src/switch/link";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return switchPathOf(path) ? "/" : path;
}

function switchPathOf(path: string): boolean {
  if (typeof path !== "string") return false;
  try {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(path)) return isSwitchPath(path);
    // The app's own schemes never carry the switch either: `ohmail://switch…` is dropped as the link is.
    const url = new URL(path);
    return isSwitchPath(url.pathname) || isSwitchPath(`/${url.host}`);
  } catch {
    return false;
  }
}
