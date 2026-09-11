import { Icon } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
import { TextField } from "../primitives/TextField.js";
import "./search.css";

export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /**
   * The words come from the host; neither defaults any more, for the
   * reason that emptied `CommandPalette`'s defaults: a composite here has
   * no catalogue, so a default is an English string rendering in every
   * locale, and an optional prop puts no obligation on a call site to
   * notice. `search.placeholder` and `search.aria` sat translated in both
   * catalogues with nothing wired to them. Required, so a new call site
   * cannot render English by omission.
   */
  placeholder: string;
  ariaLabel: string;
  /** Trailing keycap; defaults to ↵. */
  kbdHint?: string | null;
  autoFocus?: boolean;
  className?: string;
}

/** The search pill — a lift-1 capsule that rings accent on focus. */
export function SearchBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  ariaLabel,
  kbdHint = "↵",
  autoFocus,
  className,
}: SearchBoxProps) {
  return (
    <div className={className ? `search-box ${className}` : "search-box"}>
      <Icon name="search" />
      <TextField
        shape="line"
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit?.(value);
        }}
      />
      {kbdHint ? <Kbd>{kbdHint}</Kbd> : null}
    </div>
  );
}

export interface FacetGroup {
  title: string;
  items: { label: string; count?: number }[];
}

export interface FacetsProps {
  groups: FacetGroup[];
  onPick?: (group: string, label: string) => void;
  className?: string;
}

/** The facet rail beside search results. */
export function Facets({ groups, onPick, className }: FacetsProps) {
  return (
    <aside className={className ? `facets ${className}` : "facets"}>
      {groups.map((g) => (
        <div key={g.title}>
          <h4>{g.title}</h4>
          <ul>
            {g.items.map((it) => (
              <li key={it.label} onClick={() => onPick?.(g.title, it.label)}>
                {it.label}
                {it.count !== undefined ? <span className="n">×{it.count}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  );
}

/* ── `SearchHit` IS RETIRED, AND `search.css` IS NOT ───────────────────────────────────────
 *
 * There was a `SearchHit` here: one `<button class="hit">` holding a who/where line and a
 * subject. No product surface ever rendered it. The webapp's own result row grew a second
 * control — the sender's address, which opens everything from and to that address — and a
 * button may not hold interactive content, so the shipped row is a `<div class="hit">` with a
 * stretched `<button class="hit-open">` inside it. That row is `SearchHitRow` in
 * `apps/webapp/app/views/SearchView.tsx`, and this component could not become it without
 * becoming a different component.
 *
 * An export with no consumer is a claim that outlives the code: it compiles, the smoke test
 * renders it, the showcase advertises it as the way this design system draws a result, and
 * nobody can reach it in the product. So it is deleted rather than left as a second answer to
 * a question the product has already answered once.
 *
 * `search.css` stays and is still imported below. Its `.hit` rules — the radius, the padding,
 * the hover lift, `.who` / `.where` / `.subj` / `mark` — are what the webapp's row is built on,
 * and it reaches them through this file's import of `SearchBox`. Deleting the stylesheet with
 * the component would have taken the ground out from under the shipped row, which is the kind of
 * deletion that renders as a design regression with every test green.
 */
