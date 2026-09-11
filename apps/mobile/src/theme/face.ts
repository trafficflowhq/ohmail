/**
 * The appearance face on a phone — paper / ohmarchy, and which scope wins. A second appearance
 * dimension, orthogonal to light/dark (OHMARCHY-PLAN.md §3a): light/dark decides which
 * palette, the face decides which SET of palettes, radii, lifts and easings (`./ohmarchy.ts`).
 * Pure and renderer-free, driven by `test/ohmarchy-face.test.ts`. Resolution: (1) `pin` — this
 * device's explicit choice, which outranks the account here because that is what the scope
 * option promised; (2) `account` — `GET /consent`'s `themeFace`, where `null` means "no
 * preference", never "paper"; (3) `paper`. Deliberately no device-detection arm: the web's
 * Linux default would flip every Android phone (a Linux kernel) to a face nobody asked for. On a phone the face is opt-in only.
 */

/** The appearance face — `paper` is today's look, `ohmarchy` the tiling one. */
export type FaceName = "paper" | "ohmarchy";

/** Paper is the resting face: absence of every input reads as paper, never as unknown. */
export const DEFAULT_FACE: FaceName = "paper";

/** The wire's `themeFace`, kept only if it names a face this build has. */
export function faceOf(raw: unknown): FaceName | null {
  return raw === "paper" || raw === "ohmarchy" ? raw : null;
}

/**
 * Device pin, then account, then paper — see the header for why there is no third arm.
 *
 * Both inputs are `FaceName | null`, and `null` is "no choice at this scope" in both cases.
 */
export function resolveFace(pin: FaceName | null, account: FaceName | null): FaceName {
  return pin ?? account ?? DEFAULT_FACE;
}

/**
 * Does the ACCOUNT govern this device's face right now? The scope line renders this, and
 * "Applies on all your devices" may only be claimed when it is true.
 *
 * Both halves are required, exactly as the webapp's `FaceRow` requires them: the account's
 * stored answer must be the face actually on screen AND no device pin may outrank it. A pin
 * equal to the account's value still pins — an account change made elsewhere would not reach
 * here — so it keeps the apply-all affordance rather than normalising the redundancy away.
 */
export function accountGovernsFace(
  face: FaceName,
  pin: FaceName | null,
  account: FaceName | null,
): boolean {
  return account === face && pin === null;
}

/**
 * May the "apply on all devices" affordance be offered at all? Two conditions, and the first
 * is the one a first draft gets wrong: `account` is `null` both when the account has no
 * preference and when nobody has asked yet, and a write must not treat those alike — with no
 * device pin the control shows paper, so a press before the account's face was read would
 * PATCH paper over an ohmarchy the account really holds. `accountKnown` is "an answer has been
 * adopted this session" — the webapp's `themeFaceKnown`, gating the same affordance. The
 * second is {@link accountGovernsFace}: nothing to offer when the account already governs this
 * device. A withheld affordance is drawn nowhere, never disabled.
 */
export function accountWideOffered(
  accountKnown: boolean,
  face: FaceName,
  pin: FaceName | null,
  account: FaceName | null,
): boolean {
  return accountKnown && !accountGovernsFace(face, pin, account);
}

/** Teaching intensity — the contract's one JS-visible switch: 0 (paper, calm) / 1 (ohmarchy). */
export function teachOf(face: FaceName): 0 | 1 {
  return face === "ohmarchy" ? 1 : 0;
}
