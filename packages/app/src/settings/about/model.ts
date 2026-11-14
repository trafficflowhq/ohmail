import type { HostCapabilities } from "../../host/index.js";

/**
 * Settings › About ohmail, as data: which mailbox is connected and when it last synced, which build runs, whether the
 * server names the account it answers for, who publishes this, and where the hosted service's policies are.
 */

/** The mailbox line's five true sentences. A failed read is not "no mailbox". */
export type AboutMailboxes =
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly said: string }
  | { readonly kind: "none" }
  /** `lastSyncAt` exactly as the server states it: `null` is "not synced yet", never "just now". */
  | {
      readonly kind: "some";
      readonly first: string;
      readonly others: number;
      readonly lastSyncAt: string | null;
    };

/** Where to read what is done with the mail: the hosted service's three documents. */
export interface AboutPolicies {
  readonly privacy: string;
  readonly subprocessors: string;
  readonly imprint: string;
}

/** The publisher, as the imprint writes it: its lines verbatim (never translated), and the address that reaches it. */
export interface AboutPublisher {
  readonly lines: readonly string[];
  readonly address: string;
}

export interface AboutModel {
  readonly mailboxes: AboutMailboxes;
  /** The release, and the build it came from. */
  readonly version: string | null;
  readonly build: string;
  /**
   * Whether the server names the account each answer is for. `false` only once it said it does not: the pane then
   * says the one check this window cannot make. `null` while nobody has asked.
   */
  readonly namesAccount: boolean | null;
  readonly publisher: AboutPublisher;
  /** `null` where these documents do not govern this install. */
  readonly policies: AboutPolicies | null;
}

/** A mailbox as the server lists it: what the line reads of it. */
export interface AboutMailboxFacts {
  readonly address: string;
  readonly status: string;
  readonly lastSyncAt: string | null;
}

/** The mailbox line from the server's list: `null` while it is read; a disabled mailbox is not connected. */
export function aboutMailboxesOf(items: readonly AboutMailboxFacts[] | null): AboutMailboxes {
  if (items === null) return { kind: "reading" };
  const active = items.filter((m) => m.status !== "disabled");
  const first = active[0];
  if (!first) return { kind: "none" };
  return { kind: "some", first: first.address, others: active.length - 1, lastSyncAt: first.lastSyncAt };
}

/** The hosted service's documents, on the service that publishes them alone. */
export const HOSTED_POLICIES: AboutPolicies = {
  privacy: "/privacy",
  subprocessors: "/subprocessors",
  imprint: "/imprint",
};

/** Where the policies are linked: only on the managed service, whose documents they are. */
export function aboutPoliciesOf(capabilities: Pick<HostCapabilities, "service">): AboutPolicies | null {
  return capabilities.service === "managed" ? HOSTED_POLICIES : null;
}
