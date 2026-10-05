"use client";

/**
 * ONE SURFACE FOR WHAT A LIST VIEW'S EMPTY PANE AND READING COLUMN SAY — History, Drafts, a tag,
 * Triage, a folder and Trash. It decides by ID only: whether the list may say it is empty (the
 * engine's `listSurface`), which row the column shows, and that a picked row another mail client
 * took away is GONE, said, never swapped for the first row. The views keep their own rows, pages,
 * verbs, body hydration and meta; this renders only the empty pane and the column.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { listSurface, saysEmpty, type ListSurface } from "@ohmail/client-engine";
import { ReadColumn, Spinner } from "@ohmail/ui";
import { MessageGone } from "./MessagePane";
import { readColumnHidden } from "./narrow";
import { useStableCallback } from "./stable-callback";

/** What the shell knows about a row that left: a tombstone its own verbs did not cause, and where to follow it. */
export interface ListGoneFacts {
  isGone: (id: string) => boolean;
  openTrash: (() => void) | null;
}

/** The shell's answer: a tombstone none of this tab's own verbs wrote. `acted` is read at each call. */
export function listGoneFacts(
  isTombstone: (id: string) => boolean,
  acted: ReadonlySet<string>,
  openTrash: (() => void) | null,
): ListGoneFacts {
  return { isGone: (id) => isTombstone(id) && !acted.has(id), openTrash };
}

/** The shell's half, mounted once: a tombstone this tab's own verbs (`acted`) did not write, and the Trash door. */
export function useListGoneFacts(
  engine: { messageIsGone(id: string): boolean },
  acted: { readonly current: ReadonlySet<string> },
  openTrash: (() => void) | null,
): ListGoneFacts {
  const door = openTrash !== null;
  const trash = useStableCallback(() => openTrash?.());
  return useMemo(() => listGoneFacts((id) => engine.messageIsGone(id), acted.current, door ? trash : null), [engine, acted, door, trash]);
}

const ListGone = createContext<ListGoneFacts | null>(null);

/** Mounted once by the shell. No default: a view mounted without it would pick "not gone" in silence. */
export function ListGoneProvider({ value, children }: { value: ListGoneFacts; children: ReactNode }) {
  return <ListGone.Provider value={value}>{children}</ListGone.Provider>;
}

export type ListColumn<M> = { kind: "message"; message: M } | { kind: "gone" } | { kind: "rest" };

export interface ListViewInput<M extends { id: string }> {
  /** The rows the list shows, in its order. */
  rows: readonly M[];
  /** The list's own size where `rows` is only what is fetched (History's store slots). */
  count?: number;
  /** Has this list's source answered — the mirror's `settled`, or a server list's first page. */
  settled: boolean;
  /** Is an answer the emptiness depends on still owed (MailState `owed`, a page in flight). */
  pending?: boolean;
  /** The view's own pick, or null. */
  picked: string | null;
  /** The picked row where `rows` does not hold it — a store page's row, a fetched older one. */
  resolve?: (id: string) => M | null | undefined;
  /** The row shown with nothing picked; the first row when absent. */
  first?: M | null;
}

export interface ListView<M> {
  surface: ListSurface;
  /** Only `saysEmpty` may state that there is nothing here. */
  empty: boolean;
  column: ListColumn<M>;
  /** The row the column shows, or null — what the view's verbs and body hydration act on. */
  shown: M | null;
  /** The id the column stands for — the shown row's, or a gone pick's, which the address keeps naming. */
  standsFor: string | null;
  /** Is the reading column off screen at this width — the one place a list view asks it. */
  columnHidden: () => boolean;
}

export function useListView<M extends { id: string }>(o: ListViewInput<M>): ListView<M> {
  const facts = useContext(ListGone);
  if (facts === null) throw new Error("useListView: no ListGoneProvider above this view");
  const { rows, count, settled, pending, picked, resolve, first } = o;
  const surface = listSurface({ settled, count: count ?? rows.length, pending });
  const held = picked === null ? undefined : rows.find((m) => m.id === picked) ?? resolve?.(picked) ?? undefined;
  const column: ListColumn<M> = useMemo(() => {
    if (held) return { kind: "message", message: held };
    // GONE iff the pick is a tombstone; any other departure (filed out of the tag, outside the
    // window) keeps the first-row fallback, because that is not a message somebody lost.
    if (picked !== null && facts.isGone(picked)) return { kind: "gone" };
    const fallback = first === undefined ? rows[0] : first;
    return fallback ? { kind: "message", message: fallback } : { kind: "rest" };
  }, [held, picked, facts, first, rows]);
  return {
    surface,
    empty: saysEmpty(surface),
    column,
    shown: column.kind === "message" ? column.message : null,
    standsFor: column.kind === "message" ? column.message.id : column.kind === "gone" ? picked : null,
    columnHidden: readColumnHidden,
  };
}

/** The empty pane: the view's sentence only where the list may say it, one silhouette otherwise. */
export function ListEmpty({ list, glyph, title, hint, silhouette = true, children }: {
  list: Pick<ListView<unknown>, "empty">;
  glyph: string;
  title?: ReactNode;
  hint?: ReactNode;
  /** `false` where the list's tail row already says it is still asking (Folder, Trash). */
  silhouette?: boolean;
  /** A line the silhouette may speak (History's loading grace). */
  children?: ReactNode;
}) {
  if (list.empty) return <ListSentence glyph={glyph} title={title}>{hint}</ListSentence>;
  if (!silhouette) return null;
  return (
    <div className="empty" role="status" aria-busy="true">
      <span className="mbx-wait">
        <Spinner className="mbx-spin" />
        {children}
      </span>
    </div>
  );
}

/** A list's one sentence in the empty pane's shape — its emptiness, or a list with no source here (Trash unavailable). */
export function ListSentence({ glyph, title, status, children }: {
  glyph: string;
  title?: ReactNode;
  /** A sentence that replaced something being read (a failed read) is announced. */
  status?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="empty" {...(status ? { role: "status" } : {})}>
      <span className="glyph" aria-hidden="true">{glyph}</span>
      {title != null ? <b>{title}</b> : null}
      {children}
    </div>
  );
}

/** The reading column: the shown row, the gone notice, or nothing; `instead` is a view's own population (Trash's live rows). */
export function ListReadColumn<M>({ list, regionLabel, instead, onClose, closeLabel, children }: {
  list: Pick<ListView<M>, "column">;
  regionLabel: string;
  instead?: ReactNode;
  /** The column's own way out under a thumb in the two-pane band (`ReadColumn`); absent, no ✕. */
  onClose?: () => void;
  closeLabel?: string;
  children: (m: M) => ReactNode;
}) {
  const facts = useContext(ListGone);
  const c = list.column;
  return (
    <ReadColumn regionLabel={regionLabel} onClose={onClose} closeLabel={closeLabel}>
      {instead != null
        ? instead
        : c.kind === "message"
          ? children(c.message)
          : c.kind === "gone"
            ? <MessageGone openTrash={facts?.openTrash ?? null} />
            : null}
    </ReadColumn>
  );
}
