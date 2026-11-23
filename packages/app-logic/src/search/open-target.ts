import type { EngineMessage, Folder, OhmailView } from "@ohmail/wire";
import { VIEW_OF_FOLDER } from "@ohmail/client-engine";
import type { KeySegment as ScreenerSegmentId } from "../screener/keys.js";

/**
 * WHERE A MESSAGE OPENS — the decision, with nothing else in it.
 *
 * Extracted from `openMessage` because the decision and the navigation are two things and
 * only one of them is checkable without a browser. Every arm below answers a reported
 * defect, and each is now an assertion rather than a paragraph.
 */
export type OpenTarget =
  | { kind: "ohbox"; id: string; reader: boolean }
  | { kind: "stream"; view: "reads" | "receipts"; id: string }
  // `row` is NON-NULL by construction: a Screener surface can only show a message THROUGH its
  // sender row, so when no row is held the target is the reader instead — never a rowless
  // screener arm. The type is the invariant `openTargetFor` keeps: it never names a surface
  // that cannot show the message. `letter`: the hit, opened in the reader over the card, when it is
  // not the card's own newest letter (a derived row's id); null when the card shows it.
  | { kind: "screener"; segment: ScreenerSegmentId; row: string; letter: string | null }
  /** One of the mailbox's own folders — navigate to its view, message tail on the URL. */
  | { kind: "folder"; folderId: string; id: string }
  | { kind: "reader"; id: string };

/**
 * Where a hit opens. Presentation before physical folder: the consent cutline SHOWS a message somewhere other
 * than its folder (`placeOf`, total over the mirror), so routing by `m.folder` navigated to a pile the row was
 * never in; `undefined` = no partition considered it (demo, desktop, folder outside the presented set) and only
 * then is the folder honest; `null` = History, pile-less, opened in the reader. `parked` mail is pile-less the
 * same way (no Ohbox group lists it) and opens in the reader too. `rowFor` = the Screener row that speaks for
 * the sender, else the reader. `holds` asks whether the pile's own list actually holds the id — an archive
 * search hit can name a message no local row exists for — and a message no pile holds opens in the reader, in
 * place. Search must open what it found.
 */
export function openTargetFor(
  m: EngineMessage,
  narrow: boolean,
  rowFor: (m: EngineMessage, segment: ScreenerSegmentId) => string | null,
  placeOf?: ReadonlyMap<string, Folder | null>,
  parked?: ReadonlySet<string>,
  holds?: (view: "ohbox" | "reads" | "receipts", id: string) => boolean,
  /**
   * The `folder` entity id whose VIEW can show this message, or null — the folders
   * foundation's lookup (FOLDERS-SPEC.md). Mailbox-scoped like every folder-shaped surface
   * (two mailboxes may both have a `Projects`, and a hit must open its OWN), and the callback
   * owns the HOLDS question too: an archive-only search hit can name a folder whose entity
   * exists while the message is outside this device's mirror, and naming the folder view for
   * a row its list cannot render is the exact promise this function's type forbids. Null ⇒
   * the reader fallback, which carries the off-mirror row with it. Optional; absent (demo,
   * folders off, callers written before the feature) keeps the reader fallback.
   */
  folderTargetFor?: (m: EngineMessage, folder: Folder) => string | null,
): OpenTarget {
  const presented = placeOf?.get(m.id);
  // `null` ⟺ History (dormant, undecided) — pile-less, so the reader is where it opens.
  if (presented === null) return { kind: "reader", id: m.id };
  // The presented folder when the cutline placed it, the physical one when it did not.
  const folder: Folder = presented ?? m.folder;
  const view: OhmailView | undefined = VIEW_OF_FOLDER[folder];
  if (view === "ohbox") {
    // PARKED ⇒ in no Ohbox group, so the Ohbox cannot show it. Checked HERE and not at the top of
    // the function on purpose: `ohboxView` is the only surface that holds parked rows out, so a
    // Reads issue queued for Answer Later is still a locatable row in Reads and must keep routing
    // there. Diverting only where the surface genuinely cannot show the message is the whole of
    // what this function's return type promises.
    //
    // Kept as its own arm although `holds` below subsumes it: the parked rule is a statement about
    // the triage model that is true whether or not a caller passes a pile predicate, and a caller
    // that passes neither still gets it right.
    if (parked?.has(m.id)) return { kind: "reader", id: m.id };
    return holds && !holds("ohbox", m.id)
      ? { kind: "reader", id: m.id }
      : { kind: "ohbox", id: m.id, reader: narrow };
  }
  if (view === "reads" || view === "receipts") {
    return holds && !holds(view, m.id) ? { kind: "reader", id: m.id } : { kind: "stream", view, id: m.id };
  }
  if (view === "screener" || view === "screened" || view === "spam") {
    const segment: ScreenerSegmentId =
      view === "screener" ? "waiting" : view === "screened" ? "screened" : "spam";
    const row = rowFor(m, segment);
    // A Screener surface can only show a message THROUGH its sender row. When this client holds
    // no row for the sender — an archive-only hit, or a sender the queue does not mint one for —
    // naming the segment would drop the user at a list the message is not in and flash nothing.
    // So fall to the reader, in place: the same answer History gives a pile-less hit, and the
    // invariant that `openTargetFor` never names a surface that cannot show the message.
    return row
      ? { kind: "screener", segment, row, letter: row === m.id ? null : m.id }
      : { kind: "reader", id: m.id };
  }
  // ONE OF THE USER'S OWN FOLDERS — reachable since the folders foundation: a message whose
  // presented place is not one of the six may live in a folder the account browses as a view.
  // Route it there (the view lists it, the URL's message tail opens it) rather than stranding
  // the hit in Search's reader — the same "never name a surface that cannot show the message"
  // rule, pointed at the surface that CAN.
  const folderId = folderTargetFor?.(m, folder);
  if (folderId) return { kind: "folder", folderId, id: m.id };
  // A folder no view owns — the folders feature off, an unknown path. The reader, in place.
  return { kind: "reader", id: m.id };
}

/**
 * What the reader shows — the mirror's own row, else the row the opener carried in. `GET
 * /search` answers over the whole archive while the mirror is a window over it, so a hit can
 * name a message with no local row: the mirror answered `undefined`, the reader's `open` prop
 * was false, and the sheet never came up ("clicking it does not open it"). The fallback is
 * keyed on the id, renders exactly what the archive returned (a body cannot be fetched for a
 * rowless message, so `snippet` says so). The mirror wins whenever it has the row — it carries
 * the overlay and this device's own triage and flag state.
 */
/**
 * THREE ANSWERS, AND THE THIRD IS THE ONE THIS SURFACE WAS MISSING. `null` used to mean both
 * "nothing is open" and "the message being read has been taken away", which is why a message
 * another mail client moved out of every watched folder left a blank pane and no word said.
 * `"gone"` is that second state named; see the mirror's tombstone check for why it is asked
 * of the TOMBSTONE and never of mere absence.
 */
export type ReaderAnswer = EngineMessage | "gone" | null;

export function readerMessageFor(
  readerFor: string | null,
  fromMirror: (id: string) => EngineMessage | undefined,
  offMirror: EngineMessage | null,
  isGone: (id: string) => boolean,
): ReaderAnswer {
  if (!readerFor) return null;
  const mine = fromMirror(readerFor);
  if (mine) return mine;
  // Before the carried row: a store page's row the mirror records as taken away is gone, not read.
  if (isGone(readerFor)) return "gone";
  if (offMirror?.id === readerFor) return offMirror;
  return null;
}
