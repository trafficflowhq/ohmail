/**
 * THE FIRST RUN'S WORDS, BY DATA. What differs between the shells is said by total tables keyed by the host's own
 * answers (which first run it walks, whose service it is), never by a branch on a shell's name. Every key is written
 * by its full path, `namespace.key`: the stage reads five namespaces (its own `onboarding`, the Mailboxes place's
 * `mailboxes`, the join's `join`, and the Screener's `seed` and `screener`), one convention for all of them.
 */
import type { HostCapabilities } from "../../host/index.js";
import type { Text } from "../../text/index.js";

/** The namespaces the stage reads. */
export const FIRST_RUN_NAMESPACES = ["onboarding", "mailboxes", "join", "seed", "screener"] as const;

/** A sentence by its full path, with its values. */
export type Say = (path: string, values?: Record<string, string | number>) => string;

/** The reader over the five namespaces, for one render. */
export function sayOf(lookup: (namespace: string) => Text): Say {
  return (path, values) => {
    const at = path.indexOf(".");
    return lookup(path.slice(0, at))(path.slice(at + 1), values);
  };
}

/** Whether the holder's sentence is the managed service's, by whose service this is. */
export const HOLDER_MANAGED: Readonly<Record<HostCapabilities["service"], boolean>> = {
  ownComputer: false,
  managed: true,
  self: false,
};

/** The five places a decision files a sender into, as the Screener names them, with the key each wears. */
export const PLACES = [
  { to: "ohbox", key: "o", name: "screener.pileOhbox" },
  { to: "reads", key: "r", name: "screener.pileReads" },
  { to: "receipts", key: "c", name: "screener.pileReceipts" },
  { to: "screened", key: "n", name: "screener.pileScreenOut" },
  { to: "spam", key: "x", name: "screener.pileSpam" },
] as const;

/** The history's rungs, as the window step offers them. */
export const RUNGS = [
  { value: "90", label: "onboarding.win90" },
  { value: "180", label: "onboarding.win180" },
  { value: "365", label: "onboarding.win365" },
  { value: "all", label: "onboarding.winAll" },
] as const;
