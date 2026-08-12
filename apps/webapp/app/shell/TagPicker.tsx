"use client";

/**
 * The tag picker popover: filter, ↵ toggles the highlighted tag, Escape
 * closes, outside click dismisses. Position is computed from the anchor
 * exactly like the prototype (below, clamped to the viewport).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { TagDTO } from "@ohmail/client-engine";
import { TagDot } from "@ohmail/ui";
import { hueOf } from "./format";

export interface TagPickerState {
  forId: string;
  x: number;
  y: number;
  /** The anchor's edges, for `useOverlayClamp` — see `overlay-clamp.ts`. */
  anchorTop?: number;
  anchorBottom?: number;
}

/**
 * Where an anchored popover opens. The `x`/`y` here are an ESTIMATE — the flip guesses 190px of
 * height, which is roughly this picker and half a sender sheet — so the anchor's own edges ride
 * along for `useOverlayClamp` (`overlay-clamp.ts`) to re-place the box against its MEASURED
 * height after render. Callers spread the whole return into their overlay state.
 */
export function placePicker(anchor: HTMLElement | null): {
  x: number;
  y: number;
  anchorTop: number;
  anchorBottom: number;
} {
  const r = anchor?.getBoundingClientRect() ?? {
    left: window.innerWidth / 2 - 120,
    bottom: window.innerHeight / 3,
    top: window.innerHeight / 3,
  };
  const w = 240;
  const pad = 10;
  const h = 190;
  const x = Math.min(Math.max(r.left, pad), window.innerWidth - w - pad);
  let y = r.bottom + 8;
  if (y + h > window.innerHeight - pad) y = Math.max(pad, r.top - h - 8);
  return { x, y, anchorTop: r.top, anchorBottom: r.bottom };
}

export function TagPicker({
  state,
  tags,
  assigned,
  onToggle,
  onCreate,
  onClose,
}: {
  state: TagPickerState;
  tags: TagDTO[];
  /** Tag ids currently on the target message. */
  assigned: string[];
  onToggle: (tagId: string, assigned: boolean) => void;
  /**
   * Mint a tag that does not exist yet and put it on this message.
   *
   * The picker had no create affordance at all until the backend landed, which was survivable
   * only while the tag set came from fixtures: outside the demo the list starts EMPTY, so a
   * picker that can only filter an existing list is a feature nobody can reach. Separate from
   * `onToggle` because the shell mints the id — see `AppShell.toggleTag`.
   */
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("tag");
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useMemo(
    () => tags.filter((tag) => tag.name.toLowerCase().includes(query.trim().toLowerCase())),
    [tags, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const toggle = (tag: TagDTO) => {
    onToggle(tag.id, !assigned.includes(tag.id));
  };

  /**
   * Is what the user typed a NEW name? Compared case-insensitively against the whole tag set
   * and not against the filtered `list`, because the unique index is on `lower(name)` — offering
   * to create "Invoices" while "invoices" exists would promise a tag the server answers 409 for.
   */
  const typed = query.trim();
  const canCreate =
    typed.length > 0 && !tags.some((tag) => tag.name.toLowerCase() === typed.toLowerCase());

  return (
    <div
      ref={rootRef}
      className="tagp"
      role="dialog"
      aria-label={t("pickerAria")}
      style={{ left: state.x, top: state.y }}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder={t("pickerPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // ↵ toggles the highlighted tag, or creates when nothing matches — the same key for
          // "the tag you meant", which is what the footer promises.
          if (e.key === "Enter" && list[0]) toggle(list[0]);
          else if (e.key === "Enter" && canCreate) onCreate(typed);
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <ul role="listbox">
        {list.length ? (
          list.map((tag, i) => (
            <li
              key={tag.id}
              role="option"
              aria-selected={i === 0}
              className={i === 0 ? "sel" : undefined}
              onClick={() => toggle(tag)}
            >
              <TagDot hue={hueOf(tag)} />
              {tag.name}
              {assigned.includes(tag.id) ? <span className="ck">✓</span> : null}
            </li>
          ))
        ) : canCreate ? null : (
          <li className="none">{t("pickerNone")}</li>
        )}
        {canCreate ? (
          <li role="option" aria-selected={list.length === 0} className="mk" onClick={() => onCreate(typed)}>
            {t("pickerCreate", { name: typed })}
          </li>
        ) : null}
      </ul>
      {/* The honest sentence, at the point of creation. A tag is OURS — it is not written to
          the mailbox — so it cannot be found in another mail client and it does not come back
          from IMAP if this account is erased. Said here rather than buried in Settings because
          this is the moment the user is deciding to rely on it. */}
      <div className="tagp-foot">{t("pickerFoot")}</div>
      <div className="tagp-note">{t("notOnServer")}</div>
    </div>
  );
}
