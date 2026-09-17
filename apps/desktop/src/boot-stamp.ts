/**
 * THE PRE-PAINT STAMP - the first frame is the person's face and scheme.
 *
 * The window's BLOCKING head script (`<script src="./boot-stamp.js">`, no module, defer or
 * async), built to its own file by the boot-stamp plugin in `vite.config.ts`. It ran from
 * `main.tsx` before, which the document loads as a module script and therefore defers: measured
 * on the Omarchy guest, 278 ms of the paper face's canvas at the start of every launch. Not
 * inline because `script-src 'self'` lives in two homes and a hash would have to be kept in step
 * with this file in both. The mapping law is out of reach here - `omarchy-paint.ts` says why.
 */
import { paintCachedOmarchyPalette } from "./omarchy-paint.js";

/* The THEME. `themeInitScript()` from @ohmail/ui exists for server-rendered pages, which
   inline it as a <script>; the desktop CSP forbids inline scripts, so the same contract is
   executed here from a file instead: an explicit preference is stamped on <html>, absent
   means follow the system. */
try {
  const stored = localStorage.getItem("ohmail.theme");
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
} catch {
  /* storage blocked — tokens.css falls back to prefers-color-scheme */
}

/* …and the FACE/LAYOUT halves of the same contract (review-caught: the axis went opt-in and
   the desktop is a host that DID wire the controls — the shared Settings Look row — and
   carries the Omarchy live feed, whose CSS is scoped to [data-face="ohmarchy"]). The
   provider re-resolves after mount; this stamp only kills the pre-paint flash. Each storage
   read sits in its own try so a blocked jar still reaches the Linux detection. */
{
  let face: string | null = null;
  try { face = localStorage.getItem("ohmail.face"); } catch { /* blocked — fall through */ }
  if (face !== "paper" && face !== "ohmarchy") {
    try { face = localStorage.getItem("ohmail.face.account"); } catch { /* fall through */ }
  }
  if (face !== "paper" && face !== "ohmarchy") {
    face = /Linux/.test(navigator.platform ?? "") && !/Android|CrOS/.test(navigator.userAgent ?? "")
      ? "ohmarchy" : "paper";
  }
  if (face === "ohmarchy") document.documentElement.dataset.face = "ohmarchy";
  /* …and the THEME ITSELF, from the last launch. The feed cannot answer before the window
     paints — its command is a round trip to the shell — so without this the first frames wear
     the static face block, whose light side is a warm cream, and a dark desktop opens on a pale
     flash. The cached set carries all three scheme states, so the stamp above decides which one
     shows, and the feed's first pull then fades whatever actually changed. */
  if (face === "ohmarchy") paintCachedOmarchyPalette();
  let layout: string | null = null;
  try { layout = localStorage.getItem("ohmail.layout"); } catch { /* blocked */ }
  if (layout === "zero") document.documentElement.dataset.layout = "zero";
}

/* THE COLUMN WIDTHS ARE NOT HERE, and that is a measured boundary rather than an oversight:
   `stampColumns` lives in `column-store.ts`, which reaches `persisted-ui.ts`, which imports
   React — the whole framework in the paint-blocking file for three numbers. It stays in
   `main.tsx`, where it always ran, ahead of `createRoot`. Geometry that arrives a paint late
   reflows; a face that arrives a paint late is the wrong colours, which is this file's job. */
