/** The native authorization's states, one per address of the design's reference (`screen=authorize&state=…`). */
import type { AuthorizeDesktopState } from "./door.js";

export const AUTHORIZE_DESKTOP_STATES = ["ask", "factor", "done", "over", "signin"] as const;
export type AuthorizeDesktopStateId = (typeof AUTHORIZE_DESKTOP_STATES)[number];

export function authorizeDesktopStateOf(
  state: AuthorizeDesktopState,
): AuthorizeDesktopStateId | "checking" | "unchecked" | "refused" {
  return state.at === "ask" && state.factor ? "factor" : state.at;
}
