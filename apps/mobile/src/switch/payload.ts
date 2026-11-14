/**
 * WHAT ONE APP HANDS THE OTHER, as the fields native hands over on both systems: the extras of Android's direct call,
 * and the fragment of the iPhone's universal link as native reads it (`OhmailSwitchModule.swift`, the link's one
 * grammar). Nothing of it is ever in a path, a query, an intent's data or a log.
 *
 *  - `open`: the place to open at (`p`, `place.ts`'s word) and the digest of the sender's pairing (`d`: SHA-256 over
 *    its server's origin, a newline and its account id, base64url), which lets a receiver tell its own account from
 *    another; a sender that holds no pairing sends none. A signed-out receiver's challenge (`c`) and the one-use code
 *    minted for it (`l`, a pairing link) ride the same call on Android, and only beside the digest.
 *  - `ask` and `done`: the iPhone's two further legs of one sign-in: the receiver's challenge, then the code for it.
 *
 * A key outside the leg's own set, a missing one, a second spelling or a value of the wrong shape refuses the whole
 * payload: a receiver acts on a payload this reads, or on nothing. Imports nothing.
 */

export type SwitchPayload =
  | { readonly v: "1"; readonly k: "open"; readonly p: string; readonly d?: string; readonly c?: string; readonly l?: string }
  | { readonly v: "1"; readonly k: "ask"; readonly c: string }
  | { readonly v: "1"; readonly k: "done"; readonly c: string; readonly l: string };

/** A digest or a challenge: 32 bytes, base64url, no padding. */
const B64_32 = /^[A-Za-z0-9_-]{43}$/;
/** A place's word, as `place.ts` writes it; its shape is judged there, against the sender. */
const WORD = /^[a-z]{1,8}(:[0-9a-fA-F-]{36})?$/;
/** The longest pairing link a code rides in. */
const LINK_MAX = 2048;

const KEYS: { readonly [K in SwitchPayload["k"]]: { readonly need: readonly string[]; readonly may: readonly string[] } } = {
  open: { need: ["v", "k", "p"], may: ["d", "c", "l"] },
  ask: { need: ["v", "k", "c"], may: [] },
  done: { need: ["v", "k", "c", "l"], may: [] },
};

const SHAPES: Record<string, (v: string) => boolean> = {
  v: (v) => v === "1",
  k: (v) => v === "open" || v === "ask" || v === "done",
  p: (v) => WORD.test(v),
  d: (v) => B64_32.test(v),
  c: (v) => B64_32.test(v),
  l: (v) => v.length > 0 && v.length <= LINK_MAX && !/[\s\u0000-\u001f\u007f]/.test(v),
};

/** The payload as named fields, or null. Every field is a string: native hands extras over as such. */
export function readPayload(fields: Readonly<Record<string, unknown>> | null | undefined): SwitchPayload | null {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
  const k = fields.k;
  if (k !== "open" && k !== "ask" && k !== "done") return null;
  const { need, may } = KEYS[k];
  for (const key of Object.keys(fields)) {
    if (!need.includes(key) && !may.includes(key)) return null;
    const value = fields[key];
    if (typeof value !== "string" || !SHAPES[key]!(value)) return null;
  }
  if (!need.every((key) => typeof fields[key] === "string")) return null;
  // A code rides only beside the challenge it was minted for, and a challenge only beside the sender's pairing.
  if (k === "open" && ((fields.l !== undefined && fields.c === undefined) || (fields.c !== undefined && fields.d === undefined))) {
    return null;
  }
  return fields as unknown as SwitchPayload;
}

/** The payload as the fields a native call carries. */
export function payloadFields(p: SwitchPayload): Record<string, string> {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}
