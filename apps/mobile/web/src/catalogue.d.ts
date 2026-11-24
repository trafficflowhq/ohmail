/** The page's sentences: no file holds them; `scripts/build-shell.mjs` answers this module at build time (`PAGE_NAMESPACES`). */
import type { Messages } from "@ohmail/app/text";

declare const catalogue: { readonly en: Messages; readonly de: Messages };
export default catalogue;
