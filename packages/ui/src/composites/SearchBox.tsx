import type { ReactNode } from "react";
import { Icon } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
import { TextField } from "../primitives/TextField.js";
import "./search.css";

export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /**
   * THE WORDS, FROM THE HOST — neither of these defaults any more, and the reason is the same
   * one that emptied `CommandPalette`'s defaults.
   *
   * They used to read `placeholder = "Search everything — typos welcome"` and
   * `ariaLabel = "Search"`. A composite in this package has no catalogue to read, so a default
   * here is an English string that renders in every locale — and an optional prop puts no
   * obligation on any call site to notice. The pill is the widest thing on the search view;
   * `search.placeholder` and `search.aria` were sitting in both catalogues, translated, with
   * nothing wired to them.
   *
   * Required, so a new call site cannot render this in English by omission.
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

export interface SearchHitProps {
  who: string;
  where: string;
  /** Subject; pass rich children to include <mark> highlights. */
  subject: ReactNode;
  /** Fuzzy-match annotation capsule. */
  fuzzyNote?: string;
  onPress?: () => void;
}

/** One search result row. */
export function SearchHit({ who, where, subject, fuzzyNote, onPress }: SearchHitProps) {
  return (
    <button type="button" className="hit" onClick={onPress}>
      <span className="top" style={{ display: "flex" }}>
        <span className="who">{who}</span>
        <span className="where">{where}</span>
      </span>
      <span className="subj" style={{ display: "block" }}>
        {subject}
        {fuzzyNote ? <span className="fuzzy">{fuzzyNote}</span> : null}
      </span>
    </button>
  );
}
