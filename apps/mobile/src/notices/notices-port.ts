/**
 * THE NATIVE SIDE OF THE PHONE'S NOTICES, as the port its module answers (`modules/ohmail-notices`, Android).
 *
 * It keeps one fact and draws by it: WHICH PAIRING IS SIGNED IN. A notice is drawn for a pairing only while that
 * pairing is the kept one, by one rule on both native paths: the wake's renderer in an app that was closed
 * (`plugins/wake-push-renderer.js`) and the poster behind the bridge's act `notices.post`. {@link mayDrawFor} is that
 * rule on this side, held to the Kotlin gate by one table (`test/live-instance-cases.json`).
 *
 * NATIVE IS HANDED CLOSED VALUES ONLY: a pairing's local id, a kind's word, one whole number and two words of closed
 * lists ({@link PosterArgs}). It writes every word a notice shows from its own string resources, in the phone's
 * language. It is never handed a title, a sentence, a letter's sender, subject or words, an address, an account, or
 * the name a device gave itself, and nothing here could carry one.
 */
import type { BridgeNotice, BridgeNoticeKind } from "../shell/bridge-kinds";

const SHORTEST = 7;
const LONGEST = 31;

/**
 * A pairing's local id as the profile store mints it (`state/servers.ts`): `p`, then 6 to 30 of `0-9` and `a-z`.
 * It is the instance a wake is registered and delivered under, and never an account.
 */
export function isInstance(text: unknown): text is string {
  if (typeof text !== "string" || text.length < SHORTEST || text.length > LONGEST || text[0] !== "p") return false;
  for (let i = 1; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const letter = c >= 97 && c <= 122;
    if (!digit && !letter) return false;
  }
  return true;
}

/** A notice for a pairing may be drawn only while the kept one is that same pairing. */
export function mayDrawFor(kept: unknown, instance: unknown): boolean {
  return isInstance(kept) && isInstance(instance) && kept === instance;
}

type Pairing = Extract<BridgeNotice, { readonly kind: "pairing" }>;

/**
 * What the poster is handed for one notice, after the pairing it is for: the kind's word, a count (0 where the kind
 * says none), and a pairing's two words (null where the kind has none, or the server named no kind of device).
 */
export type PosterArgs = readonly [
  kind: BridgeNoticeKind, count: number, change: Pairing["change"] | null, device: Pairing["device"],
];

/** A notice the guard has read, as the poster's arguments. Total over the kinds: a new one does not compile until it stands here. */
export function posterArgs(notice: BridgeNotice): PosterArgs {
  switch (notice.kind) {
    case "ohbox":
      return ["ohbox", notice.count, null, null];
    case "screener":
      return ["screener", notice.count, null, null];
    case "pairing":
      return ["pairing", 0, notice.change, notice.device];
  }
}

export interface NoticesNative {
  /**
   * Keep `instance` as the signed-in pairing's, or none (`null`: nobody is signed in), and close every notice this
   * app shows for any other pairing. True once it is kept. What is no pairing's id is kept as none.
   */
  setLive(instance: string | null): Promise<boolean>;
  /**
   * Draw one mail notice for `instance`, in the phone's language, from the module's own string resources. Native
   * draws it only while `instance` is the kept pairing, and answers whether it handed the system a notice.
   */
  postDetails?(instance: string, sender: string, subject: string): Promise<boolean>;
  post(
    instance: string, kind: string, count: number, change: string | null, device: string | null,
  ): Promise<boolean>;
}
