/**
 * THE SENDING SIDE OF THE SWITCH: a press in this app opens the other at a place. Only while this app is in front, at
 * most once in {@link PRESS_GAP_MS}, and only at a place of this app's direction (`place.ts`). The call carries the
 * place and the digest of this app's pairing; opening needs no network, so a press opens the other app offline too.
 *
 * ON ANDROID A SIGNED-OUT SIBLING IS SIGNED IN BY THE SAME PRESS. Before the call, the sibling's provider is asked
 * about this app's pairing. Only its answer `none` carries a challenge, and only a paired profile (never this phone's
 * own mailbox) then mints: one rotation of its own refresh token that also asks the server for a one-use code bound
 * to that challenge. The code rides the call that opens the sibling, inside a pairing link, beside the challenge.
 * The sibling is asked only when this app can mint at all. Every failure (no answer, `same`, `other`, no code, a
 * handoff that took longer than {@link HANDOFF_WAIT_MS}) opens the sibling with the place alone.
 */
import { encodePlace, isSwitchPlace, type SwitchPlace } from "./place";
import { payloadFields, readPayload, type SwitchPayload } from "./payload";
import type { SwitchNative } from "./switch-port";

/** The shortest gap between two opens: a second press inside it opens nothing. */
export const PRESS_GAP_MS = 2_000;

/** The longest a press waits for the sibling's answer and the code together, before it opens with the place alone. */
export const HANDOFF_WAIT_MS = 4_000;

/** A challenge as the server binds a code to it: 32 bytes, base64url, no padding. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export type SendRefusal = "notReady" | "tooMany" | "malformed";

export interface SenderDeps {
  readonly app: "ohmail" | "ohcal";
  readonly native: SwitchNative | null;
  /** This app is the one in front now. */
  readonly inFront: () => boolean;
  readonly now: () => number;
  /** The digest of the live pairing (origin, a newline, the account id; SHA-256, base64url), or null where none lives. */
  readonly digest: () => Promise<string | null>;
  /**
   * The handoff's mint, present only for a paired profile: the rotation that also asks for a code bound to the
   * sibling's challenge, answered as the pairing link the code rides in, or null where none was minted.
   */
  readonly mint?: (challenge: string) => Promise<string | null>;
}

export interface Sender {
  open(place: SwitchPlace): Promise<"opened" | "absent" | { readonly refused: SendRefusal }>;
  store(): Promise<boolean>;
}

/** What `p` settles to within `ms`, or null after it. */
function within<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then((v) => resolve(v), () => resolve(null)).finally(() => clearTimeout(timer));
  });
}

/** The challenge and the code's link for a signed-out sibling, or null: every other outcome opens with the place. */
async function handoffFor(deps: SenderDeps, digest: string | null): Promise<{ readonly c: string; readonly l: string } | null> {
  const { native, mint } = deps;
  if (native === null || native.askSibling === undefined || mint === undefined || digest === null) return null;
  const said = await native.askSibling(digest).catch(() => null);
  const challenge = said?.a === "none" ? said.c : undefined;
  if (typeof challenge !== "string" || !CHALLENGE.test(challenge)) return null;
  const link = await mint(challenge).catch(() => null);
  return typeof link === "string" ? { c: challenge, l: link } : null;
}

export function switchSender(deps: SenderDeps): Sender {
  let last = Number.NEGATIVE_INFINITY;
  return {
    async open(place) {
      if (!isSwitchPlace(place, deps.app)) return { refused: "malformed" };
      if (deps.native === null || !deps.inFront()) return { refused: "notReady" };
      const at = deps.now();
      if (at - last < PRESS_GAP_MS) return { refused: "tooMany" };
      last = at;
      const d = await deps.digest().catch(() => null);
      const plain: SwitchPayload = { v: "1", k: "open", p: encodePlace(place), ...(d !== null ? { d } : {}) };
      const handed = await within(handoffFor(deps, d), HANDOFF_WAIT_MS);
      const withCode: SwitchPayload | null = handed === null ? null : { ...plain, c: handed.c, l: handed.l };
      // A code goes only in a payload the receiver's own codec reads; otherwise the place alone.
      const payload = withCode !== null && readPayload(payloadFields(withCode)) !== null ? withCode : plain;
      // The handoff may have outlasted this app's turn in front: then nothing opens.
      if (payload !== plain && !deps.inFront()) return { refused: "notReady" };
      return (await deps.native.open(payloadFields(payload)).catch(() => false)) ? "opened" : "absent";
    },
    async store() {
      if (deps.native === null || !deps.inFront()) return false;
      return deps.native.openStore().catch(() => false);
    },
  };
}
