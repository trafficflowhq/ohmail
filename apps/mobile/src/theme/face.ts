/**
 * THE APPEARANCE FACE ON A PHONE — paper / ohmarchy, and which scope wins.
 *
 * The face is a SECOND appearance dimension, orthogonal to light/dark (OHMARCHY-PLAN.md §3a,
 * OHMARCHY-CONTRACT.md). Light/dark decides which palette; the face decides WHICH SET of
 * palettes, radii, lifts and easings the theme is built from. Every value comes from
 * `./ohmarchy.ts`, which is generated from the same web face — see that file's header.
 *
 * Pure and renderer-free on purpose (the `live.ts` charter): the provider in `./index.tsx`
 * imports react-native and therefore cannot be driven by the node suite, so every rule that
 * could be got wrong lives here, where `test/ohmarchy-face.test.ts` drives it directly.
 *
 * ── THE RESOLUTION ORDER, AND THE ONE ARM A PHONE DOES NOT HAVE ────────────────────────────
 *
 *   1. `pin` — THIS DEVICE's explicit choice ("only this device"). It outranks the account on
 *      this device because that is exactly what the scope option promised when it was chosen; a
 *      pinned phone deliberately ignores an account change made on a laptop.
 *   2. `account` — the account-level synced choice, as last answered by `GET /consent`
 *      (`themeFace`). `null` means the account has no preference, never "paper" — the two are
 *      different answers and only the first may be overridden by a later account write.
 *   3. `paper`. Nothing else.
 *
 * **There is deliberately NO device-detection arm here, and that is a judgment worth stating.**
 * The web provider has a third input: a LINUX desktop with no choice at either scope defaults
 * to ohmarchy (plan §12, Option B — the wedge bet on Linux visitors, made because a browser can
 * reveal "Linux" but never "Omarchy"). A phone is not that device. Android reports a Linux
 * kernel and every Android phone would flip to a tiling desktop face nobody asked for; iOS
 * reports nothing to bet on. More basically, the offer Option B exists to make — "go full
 * ohmarchy on all your devices" — is a DESKTOP-DOOR offer aimed at someone who is already
 * running the window manager the face is homage to. So on a phone the face is opt-in only: the
 * Settings control, or an account that adopted it somewhere it made sense. The plan's guardrails
 * (one tap back, an explicit choice always wins) are unaffected because there is no detection
 * for them to guard.
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
 * MAY THE "APPLY ON ALL DEVICES" AFFORDANCE BE OFFERED AT ALL? (review-caught.)
 *
 * Two conditions, and the first is the one a first draft gets wrong. `account` is `null` both
 * when the account has NO preference and when nobody has asked it yet, and those must not be
 * treated alike by a WRITE: with no device pin the control shows paper, so a press made before
 * the account's face was read would PATCH paper over an ohmarchy the account really holds whose
 * read was slow or failing. `accountKnown` is "an answer has been adopted this session — a
 * successful read, or a write's own echo", the same fact the webapp carries as `themeFaceKnown`
 * and gates the same affordance on.
 *
 * The second condition is {@link accountGovernsFace}: there is nothing to offer when the account
 * already governs this device — the scope line simply says so.
 *
 * A withheld affordance is drawn NOWHERE, never disabled: a control that cannot control is worse
 * than a sentence saying which scope this device is in.
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
