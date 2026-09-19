/**
 * The unknown≠empty reading this app renders every list through. It LIVES in
 * `@ohmail/client-engine` now: the web enforced the same rule by hand per view and its Ohbox
 * missed, so the rule moved to the package both surfaces compile rather than being copied into
 * a second one. This file stays as the phone's spelling of the import — every screen here says
 * `from "./surface"` — and adds nothing to it.
 */

export { countWhen, listSurface, metaWhen, saysEmpty } from "@ohmail/client-engine";
export type { ListSurface, ListSurfaceInput } from "@ohmail/client-engine";
