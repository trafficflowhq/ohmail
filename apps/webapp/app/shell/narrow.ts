/**
 * THE NARROW QUESTION, ASKED ONCE — "is the reading column off screen at this width?"
 *
 * ── WHY THIS MODULE EXISTS (ohmarchy Phase 3b, the Zero layout) ─────────────────────────
 *
 * Classic has ONE breakpoint: under 900px the reading column is `display:none` (app.css),
 * the rail is a drawer, and "open" means the reader sheet. Eleven call sites asked that
 * media query inline — the shell's `readColumnHidden`, four views' private copies of the
 * same function, four more inline reads in the Ohbox, and the Screener's subscription —
 * which was already one predicate written ten times.
 *
 * The Zero layout moves the answer WITHOUT moving the question: under `data-layout="zero"`
 * the split survives down to 722px beside a docked 52px ribbon (OHMARCHY-PLAN.md §12 —
 * the ruled ladder: full rail ≥900 · ribbon + split 722–899 · ribbon + one-tile push-nav
 * 392–721 · floating drawer <392), so the reading column only leaves at 721. A per-site
 * edit would be ten copies of a layout branch; here it is one, and the census ledgers it
 * once (`narrow.ts :: attr/cmp` — layout-slot selection: which SLOT the open message
 * renders into, the standing column or the sheet).
 *
 * The attribute, not the React context, deliberately: this is called from module-level
 * code (zone-nav's focus guards) and from views that must not each grow a theme hook —
 * and `data-layout` is stamped pre-paint by the boot script and owned by the ONE
 * ThemeProvider (OHMARCHY-CONTRACT.md), so the attribute IS the resolved fact.
 */

/** The zero ladder's one JS-visible boundary: the split dies under 722 (§12: 52+5+320+10+325+10). */
const ZERO_NARROW = "(max-width: 721px)";
/** Classic's one breakpoint — the shipping shell's, unchanged. */
const CLASSIC_NARROW = "(max-width: 900px)";

export function narrowQuery(): string {
  return typeof document !== "undefined" &&
    document.documentElement.dataset.layout === "zero"
    ? ZERO_NARROW
    : CLASSIC_NARROW;
}

/** Below the active layout's breakpoint the reading column is `display:none`, so a tap
 *  (or ↵) must open the reader sheet — the meaning every call site already had. */
export function readColumnHidden(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.(narrowQuery()).matches === true
  );
}

/**
 * The same answer for an EXPLICIT layout — the layout-cycle reconcile's question. `w` flips
 * the provider's state and the attribute lands in the PROVIDER's effect, which runs after
 * the shell's (child effects first), so a caller reacting to the new layout would read the
 * old stamp through {@link readColumnHidden}. Passing the value asks about the world the
 * change is creating, not the one it is leaving.
 */
export function readColumnHiddenFor(layout: "classic" | "zero"): boolean {
  const q = layout === "zero" ? ZERO_NARROW : CLASSIC_NARROW;
  return typeof window !== "undefined" && window.matchMedia?.(q).matches === true;
}

/**
 * The Zero ladder's PUSH tier — ribbon + one tile, the reader re-housed into the tile slot
 * (392–721, the CSS band zero-layout.css draws). The one JS consumer is the Reader's ARIA
 * claim: at this tier the sheet stands beside LIVE chrome and must not tell assistive tech
 * it is modal; under 392 the same sheet is the full-screen classic model and stays modal.
 */
export function zeroPushTier(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.layout === "zero" &&
    window.matchMedia?.("(min-width: 392px) and (max-width: 721px)").matches === true
  );
}

/**
 * SUBSCRIBED, not sampled — the Screener's need: a rotation or resize reveals `.scn-read`
 * without touching any other dependency, and a sampled value left the newly visible
 * preview idle (its own header). Subscribes BOTH breakpoints plus the `data-layout`
 * attribute (the `w` key flips the ladder without a resize), and hands the caller the
 * live answer; the caller never learns which layout produced it.
 */
export function watchNarrow(onChange: (narrow: boolean) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const emit = (): void => onChange(readColumnHidden());
  const mqs = [ZERO_NARROW, CLASSIC_NARROW].map((q) => window.matchMedia(q));
  for (const mq of mqs) mq.addEventListener?.("change", emit);
  const mo =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver((muts) => {
          if (muts.some((m) => m.attributeName === "data-layout")) emit();
        })
      : null;
  mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-layout"] });
  return () => {
    for (const mq of mqs) mq.removeEventListener?.("change", emit);
    mo?.disconnect();
  };
}
