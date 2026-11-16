/** The wall's states, one per address of the design's reference (`screen=wall&state=…`). */
import type { WallState } from "./door.js";

export const WALL_STATES = [
  "trial",
  "canceled",
  "unpaid",
  "suspended",
  "plain",
  "never",
  "pending",
  "checking",
  "nolink",
  "unverified",
  "undated",
  "nofile",
  "erased",
  "erasedtab",
] as const;
export type WallStateId = (typeof WALL_STATES)[number];

const BY_HEADLINE = {
  trialEnded: "trial",
  canceled: "canceled",
  unpaid: "unpaid",
  suspendedTitle: "suspended",
  neverStartedTitle: "never",
  title: "plain",
} as const;

/** The reference's state a door's state draws. */
export function wallStateOf(state: WallState): WallStateId {
  if (state.at === "erased") return state.blocked ? "erasedtab" : "erased";
  if (state.check !== "idle") return state.check;
  if (state.wayBack?.refusal === "mintFailed") return "nolink";
  if (state.wayBack?.refusal === "mintUnverified") return "unverified";
  if (state.moveOut?.failed) return "nofile";
  if (state.standing.kind === "stopped" && state.standing.erasure.kind === "unknown") return "undated";
  return BY_HEADLINE[state.headline.key];
}
