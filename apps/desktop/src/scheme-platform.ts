/**
 * WHICH BUILDS MAY CROSSFADE THE SCHEME WITH `startViewTransition`. Linux may not: WebKitGTK
 * without a GPU backing store crashes the app on the first view transition (issue #9), and
 * nothing the page can read says which machines those are. The `scheme-shift` CSS fade stands
 * in. Reached by the path `omarchy-paint.ts` uses, so the switch and the feed share one module.
 */
import { setViewTransitions } from "../../../packages/ui/src/theme/scheme-transition.js";
import { BUILD_PLATFORM } from "./platform.js";

export function configureSchemeTransitions(platform: string = BUILD_PLATFORM): void {
  setViewTransitions(platform !== "linux");
}
