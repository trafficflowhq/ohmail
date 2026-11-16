/**
 * The places and stages of the app this page is built for. `scripts/build-shell.mjs --app <app>` answers this import
 * with `mounted.<app>.ts`; only `main.tsx` imports it.
 */
import type { Mounted } from "./frame-supplies";

declare const mounted: Mounted;
export default mounted;
