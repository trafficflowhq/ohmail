import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
import { TagDot, type TagHueName } from "../primitives/Chip.js";
import "./rail.css";

export interface RailItem {
  id: string;
  label: string;
  count?: number;
  /** Accent-colored count (actionable attention: Ohbox unread, Screener). */
  hot?: boolean;
  /** Keycap instead of a count (Search "/"). */
  kbdHint?: string;
  /** Tooltip / accessible enrichment ("4 unread of 9"). */
  title?: string;
  /**
   * The row's own quick-nav key, revealed ONLY while the row is hovered or keyboard-focused —
   * a shortcut you discover by pointing at the thing, not a badge charged to every row forever.
   *
   * It takes the count's slot for the moment of the reveal (like `kbdHint`, but transient), and
   * is deliberately NOT rendered at rest: nothing is in the DOM until a pointer or Tab lands on
   * the row, so the resting rail keeps its counts and no keycaps. A tap can fire a compatibility
   * `mouseenter` (and some engines focus a button on tap), so the reveal is also cleared on
   * click — otherwise a touch that navigated would leave the keycap standing in the count's
   * place. `kbdHint` wins when both are set (the `?` sheet is a louder, deliberate "show me
   * every key" and should not be undercut by a per-row reveal).
   */
  navKey?: string;
}

export interface RailTagItem {
  id: string;
  label: string;
  hue: TagHueName;
  count?: number;
}

/**
 * Make a tag from the rail itself, inline — no dialog.
 *
 * The group carries a `+ {label}` trigger at its end that opens an input IN PLACE, and when
 * there are no tags yet an `emptyHint` line invites the first one instead of leaving the group
 * blank. Everything semantic stays with the host: `onCreate` mints the tag, and the optional
 * `duplicate` answers whether the typed name already exists (the server's unique index is on
 * `lower(name)`, so a name that collides would 409) and phrases the refusal for it. `RailNav`
 * owns only the open/close of the input and the keys that drive it.
 */
export interface RailTagCreate {
  /** Verb on the trigger row and the input's accessible name — "New tag". */
  label: string;
  placeholder: string;
  /** Shown when the group holds no tags — the invite to the first one. */
  emptyHint?: string;
  onCreate: (name: string) => void;
  /**
   * Reject a name that already exists (case-insensitive — the server's unique index is on
   * `lower(name)`, so a collision would 409). The `taken` check and the `label` for the refusal
   * travel together on purpose: a `taken` with no `label` is a submit that silently refuses,
   * and the user typed the name and is owed the reason.
   */
  duplicate?: {
    taken: (name: string) => boolean;
    label: (name: string) => string;
  };
}

export interface RailGroup {
  label?: string;
  items: RailItem[];
  /** Subordinate collapsible Tags group, nested under this group. */
  tags?: {
    label?: string;
    items: RailTagItem[];
    defaultOpen?: boolean;
    /** Controlled collapse state. Provide with `onOpenChange` when the host persists it. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Inline "New tag" affordance. Omit and the group is read-only. */
    create?: RailTagCreate;
  };
}

export interface RailMailbox {
  name: string;
  hint: string;
}

export interface RailNavProps {
  /** Defaults to the ohmail wordmark. */
  wordmark?: ReactNode;
  composeLabel?: string;
  composeKbd?: string;
  onCompose?: () => void;
  composeActive?: boolean;
  groups: RailGroup[];
  activeId?: string;
  onNavigate?: (id: string) => void;
  activeTagId?: string;
  onNavigateTag?: (id: string) => void;
  mailboxesLabel?: string;
  mailboxes?: RailMailbox[];
  /**
   * THE SHELL'S OWN CONTROLS, AT THE FOOT OF THE RAIL.
   *
   * Things that act on the app rather than on mail — opening the command palette, switching the
   * theme. They used to float in a fixed capsule centred over the bottom of the page, which cost
   * every scrolling surface a clearance band and put two controls permanently on top of the mail.
   * The rail is where the app's own chrome already lives, so they sit at the end of it, above the
   * account line.
   *
   * `ReactNode` and not a typed list: the controls are the host's, written in the rail's own
   * vocabulary (`.ritem`, with a keycap in `.cnt` exactly as the Search row carries "/"), and
   * `RailNav` only gives them a place and a hairline. **Optional and default-absent** — the
   * desktop shell renders the same rail with no dock and is untouched by this.
   *
   * The dock lays out as ONE FLEX ROW (`rail.css`): a host marks the control that should take
   * the line with `.dock-cmd` and any icon-width control with `.dock-theme`. A host that marks
   * neither gets children sized by their own content, which is the sane default rather than a
   * broken one.
   */
  dock?: ReactNode;
  /**
   * WHAT THE MAILBOX IS DOING, immediately above the dock.
   *
   * The host's sync line — a first import running, a drain that keeps failing, a mailbox that
   * needs its password again. It used to be a full-width strip across the top of every view (or,
   * for the progress states, a pill floating over the bottom-left corner of the mail), which put
   * app-level chrome on top of somebody's reading. It is app-level chrome, so it belongs where
   * the rest of it already lives.
   *
   * Above the dock rather than below it: the dock is a pair of controls that are always there,
   * and this appears and disappears. A row that comes and goes must not push the two fixed
   * controls around, and it does not — `.rail-sync-slot` takes the rail's slack instead of the
   * dock (`rail.css`), so the dock and the account line stay welded to the bottom edge whether
   * this is present or not.
   *
   * `ReactNode` and default-absent for the same reason `dock` is: the desktop shell renders this
   * rail without one.
   */
  sync?: ReactNode;
  /** Bottom line — the account address. */
  footer?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

/** Animated count — ticks up on change like the prototype's counters. */
function Count({ value, hot }: { value?: number; hot?: boolean }) {
  const prev = useRef(value);
  const [tick, setTick] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setTick(true);
      const t = setTimeout(() => setTick(false), 340);
      return () => clearTimeout(t);
    }
  }, [value]);
  return (
    <span className={hot ? "cnt hot num" : "cnt num"}>
      <span key={value} className={tick ? "tick" : undefined}>
        {value && value > 0 ? value : ""}
      </span>
    </span>
  );
}

/**
 * The navigation rail: compose CTA on top, route groups with badges,
 * the collapsible Tags group subordinate to Triage, mailboxes, and the
 * account footer.
 */
export function RailNav({
  wordmark,
  composeLabel = "Compose",
  composeKbd = "c",
  onCompose,
  composeActive,
  groups,
  activeId,
  onNavigate,
  activeTagId,
  onNavigateTag,
  mailboxesLabel = "Mailboxes",
  mailboxes,
  dock,
  sync,
  footer,
  ariaLabel = "Main",
  className,
}: RailNavProps) {
  /**
   * WHICH ROW IS SHOWING ITS QUICK-NAV KEY, and it is at most one.
   *
   * A row reveals its `navKey` while it is hovered or keyboard-focused and hides it otherwise,
   * so the keycap is a thing you find by pointing at a row rather than a badge every row wears.
   * One id, not a per-row flag: hover and Tab both land on a single row at a time, and blur of
   * the row you leave fires before focus of the one you enter, so the last interaction wins
   * cleanly. Clearing is guarded on identity so a stale leave cannot blank the row you just
   * moved to.
   */
  const [revealId, setRevealId] = useState<string | null>(null);
  const reveal = (item: RailItem): void => {
    if (item.navKey) setRevealId(item.id);
  };
  const unreveal = (item: RailItem): void =>
    setRevealId((cur) => (cur === item.id ? null : cur));
  return (
    <nav className={className ? `rail ${className}` : "rail"} aria-label={ariaLabel}>
      <div className="wordmark">
        {/* Two elements, not one string: `.wordmark b em` paints the `em` half
            in accent-ink, so the rail echoes the "oh." app mark. Keep the split
            at the word boundary — oh | mail — and keep it lower-case. The accent
            is on "oh" wherever it falls; the rename moved it from the tail to
            the head, which is the same motif reading the same way. */}
        {wordmark ?? (
          <b>
            <em>oh</em>mail
          </b>
        )}
      </div>

      {onCompose ? (
        <button
          type="button"
          className={composeActive ? "compose-cta on" : "compose-cta"}
          onClick={onCompose}
        >
          <Icon name="pen" /> {composeLabel}
          {composeKbd ? <Kbd>{composeKbd}</Kbd> : null}
        </button>
      ) : null}

      {groups.map((group, gi) => (
        <div className="rgroup" key={group.label ?? gi}>
          {group.label ? <div className="rlabel">{group.label}</div> : null}
          {group.items.map((item) => {
            // The `?` sheet's key (`kbdHint`) is deliberate and always shown; the per-row
            // reveal (`navKey`) only while this row is pointed at. Either takes the count's
            // slot — a hovered row is one you are about to reach, so its key is what you want
            // there — and at rest neither is present, which is what keeps the resting rail quiet.
            const cap = item.kbdHint ?? (revealId === item.id ? item.navKey : undefined);
            return (
              <button
                key={item.id}
                type="button"
                // A stable, presentation-free hook on each rail entry. Nothing in the app
                // reads it; it lets an outside surface (the marketing page's embedded demo)
                // anchor a pointer to a specific entry without depending on label text.
                data-rail-id={item.id}
                className={item.id === activeId ? "ritem on" : "ritem"}
                title={item.title}
                aria-current={item.id === activeId ? "page" : undefined}
                onClick={() => {
                  // Clear before navigating: a tap can both reveal (compatibility mouseenter /
                  // focus-on-tap) and navigate, and without this the keycap would be left
                  // standing in the count's place with no pointer-leave ever coming.
                  unreveal(item);
                  onNavigate?.(item.id);
                }}
                onMouseEnter={() => reveal(item)}
                onMouseLeave={() => unreveal(item)}
                onFocus={() => reveal(item)}
                onBlur={() => unreveal(item)}
              >
                {item.label}
                {cap ? (
                  <span className="cnt">
                    <Kbd>{cap}</Kbd>
                  </span>
                ) : (
                  <Count value={item.count} hot={item.hot} />
                )}
              </button>
            );
          })}
          {group.tags ? (
            <TagsGroup
              label={group.tags.label ?? "Tags"}
              items={group.tags.items}
              defaultOpen={group.tags.defaultOpen ?? true}
              open={group.tags.open}
              onOpenChange={group.tags.onOpenChange}
              create={group.tags.create}
              activeTagId={activeTagId}
              onNavigateTag={onNavigateTag}
            />
          ) : null}
        </div>
      ))}

      {mailboxes?.length ? (
        <div className="rgroup">
          <div className="rlabel">{mailboxesLabel}</div>
          {mailboxes.map((m) => (
            <div className="mbx" key={m.name}>
              <i />
              <span className="nm">{m.name}</span>
              <small>{m.hint}</small>
            </div>
          ))}
        </div>
      ) : null}

      {sync ? <div className="rail-sync-slot">{sync}</div> : null}
      {dock ? <div className="rail-dock">{dock}</div> : null}
      {footer ? <div className="rail-mail">{footer}</div> : null}
    </nav>
  );
}

/**
 * CONTROLLED-OPTIONAL, deliberately.
 *
 * The collapse state has to SURVIVE A RELOAD — "saved if it's collapsed or not so ui stays as
 * one left it". But persistence is a host concern, not a design-system one: `packages/ui` is
 * shared with the desktop shell, which has no `localStorage` and no business inheriting the
 * web client's storage decisions. So the component takes `open`/`onOpenChange` when a host
 * wants to own the state, and falls back to its own `useState(defaultOpen)` when nobody does.
 *
 * That keeps the fallback honest too: an uncontrolled group still works, it just forgets — so
 * a host that forgets to wire persistence gets today's behaviour rather than a broken toggle.
 */
function TagsGroup({
  label,
  items,
  defaultOpen,
  open: openProp,
  onOpenChange,
  create,
  activeTagId,
  onNavigateTag,
}: {
  label: string;
  items: RailTagItem[];
  defaultOpen: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  create?: RailTagCreate;
  activeTagId?: string;
  onNavigateTag?: (id: string) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const setOpen = (next: boolean): void => {
    if (openProp === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  };

  /**
   * MAKING A TAG HAPPENS IN THE GROUP, not in a dialog over it.
   *
   * The trigger row swaps itself for an input in place; the input owns Enter (submit) and
   * Escape (cancel), and STOPS the Escape so the shell's overlay ladder does not also act on a
   * key the innermost open thing already handled. A name that already exists cannot be
   * submitted — the server's unique index is on `lower(name)` — and the reason is said rather
   * than the button silently disabled, because the user typed it and is owed why. Focus moves
   * to the input the moment it appears; a blur with nothing typed closes it, so clicking away
   * from an empty field is not a half-open state.
   */
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const typed = draft.trim();
  const taken = typed.length > 0 && (create?.duplicate?.taken(typed) ?? false);
  const canCreate = typed.length > 0 && !taken;
  const submit = (): void => {
    if (!canCreate || !create) return;
    create.onCreate(typed);
    setDraft("");
    setCreating(false);
  };
  const cancel = (): void => {
    setDraft("");
    setCreating(false);
  };

  return (
    <div className={open ? "rgroup rsub" : "rgroup rsub closed"}>
      {/*
       * THE CHEVRON LEADS. It used to trail the label — `{label} <Icon/>` — which put it
       * exactly where the navigable rows above put their count, so the group header read as
       * a destination rather than as a disclosure. Clicking it then collapses the group,
       * which looks like a feature that has stopped working: the list you were pointing at
       * disappears and the view does not change.
       *
       * A leading chevron is the conventional affordance for "this opens" everywhere a tree
       * appears, and it is the whole change: same button, same `aria-expanded`, same rotation.
       * `Icon` already sets `aria-hidden` on the svg itself, so the state is announced once,
       * by the button.
       */}
      <button
        type="button"
        className="rlabel-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chev" className="chev" />
        {label}
      </button>
      <div className="rgroup-body">
        {items.map((t) => (
          <button
            key={t.id}
            type="button"
            // The same presentation-free hook every nav row above carries as `data-rail-id`:
            // it lets a host surface (the shell's drag-to-file) name the tag a gesture landed
            // on without depending on label text. Nothing in this package reads it.
            data-rail-tag-id={t.id}
            className={t.id === activeTagId ? "ritem on" : "ritem"}
            onClick={() => onNavigateTag?.(t.id)}
          >
            <TagDot hue={t.hue} />
            {t.label}
            <span className="cnt num">{t.count ?? ""}</span>
          </button>
        ))}

        {/* No tags yet: an invite to the first, not a blank group. Gated on the hint's presence
            so a host that gives none does not paint an empty padded line. */}
        {create?.emptyHint && items.length === 0 && !creating ? (
          <p className="rsub-empty">{create.emptyHint}</p>
        ) : null}

        {create ? (
          creating ? (
            <div className="ritem ritem-new">
              {/* The `+` sits exactly where a tag dot does, so the input reads as the row it
                  replaced rather than as a control that dropped in. */}
              <Icon name="plus" className="ritem-plus" />
              <input
                ref={inputRef}
                className="ritem-new-input"
                value={draft}
                placeholder={create.placeholder}
                aria-label={create.label}
                aria-invalid={taken || undefined}
                maxLength={40}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                  // Handled and stopped here — this input is the innermost open thing, so the
                  // shell's Escape ladder must not also fire on the same key.
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    cancel();
                  }
                }}
                onBlur={() => {
                  if (typed.length === 0) cancel();
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              className="ritem ritem-action"
              onClick={() => setCreating(true)}
            >
              {/* Quieter than a tag until hovered, and never `on` — it is a verb, not a place. */}
              <Icon name="plus" className="ritem-plus" />
              {create.label}
            </button>
          )
        ) : null}

        {taken && create?.duplicate ? (
          <p className="rsub-warn" role="alert">
            {create.duplicate.label(typed)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
