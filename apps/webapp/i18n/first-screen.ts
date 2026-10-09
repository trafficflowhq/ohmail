import type { Messages } from "./catalog";

/**
 * THE CATALOGUE THE PRODUCT DOCUMENT INLINES — the namespaces its first screens render, whole,
 * and for the five namespaces that sit mostly off the first frame only the keys it draws. The rest
 * arrives as the catalogue chunk `LocaleShell` loads after the document: content-hashed, served
 * immutable, so a returning reader takes it from the cache instead of from every document.
 * `test/product-document-catalog.test.tsx` renders every first screen under this cut and under the
 * whole catalogue and requires the same HTML; a string added to a first screen outside this table
 * fails there, by key.
 */
export const FIRST_SCREEN: Readonly<Record<string, true | readonly string[]>> = {
  // The credential screens, every state of each.
  login: true, join: true, joinInvite: true, approve: true, verify: true, setup: true,
  linkDesktop: true, authorizeDesktop: true, resume: true, session: true, appError: true,
  account: ["signOutUnverified", "signOutBlocked", "signOutServerRefused", "signOutBusy"],
  // The shell's frame: rail, dock, palette, list chrome, the key table it registers.
  rail: true, dock: true, palette: true, ribbon: true, reader: true, shortcuts: true,
  triage: true, message: true, tag: true, trash: true,
  ohbox: [
    "title", "meta", "tail", "emptyPlain", "doorbell", "doorbellAction", "doorbellAria",
    "doorbellNotYet", "doorbellNotYetAction", "doorbellNotYetAria",
    "toastDeleted", "deleteUndone", "deleteFailed",
    "keyNext", "keyPrev", "keyOpen", "keyPick", "keyClear", "keyCancelBulk", "keyExtendDown",
    "keyExtendUp", "keyMarkPicked", "keyMarkRead", "keyMarkUnread", "keyTag",
  ],
  screener: ["pileOhbox", "pileReads", "pileReceipts", "pileScreened", "pileSpam", "toastUndo"],
  screening: ["deleteQueuedForOrganizer", "toastRuleSeedGone"],
  settings: ["about", "general", "notifications", "rules", "tags"],
};

/** Copy one dotted path from `from` into `into`, creating the branches it passes through. */
function copyPath(from: Messages, into: Messages, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  const value = from[head];
  if (value === undefined) return;
  if (rest.length === 0 || typeof value === "string") { into[head] = value; return; }
  const branch = (typeof into[head] === "object" ? into[head] : (into[head] = {})) as Messages;
  copyPath(value, branch, rest);
}

/** The cut of `messages` that {@link FIRST_SCREEN} names — of an already filled catalogue. */
export function firstScreenCatalog(messages: Messages): Messages {
  const out: Messages = {};
  for (const [namespace, keys] of Object.entries(FIRST_SCREEN)) {
    const tree = messages[namespace];
    if (tree === undefined) continue;
    if (keys === true || typeof tree === "string") { out[namespace] = tree; continue; }
    const cut: Messages = {};
    for (const key of keys) copyPath(tree, cut, key.split("."));
    out[namespace] = cut;
  }
  return out;
}
