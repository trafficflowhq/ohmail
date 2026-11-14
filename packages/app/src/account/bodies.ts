/**
 * WHICH BODY EACH OF THE SIX PANES ASKS FOR, said once: every shell's registration switches on this and on nothing
 * else. A pane the host does not list has no body. Where it is listed, the capability's answer chooses the body:
 * never the build, the service or the surface.
 *
 * The answers that withhold a pane are the guard. `inBrowser` is a window that cannot ask a second factor again, so
 * every gated verb stays behind the card. A build that may not link out shows no figure and offers no way to pay.
 */
import { NONE, panesOf, type HostContract, type None } from "../host/index.js";

export interface AccountBodies {
  /** `pane`: the pane. `card`: the way out to the browser. `hostPane`: the host's own pane, where this computer serves. */
  readonly devices: "pane" | "card" | "hostPane" | None;
  /** Subscription. Built only where the build links out to where prices are. */
  readonly billing: "pane" | None;
  /** `pane`: figures and the two verbs that change the plan. `facts`: what is stored, no figure, no verb, "managed at the site". */
  readonly storage: "pane" | "facts" | None;
  /** Listed means the pane. */
  readonly invites: "pane" | None;
  readonly security: "pane" | "card" | None;
  /** `signOutOnly`: the pane's session sheet alone. */
  readonly account: "pane" | "card" | "signOutOnly" | None;
}

const DEVICES = { account: "pane", inBrowser: "card", hostMode: "hostPane", none: NONE } as const;
const SECURITY = { here: "pane", inBrowser: "card", signOutOnly: NONE, none: NONE } as const;
const ACCOUNT = { here: "pane", inBrowser: "card", signOutOnly: "signOutOnly", none: NONE } as const;
const BILLING = { linkOut: "pane", data: NONE, none: NONE } as const;
const STORAGE = { linkOut: "pane", data: "facts", none: "facts" } as const;

/** The body of each of the six ids on this host: `none` where the host does not list the pane. */
export function accountBodies(host: HostContract): AccountBodies {
  const listed = panesOf(host);
  const { pairing, account, prices } = host.capabilities;
  return {
    devices: listed.devices ? DEVICES[pairing] : NONE,
    billing: listed.billing ? BILLING[prices] : NONE,
    storage: listed.storage ? STORAGE[prices] : NONE,
    invites: listed.invites ? "pane" : NONE,
    security: listed.security ? SECURITY[account] : NONE,
    account: listed.account ? ACCOUNT[account] : NONE,
  };
}
