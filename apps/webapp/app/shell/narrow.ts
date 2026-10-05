/**
 * The narrow question, asked once — "is the reading column off screen at this width?" Classic has one phone
 * breakpoint (under 700px the column is `display:none` and "open" means the reader sheet; from 700 the split is
 * two panes, list and reader, with the rail still a drawer up to 1023 — DESIGN-FOLD-WIDTHS §0), and eleven call
 * sites asked that media query inline — one predicate written ten times. The Zero layout moves the ANSWER without
 * moving the question: under `data-layout="zero"` the split survives to 722px beside a docked ribbon
 * (OHMARCHY-PLAN.md §12's ladder), so the column only leaves at 721 — a per-site edit would be ten copies of a
 * layout branch; here it is one, ledgered once in the census.
 */

/**
 * The attribute, not React context, deliberately: this is called from module-level code (zone-nav's focus guards) and
 * from views that must not each grow a theme hook — `data-layout` is stamped pre-paint by the boot script and owned
 * by the ONE ThemeProvider, so the attribute IS the fact.
 */

/** The zero ladder's one JS-visible boundary: the split dies under 722 (§12: 52+5+320+10+325+10). */
const ZERO_NARROW = "(max-width: 721px)";
/**
 * Classic's PHONE edge — the last width at which a split view is one column and the reader is
 * the floating sheet (`app.css`'s `(max-width: 699.98px)` block hides `.read-col` there). The
 * `.98` is the range-context spelling: one pair per threshold, `699.98` / `700`, so no
 * fractional width matches both halves or neither (the 900.5px lesson in app.css).
 */
const CLASSIC_NARROW = "(max-width: 699.98px)";
/**
 * Classic's DRAWER edge — the last width at which the rail is a drawer under a topbar
 * (`app.css`'s `(max-width: 1023.98px)` block). Between the two edges the shell is a topbar over
 * two panes: the column is on screen and the rail is still a drawer, which is why the drawer
 * question is no longer the column question.
 */
const CLASSIC_DRAWER = "(max-width: 1023.98px)";

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
 * {@link zeroPushTier}, SUBSCRIBED — a render-time read goes stale the moment `w` restamps
 * the layout or a resize crosses the band with the sheet still standing (review finding,
 * round 2), and nothing re-renders for either. Same sources as {@link watchNarrow}: the
 * band's media query and the `data-layout` attribute.
 */
export function watchZeroPushTier(onChange: (push: boolean) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const emit = (): void => onChange(zeroPushTier());
  const mq = window.matchMedia("(min-width: 392px) and (max-width: 721px)");
  mq.addEventListener?.("change", emit);
  const mo =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver((muts) => {
          if (muts.some((m) => m.attributeName === "data-layout")) emit();
        })
      : null;
  mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-layout"] });
  return () => {
    mq.removeEventListener?.("change", emit);
    mo?.disconnect();
  };
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

/**
 * WHERE THE RAIL IS A DRAWER. Under classic's 1024px the rail is a drawer that stands over the page
 * when open (`app.css`); the Zero ladder docks it as a ribbon from 392px, so only under that is a
 * closed rail off canvas. A closed off-canvas rail is inert; an open drawer holds focus.
 */
export interface RailLayout { drawer: boolean; offCanvas: boolean }

export function railLayout(): RailLayout {
  if (typeof window === "undefined" || !window.matchMedia) return { drawer: false, offCanvas: false };
  const drawer = window.matchMedia(CLASSIC_DRAWER).matches;
  const docked = narrowQuery() === ZERO_NARROW && window.matchMedia("(min-width: 392px)").matches;
  return { drawer, offCanvas: drawer && !docked };
}

/** {@link railLayout}, subscribed: both breakpoints and the `data-layout` stamp. */
export function watchRailLayout(onChange: (layout: RailLayout) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const emit = (): void => onChange(railLayout());
  const mqs = [CLASSIC_DRAWER, "(min-width: 392px)"].map((q) => window.matchMedia(q));
  for (const mq of mqs) mq.addEventListener?.("change", emit);
  const mo = typeof MutationObserver !== "undefined"
    ? new MutationObserver((muts) => { if (muts.some((m) => m.attributeName === "data-layout")) emit(); })
    : null;
  mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-layout"] });
  return () => {
    for (const mq of mqs) mq.removeEventListener?.("change", emit);
    mo?.disconnect();
  };
}
