"use client";

/**
 * ═══ THE RECIPIENT FIELD, WITH THE ADDRESSES THE MAILBOX ALREADY KNOWS ═══════════════════
 *
 * Reported as: composing a message, the To field *"won't give me addresses from my actual
 * mailboxes I can fast-select on my typing"*. It was a bare `<input type="text">`, so every
 * recipient had to be typed in full and remembered exactly.
 *
 * The candidates come from `addressBook(reader)` — a pure selector over the local mirror, so
 * there is no request per keystroke, nothing is sent anywhere while the user types, and the
 * field works offline, in the demo and on the desktop shell without a special case.
 *
 * ── IT IS A COMBOBOX OVER A COMMA-SEPARATED STRING, WHICH IS THE HARD PART ──────────────
 *
 * The compose model's `to` is one string (`ComposeFields.to`) and `parseRecipients` splits it
 * on commas. That is the shape the send path, the draft buffer and the validation error all
 * already speak, and changing it to a token array would reach into every one of them for a
 * change the user cannot see. So this stays a text field and the suggestions act on the
 * LAST ENTRY only: everything before the final comma is settled and untouched, and what is
 * being typed after it is what gets matched and replaced. Accepting a suggestion rewrites that
 * segment and appends `", "`, so the next name can be typed immediately — which is what
 * "comma continues" means here.
 *
 * ── KEYBOARD FIRST ─────────────────────────────────────────────────────────────────────
 *
 *   ↑ / ↓      move through the list, and ↓ on a closed list opens it
 *   ↵ or Tab   accept the highlighted suggestion
 *   ,          accept nothing — commit what was typed and start the next entry
 *   Escape     dismiss the list, leaving the text alone
 *
 * ↵ ACCEPTS RATHER THAN SENDS while the list is open, and that is why the list must close on
 * Escape rather than on blur alone: the send chord is ⌘↵ and lives in the keymap registry with
 * `inInput: true`, so it is unaffected either way — but a bare ↵ that fell through to a form
 * submit while a suggestion was highlighted would send mail to whoever happened to be first.
 *
 * The listbox is `aria-activedescendant`-driven, so focus never leaves the input and the
 * browser's own editing keys keep working.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { matchAddresses, type AddressBookEntry } from "@ohmail/client-engine";

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

/**
 * The span of `value` the caret is editing — everything after the last comma before it.
 *
 * Exported for the tests, because this is the whole of the "act on the last entry" rule and it
 * is far easier to be wrong about than it looks: the caret can be in the middle of the string,
 * a trailing comma means a new empty entry has been started, and leading whitespace after a
 * comma is not part of what the user typed.
 */
export function activeSegment(value: string, caret: number): { start: number; end: number; text: string } {
  const upto = value.slice(0, caret);
  const comma = upto.lastIndexOf(",");
  let start = comma + 1;
  while (start < caret && /\s/.test(value[start] ?? "")) start += 1;
  // The segment ends at the next comma at or after the caret, or at the end of the string.
  const nextComma = value.indexOf(",", caret);
  const end = nextComma < 0 ? value.length : nextComma;
  return { start, end, text: value.slice(start, end) };
}

/** Replace the active segment with `replacement`, and leave the caret ready for the next one. */
export function acceptInto(
  value: string,
  caret: number,
  replacement: string,
): { next: string; caret: number } {
  const seg = activeSegment(value, caret);
  const head = value.slice(0, seg.start);
  const tail = value.slice(seg.end);
  // `", "` so the next name can be typed straight away. A tail that already begins with a
  // comma keeps its own separator rather than gaining a second one.
  const sep = tail.trimStart().startsWith(",") || tail.trim() === "" ? "" : ", ";
  const merged = `${head}${replacement}, ${tail.trimStart()}`;
  const next = sep === "" && tail.trim() !== "" ? `${head}${replacement}${tail}` : merged;
  return { next, caret: `${head}${replacement}, `.length };
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
}) {
  const t = useTranslations("compose");
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  /** Where the caret was at the last keystroke — the suggestions follow it, not the string. */
  const [caret, setCaret] = useState(0);

  const query = useMemo(() => activeSegment(value, caret).text, [value, caret]);
  const suggestions = useMemo(
    () => (disabled ? [] : matchAddresses(book, query, MAX_SUGGESTIONS)),
    [book, query, disabled],
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

  const accept = useCallback(
    (entry: AddressBookEntry) => {
      const el = inputRef.current;
      const at = el?.selectionStart ?? caret;
      const { next, caret: nextCaret } = acceptInto(value, at, formatFor(entry));
      onChange(next);
      setOpen(false);
      setCursor(0);
      // The caret has to be put back after React re-renders with the new value, or the
      // browser parks it at the end and the next name is typed in the wrong place.
      requestAnimationFrame(() => {
        const node = inputRef.current;
        if (!node) return;
        node.setSelectionRange(nextCaret, nextCaret);
        setCaret(nextCaret);
      });
    },
    [value, caret, onChange],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
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
    if (live && (e.key === "Enter" || e.key === "Tab")) {
      const entry = suggestions[cursor];
      if (!entry) return;
      // Tab is prevented too: accepting is what the key means here, and letting focus leave
      // as well would move the user off a field they are in the middle of filling.
      e.preventDefault();
      // ⌘↵ is Send and belongs to the keymap registry, not to this field.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return;
      accept(entry);
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
      // Comma continues: commit what was typed as its own entry and start the next one. The
      // browser inserts the character; this only gets the list out of the way.
      setOpen(false);
    }
  };

  const sync = (el: HTMLInputElement): void => setCaret(el.selectionStart ?? el.value.length);

  return (
    <div className="rcp">
      <input
        ref={inputRef}
        id={id}
        className="c-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        readOnly={disabled}
        role="combobox"
        aria-expanded={live}
        aria-controls={live ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={live ? `${listId}-${cursor}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          sync(e.currentTarget);
          setOpen(true);
          onChange(e.target.value);
        }}
        onKeyUp={(e) => sync(e.currentTarget)}
        onClick={(e) => sync(e.currentTarget)}
        onKeyDown={onKeyDown}
        onFocus={() => onFocusChange?.(true)}
        // A click elsewhere dismisses. Deferred, so a click ON a suggestion lands first.
        // The focus report is deferred with it: accepting a suggestion by mouse blurs the
        // input for an instant, and reporting that immediately would flash the validation
        // error for the entry that is in the middle of being completed.
        onBlur={() => setTimeout(() => { setOpen(false); onFocusChange?.(false); }, 120)}
      />
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
