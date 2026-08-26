"use client";

/**
 * ═══ THE RECIPIENT FIELD — CHIPS OVER ONE WIRE STRING ════════════════════════════════════
 *
 * Recipients are always editable — To, Cc and Bcc alike, on every surface this field appears
 * on, compose and the reply's opened audience both. So every settled recipient is a CHIP —
 * removable one at a time, draggable within and between the To/Cc/Bcc rows, movable by
 * keyboard — and what is still being typed lives in a text input after the last chip, with
 * the address-book suggestions it always had.
 *
 * ── THE VALUE IS STILL ONE COMMA-SEPARATED STRING, AND THAT IS DELIBERATE ────────────────
 *
 * `ComposeFields.to` is one string and `parseRecipients` splits it on commas. That is the
 * shape the send path, the draft buffer, the autosave row and the validation error all
 * already speak, and the IDN slice's rule — the field's content IS the wire value — holds
 * only if this component never invents a second representation. So the chips are a RENDERING
 * of the string, not a replacement for it:
 *
 *   value = chip, chip, …, tail
 *
 * Every complete segment (one followed by a separator) is a chip; the final segment is the
 * input's text. Committing an entry — comma, Enter, blur, accepting a suggestion — appends a
 * separator, which is what turns the tail into a chip. `splitRecipients`/`joinRecipients`
 * are that bijection, exported because the move logic and the tests depend on it being one.
 *
 * ── WHAT A CHIP SHOWS vs WHAT IT IS ──────────────────────────────────────────────────────
 *
 * A chip SHOWS the display-decoded address (`displayAddress`, shell/idn.ts) — `nora@müller.ch`
 * for a stored `nora@xn--…` — but the entry underneath stays the wire form verbatim, and it is
 * the entry that travels on drag, on move and back into the string. The decode never reaches
 * the value; the input's own content is untouched wire text, exactly as the IDN slice pinned.
 * An entry that does not parse is shown raw and styled as the field's error idiom.
 *
 * ── KEYBOARD, COMPLETE ───────────────────────────────────────────────────────────────────
 *
 *   in the input   ↑/↓ list · ↵/Tab accept · , commits · Escape dismisses (unchanged)
 *                  Backspace on an EMPTY input removes the last chip
 *                  ← at the start of the input focuses the last chip
 *   on a chip      ←/→ move between chips and back to the input
 *                  Backspace/Delete removes the chip
 *                  Alt+←/→ reorders it within the row
 *                  Alt+↑/↓ moves it to the previous/next row (To ⇄ Cc ⇄ Bcc)
 *
 * The Alt-arrow path is the keyboard equivalent of the drag, and it is not optional: a
 * mouse-only interaction is a regression this product does not ship. Cross-row moves go
 * through `onMove` so the OWNER of both strings applies them as ONE state change — two
 * `onChange` calls would each spread a stale copy of the other row and one would win.
 *
 * ↵ ACCEPTS RATHER THAN SENDS while the list is open; ⌘↵ stays the send chord and is never
 * touched here (see the keymap registry, `inInput: true`).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { matchAddresses, type AddressBookEntry } from "@ohmail/client-engine";
import { parseRecipients } from "./compose";
import { displayAddress } from "./idn";

/** How many suggestions are offered. Six fills a popover without needing to scroll it. */
const MAX_SUGGESTIONS = 6;

/**
 * How many characters of an address the popover shows before it is truncated.
 *
 * Tuned to the popover's NARROWEST width — it is pinned to the field's own edges, so on a 390px
 * compose form there is room for roughly this many at 11.5px. The point of a character budget
 * rather than leaning on the browser is that the browser's only truncation is `text-overflow:
 * ellipsis`, which cuts the END — and the end of an address is the domain, the one part that most
 * often tells two recipients apart. So the domain is protected in CSS and the LOCAL part is
 * middle-truncated here.
 */
export const ADDRESS_MAX = 34;

/** Keep the head and tail of `s`, an ellipsis in the MIDDLE, to `keep` visible characters. */
function middle(s: string, keep: number): string {
  if (s.length <= keep) return s;
  if (keep <= 1) return "…";
  const head = Math.ceil((keep - 1) / 2);
  const tail = keep - 1 - head;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ""}`;
}

/**
 * WHETHER THE CC/BCC ROWS SHOW — one derivation for every composer instance (fresh compose,
 * mailto-seeded compose, reply, reply-all, the inline forward). Editing To is the main act,
 * so the two rows wait behind the "Kopie/Blindkopie" toggle while BOTH are empty — and they
 * open THEMSELVES the moment either carries text, because a prefilled reply-all Cc hidden
 * behind a toggle is recipients the user cannot see they have. `revealed` is the instance's
 * own toggle press; the values outrank it in one direction only (they can force the rows
 * open, never closed).
 */
export function ccBccOpen(cc: string, bcc: string, revealed: boolean): boolean {
  return revealed || cc.trim() !== "" || bcc.trim() !== "";
}

/**
 * One address, shortened for the list but with its DOMAIN kept whole.
 *
 * "verylong…name@company.com": the local part loses its middle, the domain stays. A recipient in
 * a mail client is chosen by both halves — `john@work.example` and `john@home.example` are two
 * different people — so the browser's end-ellipsis, which would show `john@work.exa…` and
 * `john@home.exa…`, is exactly the wrong cut. The middle of the local part is the least
 * load-bearing thing to drop.
 */
export function truncateAddress(address: string, max = ADDRESS_MAX): string {
  if (address.length <= max) return address;
  const at = address.lastIndexOf("@");
  if (at <= 0) return middle(address, max);
  const domain = address.slice(at); // includes the "@"
  const local = address.slice(0, at);
  // The domain is never dropped. Whatever is left of the budget goes to the local part; if the
  // domain alone is already at the budget, the local collapses to a bare marker but is still there.
  const room = max - domain.length - 1; // 1 for the "…"
  if (room < 1) return `…${domain}`;
  return `${middle(local, room)}${domain}`;
}

/**
 * Labels for the whole shown list, middle-truncated AND guaranteed distinct.
 *
 * Truncating two different addresses to the same visible text in a mail client is a
 * wrong-recipient risk, not a cosmetic one — the reader picks the wrong row and the mail goes to
 * the wrong person. So any address whose short form collides with another in the SAME list is
 * shown in full instead. The inputs are distinct addresses, so the full-text fallback always
 * resolves; it only ever fires for the pathological case of two addresses that share a domain, a
 * local head and a local tail and differ only in a dropped middle.
 */
export function addressLabels(addresses: readonly string[], max = ADDRESS_MAX): string[] {
  const labels = addresses.map((a) => truncateAddress(a, max));
  for (;;) {
    const byLabel = new Map<string, number[]>();
    labels.forEach((label, i) => {
      const group = byLabel.get(label);
      if (group) group.push(i);
      else byLabel.set(label, [i]);
    });
    let progressed = false;
    for (const group of byLabel.values()) {
      if (group.length < 2) continue;
      for (const i of group) {
        if (labels[i] !== addresses[i]) {
          labels[i] = addresses[i]!;
          progressed = true;
        }
      }
    }
    // Either nothing collided, or every colliding entry is already shown in full — in which case
    // the inputs themselves were equal and no truncation is to blame.
    if (!progressed) return labels;
  }
}

/** Split a display label at its last "@" into the local part and the domain (with the "@"). */
function splitLabel(label: string): { local: string; domain: string } {
  const at = label.lastIndexOf("@");
  if (at < 0) return { local: label, domain: "" };
  return { local: label.slice(0, at), domain: label.slice(at) };
}

/* ── the string ⇄ chips bijection ─────────────────────────────────────────────────────── */

/** The three rows a recipient can stand on, in their fixed visual order. */
export type RecipientRow = "to" | "cc" | "bcc";
export const RECIPIENT_ROWS: readonly RecipientRow[] = ["to", "cc", "bcc"];

/** The drag payload's MIME type — ours, so a stray text drop cannot masquerade as a chip. */
export const RECIPIENT_DRAG_TYPE = "application/x-ohmail-recipient";

/** One chip changing rows or places. `before` is the target-row chip index to insert in front
 *  of, or `null` to append. The ENTRY travels verbatim — wire text, never a display form. */
export interface RecipientMove {
  entry: string;
  from: RecipientRow;
  to: RecipientRow;
  before: number | null;
}

/**
 * `value` → the settled chips and the tail still being typed.
 *
 * Split on the same separators `parseRecipients` splits on. Every segment BEFORE the last
 * separator is settled; the final segment is the input's content. A value ending in a
 * separator therefore has an empty tail — which is exactly the state committing leaves behind.
 */
export function splitRecipients(value: string): { chips: string[]; tail: string } {
  const parts = value.split(/[,;]/);
  const tail = (parts.pop() ?? "").replace(/^\s+/, "");
  return { chips: parts.map((p) => p.trim()).filter((p) => p !== ""), tail };
}

/**
 * The inverse: chips and tail → the one wire string.
 *
 * With chips and an empty tail the string ends in `", "` — the trailing separator is what
 * keeps the last chip a CHIP through the next {@link splitRecipients}; without it the final
 * entry would fall back into the input. `parseRecipients` ignores the empty segment.
 */
export function joinRecipients(chips: readonly string[], tail: string): string {
  const head = chips.join(", ");
  if (head === "") return tail;
  return tail === "" ? `${head}, ` : `${head}, ${tail}`;
}

/**
 * Apply one {@link RecipientMove} to the three rows — ONE new state, or `null` when the entry
 * is no longer where the move believed it was (a drag over a value that changed mid-flight).
 *
 * Pure, and the only writer of a cross-row move: the caller spreads the result into its own
 * state in a single update, which is what makes drag To→Cc safe while the same object also
 * holds the row being dragged FROM. The tails are untouched — a move never commits or edits
 * what somebody is still typing.
 */
export function moveRecipient(
  rows: { to: string; cc: string; bcc: string },
  move: RecipientMove,
): { to: string; cc: string; bcc: string } | null {
  const src = splitRecipients(rows[move.from]);
  const at = src.chips.indexOf(move.entry);
  if (at < 0) return null;
  const srcChips = [...src.chips];
  srcChips.splice(at, 1);
  if (move.from === move.to) {
    // The index the caller named was measured BEFORE the removal; everything past the removed
    // chip has shifted one left.
    let to = move.before ?? srcChips.length;
    if (move.before !== null && move.before > at) to = move.before - 1;
    srcChips.splice(to, 0, move.entry);
    return { ...rows, [move.from]: joinRecipients(srcChips, src.tail) };
  }
  const dst = splitRecipients(rows[move.to]);
  const dstChips = [...dst.chips];
  dstChips.splice(move.before ?? dstChips.length, 0, move.entry);
  return {
    ...rows,
    [move.from]: joinRecipients(srcChips, src.tail),
    [move.to]: joinRecipients(dstChips, dst.tail),
  };
}

/**
 * After a cross-row move, put focus on the chip that moved — otherwise the keyboard path
 * strands focus on a row the chip just left. A DOM lookup on the next frame rather than a
 * ref handshake between two component instances: the target row re-renders with the entry
 * before the frame fires, and `data-entry` carries the verbatim wire text to find it by.
 */
export function focusMovedChip(inputId: string, entry: string): void {
  requestAnimationFrame(() => {
    const box = document.getElementById(inputId)?.closest(".rcp-box");
    if (!box) return;
    const chip = [...box.querySelectorAll<HTMLElement>(".rcp-chip")].find(
      (c) => c.dataset.entry === entry,
    );
    chip?.focus();
  });
}

/**
 * The invalid entries a field should SHOW, withholding the one still being typed.
 *
 * An entry is "still being typed" when the field has focus and the value does not already end
 * in a separator — a trailing comma means the user committed it and moved on, so its error is
 * shown. It is a DISPLAY gate only: `composePlan` (and the reply's envelope plan) empty the
 * mutation on any invalid entry regardless, so nothing here can loosen the send guard.
 * It lives here because every surface with a recipient row needs it; `ComposeView` keeps its
 * own literal copy for the To field, where the bug was reported.
 */
export function gatedInvalid(raw: string, focused: boolean, invalid: string[]): string[] {
  const stillTyping = focused && !/[,;]\s*$/.test(raw) ? (raw.split(/[,;]/).pop() ?? "").trim() : null;
  return stillTyping === null || stillTyping === ""
    ? invalid
    : invalid.filter((entry) => entry !== stillTyping);
}

/** One parsed chip: what it shows, and whether it is an address at all. */
function chipFace(entry: string): { name: string | null; shown: string; valid: boolean } {
  const one = parseRecipients(entry);
  const a = one.addresses[0];
  if (one.invalid.length > 0 || !a) return { name: null, shown: entry, valid: false };
  // The DISPLAY decode — the entry underneath keeps the wire form (see the header).
  return { name: a.name, shown: displayAddress(a.address), valid: true };
}

export function RecipientField({
  id,
  value,
  onChange,
  book,
  disabled,
  placeholder,
  invalid,
  describedBy,
  onFocusChange,
  row,
  onMove,
  onDragActive,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** `addressBook(reader)` — already ranked. Empty on a cold mirror, which closes the list. */
  book: readonly AddressBookEntry[];
  disabled?: boolean;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  /**
   * Focus, reported up, so the form can hold back the "not an address" line for the entry
   * being TYPED. See `ComposeView` — a half-typed name is not a wrong one.
   */
  onFocusChange?: (focused: boolean) => void;
  /** Which row this is, for drag payloads and Alt-arrow moves. Absent ⇒ a lone field. */
  row?: RecipientRow;
  /**
   * A chip changing rows or places — the OWNER of all three strings applies it as one state
   * change (`moveRecipient`). Absent ⇒ chips are not draggable and Alt-arrows do nothing,
   * which is the honest degradation for a field mounted without siblings.
   */
  onMove?: (move: RecipientMove) => void;
  /** A chip drag started/ended somewhere in this field — the form opens hidden rows on it. */
  onDragActive?: (active: boolean) => void;
}) {
  const t = useTranslations("compose");
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef<(HTMLElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  /** Which chip focus is on, for `aria-selected`. Focus itself lives in the DOM. */
  const [chipAt, setChipAt] = useState<number | null>(null);
  /** A foreign chip is over this field — the drop cue. */
  const [hover, setHover] = useState(false);

  const { chips, tail } = useMemo(() => splitRecipients(value), [value]);
  const draggable = !disabled && onMove !== undefined && row !== undefined;

  const suggestions = useMemo(
    () => (disabled ? [] : matchAddresses(book, tail.trim(), MAX_SUGGESTIONS)),
    [book, tail, disabled],
  );

  // A list with nothing in it is not a list. This also closes it as the query stops matching,
  // without a second piece of state to keep in step.
  const live = open && suggestions.length > 0;

  // The shortened address for each row, computed over the whole shown set so no two collapse to
  // the same visible text. Keyed positionally to the suggestions, so the map below reads it by index.
  const labels = useMemo(
    () => addressLabels(suggestions.map((s) => s.address)),
    [suggestions],
  );

  useEffect(() => {
    if (cursor >= suggestions.length) setCursor(0);
  }, [suggestions.length, cursor]);

  /** Accepting writes a chip directly — the tail it completes is spent. */
  const accept = useCallback(
    (entry: AddressBookEntry) => {
      onChange(joinRecipients([...chips, formatFor(entry)], ""));
      setOpen(false);
      setCursor(0);
      inputRef.current?.focus();
    },
    [chips, onChange],
  );

  /** The tail becomes a chip. A blank tail is nothing to commit, not an error. */
  const commitTail = useCallback((): void => {
    const entry = tail.trim();
    if (entry === "") return;
    onChange(joinRecipients([...chips, entry], ""));
  }, [chips, tail, onChange]);

  const removeChip = useCallback(
    (at: number): void => {
      const next = [...chips];
      next.splice(at, 1);
      onChange(joinRecipients(next, tail));
      // Focus the chip that slid into the removed one's place, else fall back to the input —
      // deleting the last chip must not drop focus on the body.
      requestAnimationFrame(() => {
        const target = chipRefs.current[Math.min(at, next.length - 1)];
        if (next.length > 0 && target) target.focus();
        else inputRef.current?.focus();
      });
    },
    [chips, tail, onChange],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!live) { setOpen(true); setCursor(0); return; }
      setCursor((c) => (c + 1) % suggestions.length);
      return;
    }
    if (e.key === "ArrowUp") {
      if (!live) return;
      e.preventDefault();
      setCursor((c) => (c - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === "Enter" || (live && e.key === "Tab")) {
      // ⌘↵ is Send and belongs to the keymap registry, not to this field.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return;
      if (live) {
        const entry = suggestions[cursor];
        if (!entry) return;
        // Tab is prevented too: accepting is what the key means here, and letting focus leave
        // as well would move the user off a field they are in the middle of filling.
        e.preventDefault();
        accept(entry);
        return;
      }
      // No list: ↵ commits what was typed as a chip, exactly like the comma.
      if (tail.trim() !== "") {
        e.preventDefault();
        commitTail();
      }
      return;
    }
    if (e.key === "Escape" && live) {
      // Stopped, so the shell's Escape ladder does not also close the compose view. The
      // innermost open thing is this list.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === ",") {
      // Comma continues: the browser inserts the separator, the derivation turns the tail into
      // a chip. This only gets the list out of the way.
      setOpen(false);
      return;
    }
    if (e.key === "Backspace" && chips.length > 0) {
      const el = e.currentTarget;
      if (el.value === "") {
        // Backspace on an empty input removes the last chip — the reported gesture.
        e.preventDefault();
        removeChip(chips.length - 1);
      }
      return;
    }
    if (e.key === "ArrowLeft" && chips.length > 0) {
      const el = e.currentTarget;
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault();
        chipRefs.current[chips.length - 1]?.focus();
      }
    }
  };

  const onChipKeyDown = (e: React.KeyboardEvent<HTMLElement>, at: number): void => {
    const entry = chips[at];
    if (entry === undefined || disabled) return;
    // A chip is a BUTTON, so the registry's typing guard does not shield it: the zone walk
    // (`zone-nav.tsx`) also binds the arrows on `document`, and inside the reply editor the
    // chips sit in the reading column. Every arrow this handler CLAIMS therefore stops here,
    // or one press would both move the chip focus and walk/scroll the zone under it.
    // `stopImmediatePropagation` on the NATIVE event: React and the registry are sibling
    // listeners on `document` in the deployed App Router, and `stopPropagation` alone cannot
    // stop a sibling (MoreMenu measured this on the deployed build).
    const claim = (): void => {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
    };
    if (e.altKey && row && onMove) {
      // Alt+arrows are the keyboard drag. Horizontal reorders within the row; vertical
      // re-rows in the fixed To→Cc→Bcc order. `focusMovedChip` is the caller's half.
      if (e.key === "ArrowLeft" && at > 0) {
        claim();
        onMove({ entry, from: row, to: row, before: at - 1 });
        return;
      }
      if (e.key === "ArrowRight" && at < chips.length - 1) {
        claim();
        onMove({ entry, from: row, to: row, before: at + 2 });
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const step = e.key === "ArrowUp" ? -1 : 1;
        const target = RECIPIENT_ROWS[RECIPIENT_ROWS.indexOf(row) + step];
        if (target) {
          claim();
          onMove({ entry, from: row, to: target, before: null });
        }
        return;
      }
      return;
    }
    if (e.key === "ArrowLeft" && at > 0) {
      claim();
      chipRefs.current[at - 1]?.focus();
      return;
    }
    if (e.key === "ArrowRight") {
      claim();
      if (at < chips.length - 1) chipRefs.current[at + 1]?.focus();
      else inputRef.current?.focus();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      removeChip(at);
    }
  };

  /** Does this drag carry one of our chips? Read from `types` — the data is drop-time only. */
  const carriesChip = (e: React.DragEvent): boolean =>
    draggable && Array.from(e.dataTransfer?.types ?? []).includes(RECIPIENT_DRAG_TYPE);

  const dropAt = (e: React.DragEvent, before: number | null): void => {
    if (!carriesChip(e) || !row || !onMove) return;
    e.preventDefault();
    e.stopPropagation();
    setHover(false);
    let payload: { entry?: unknown; row?: unknown } | null = null;
    try {
      payload = JSON.parse(e.dataTransfer.getData(RECIPIENT_DRAG_TYPE)) as {
        entry?: unknown;
        row?: unknown;
      } | null;
    } catch {
      /* not ours after all — a malformed payload moves nothing */
    }
    if (!payload || typeof payload.entry !== "string") return;
    const from = payload.row;
    if (from !== "to" && from !== "cc" && from !== "bcc") return;
    onMove({ entry: payload.entry, from, to: row, before });
  };

  return (
    <div className="rcp">
      <div
        className={hover ? "rcp-box drop" : "rcp-box"}
        onDragOver={(e) => {
          if (!carriesChip(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => dropAt(e, null)}
        // A click on the box's empty run of pixels belongs to the input, like any text field.
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {chips.length > 0 ? (
          // `display: contents`, so the chips and the input share one wrapping flex line while
          // the listbox still exists for the accessibility tree.
          <span className="rcp-chips" role="listbox" aria-orientation="horizontal" aria-label={t("chipListAria")}>
            {chips.map((entry, i) => {
              const face = chipFace(entry);
              return (
                <span
                  // Index in the key: the same address pasted twice is two chips until send-time
                  // dedup, and both must render.
                  key={`${i}:${entry}`}
                  ref={(el) => { chipRefs.current[i] = el; }}
                  role="option"
                  aria-selected={chipAt === i}
                  aria-label={t("chipAria", { recipient: face.name ?? face.shown })}
                  tabIndex={-1}
                  className={face.valid ? "rcp-chip" : "rcp-chip bad"}
                  title={entry}
                  data-entry={entry}
                  draggable={draggable}
                  onFocus={() => setChipAt(i)}
                  onBlur={() => setChipAt((cur) => (cur === i ? null : cur))}
                  onKeyDown={(e) => onChipKeyDown(e, i)}
                  onDragStart={(e) => {
                    if (!draggable || !row) { e.preventDefault(); return; }
                    e.dataTransfer.setData(RECIPIENT_DRAG_TYPE, JSON.stringify({ entry, row }));
                    e.dataTransfer.setData("text/plain", entry);
                    e.dataTransfer.effectAllowed = "move";
                    onDragActive?.(true);
                  }}
                  onDragEnd={() => onDragActive?.(false)}
                  onDragOver={(e) => {
                    if (!carriesChip(e)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }}
                  // Dropping ON a chip inserts before it — that is what "drag them around" means
                  // within one row.
                  onDrop={(e) => dropAt(e, i)}
                >
                  {face.name ? <b>{face.name}</b> : null}
                  <span className="rcp-chip-addr">{face.shown}</span>
                  {!disabled ? (
                    // A mouse affordance only — not a nested focusable inside the option. The
                    // keyboard path is Backspace/Delete on the chip itself.
                    <span
                      className="rcp-chip-x"
                      aria-hidden="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeChip(i);
                      }}
                    >
                      ×
                    </span>
                  ) : null}
                </span>
              );
            })}
          </span>
        ) : null}
        <input
          ref={inputRef}
          id={id}
          className="c-input rcp-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={chips.length === 0 ? placeholder : undefined}
          value={tail}
          readOnly={disabled}
          role="combobox"
          aria-expanded={live}
          aria-controls={live ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={live ? `${listId}-${cursor}` : undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            setOpen(true);
            onChange(joinRecipients(chips, e.target.value));
          }}
          onPaste={(e) => {
            const text = e.clipboardData?.getData("text/plain") ?? "";
            if (!/[,;\n\t]/.test(text)) return; // one address pastes like any text
            // A LIST pastes as chips. Newlines and tabs separate too — a column copied out of a
            // spreadsheet has no commas in it.
            e.preventDefault();
            const el = e.currentTarget;
            const start = el.selectionStart ?? tail.length;
            const end = el.selectionEnd ?? start;
            const merged = tail.slice(0, start) + text + tail.slice(end);
            const parts = merged.split(/[,;\n\t]/).map((p) => p.trim()).filter((p) => p !== "");
            const last = parts[parts.length - 1] ?? "";
            const lastComplete = last !== "" && parseRecipients(last).invalid.length === 0;
            // Every complete entry becomes a chip. Only a trailing fragment that does not yet
            // parse stays in the input — it is still being typed, exactly like a typed tail.
            onChange(
              lastComplete
                ? joinRecipients([...chips, ...parts], "")
                : joinRecipients([...chips, ...parts.slice(0, -1)], last),
            );
          }}
          onKeyDown={onInputKeyDown}
          onFocus={() => onFocusChange?.(true)}
          // Leaving the field commits what was typed — the entry is finished by the leaving.
          // Immediate, not deferred: a click on a suggestion prevents the blur outright
          // (`onMouseDown` below), so there is nothing to wait for.
          onBlur={() => {
            commitTail();
            // The popover close and the focus report stay deferred so a click that lands
            // INSIDE the field (a chip, the ×) settles first.
            setTimeout(() => { setOpen(false); onFocusChange?.(false); }, 120);
          }}
        />
      </div>
      {live ? (
        <ul className="rcp-list" role="listbox" id={listId} aria-label={t("toSuggestions")}>
          {suggestions.map((entry, i) => (
            <li
              key={entry.address}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === cursor}
              className={i === cursor ? "rcp-opt sel" : "rcp-opt"}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => { e.preventDefault(); accept(entry); }}
            >
              {/* Name AND address, always both when a name is known: two people called Lena
                  are told apart only by the address, and an address alone is unreadable. The
                  address is middle-truncated with its domain kept whole (`title` reveals the
                  full string on hover), and the domain rides in its own span so CSS can refuse
                  to shrink it — the local part gives up space first. */}
              {entry.name ? <b>{entry.name}</b> : null}
              {(() => {
                const { local, domain } = splitLabel(labels[i] ?? entry.address);
                return (
                  <span className="rcp-addr" title={entry.address}>
                    <span className="rcp-local">{local}</span>
                    {domain ? <span className="rcp-domain">{domain}</span> : null}
                  </span>
                );
              })()}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** What accepting a suggestion writes. `parseRecipients` reads both forms. */
function formatFor(entry: AddressBookEntry): string {
  return entry.name === "" ? entry.address : `${entry.name} <${entry.address}>`;
}
