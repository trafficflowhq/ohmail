/**
 * A RECIPIENT LINE AS TEXT AND AS CHIPS: the one wire string of a To, Cc or Bcc row, the settled entries and the tail
 * still being typed, a move of one entry between rows, and which invalid entries a field shows. Pure: every surface
 * with a recipient row reads these (the old chip field, the new letter's lines), and none of them draws anything.
 */

/** The three rows a recipient can stand on, in their fixed visual order. */
export type RecipientRow = "to" | "cc" | "bcc";

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
