import type { supportContact } from "@ohmail/app-logic/writing/support";
import type { DeviceBuild } from "../../host/index.js";

/**
 * Settings › Help & contact, as data. Write to us opens the person's own composer where this door has a mailbox that
 * can send; elsewhere it is a `mailto:` link, or, where such a link would not leave the app, the address and the
 * diagnostics to copy. The block's facts and the composer are the shell's; the pane draws which of the three it is.
 */
export type HelpWrite =
  /** The composer opens with the address, the subject and the diagnostics block. */
  | { readonly kind: "compose"; write(): void }
  /** The person's mail app opens with the same subject and body. */
  | { readonly kind: "mailto"; readonly href: string }
  /** The address and the block, each to copy; `copied` names the one copied last. */
  | {
      readonly kind: "copy";
      readonly copied: "address" | "diag" | null;
      copy(what: "address" | "diag"): void;
    };

export interface HelpModel {
  readonly write: HelpWrite;
  readonly clipboard?: Pick<Extract<HelpWrite, { kind: "copy" }>, "copied" | "copy">;
  readonly facts: Pick<
    ReturnType<typeof supportContact>["facts"],
    "version" | "commit" | "os" | "osVersion" | "surface" | "account" | "mailboxes"
  >;
}

/**
 * Which way Write to us goes, from whether this door has a mailbox that can send now and from the build's word on
 * `mailto:` links. The shipped rule: the composer first, then a link that leaves, then the copy.
 */
export function helpWayOf(canSend: boolean, build: Pick<DeviceBuild, "mailtoLeaves">): HelpWrite["kind"] {
  if (canSend) return "compose";
  return build.mailtoLeaves ? "mailto" : "copy";
}
