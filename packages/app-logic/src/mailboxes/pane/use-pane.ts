"use client";

/**
 * THE MAILBOXES PANE'S MODEL: the list, the one slot of gated presses, the take-over check, the plain presses, the
 * removal's confirmation and what a provider's sign-in came back with, over the shell's wires and an input record.
 * After every write the server answered, the pane re-reads its list and tells the mail state and the sync.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { filerKey } from "../../mail-state/mail-state.js";
import { displayAddress } from "../../text/idn.js";
import type { GatedRefusal, GatedState } from "../connect/gate.js";
import { saidOfReturn } from "../connect/refusal.js";
import type { MailboxId, SignInReturn } from "../connect/types.js";
import { NONE, type None, type PaneCalls } from "./calls.js";
import { useLines, type Lines, type PaneLine } from "./lines.js";
import { useOrganizerPeek, type Peek } from "./organizer.js";
import { useActs, type Acts } from "./use-acts.js";
import { useGated, type Gated, type GatedAct, type GatedWord } from "./use-gated.js";
import { useMailboxes, type MailboxesList } from "./use-mailboxes.js";
import { useLatestWins } from "./rows.js";
import type { MailboxErased, MailboxRow, OrganizeAnswer } from "./types.js";

/** What changes while the pane stands: read it now, and be told when to read again. */
export interface Watched<T> {
  read(): T;
  subscribe(changed: () => void): () => void;
}

/** The mail state's re-read and the engine's sync, which the pane tells after a write. */
export interface PaneGround {
  /** The mail state's read of the mailbox facts, now. */
  refresh(): void;
  /** The engine's own sync. */
  sync(): void;
}

export interface PaneInput {
  readonly wire: PaneCalls;
  /** A second factor's dialog can be asked here. */
  readonly factor: boolean;
  readonly hidden: () => boolean;
  readonly ground: PaneGround;
  /** What a provider's sign-in started earlier came back with; `none` where this shell runs none. */
  readonly returned: Watched<SignInReturn | null> | None;
  readonly filer: "cloud" | "server";
}

export interface Removal {
  /** The mailbox a removal is about, captured at its press, with the choice and what was typed. */
  readonly removing: {
    readonly id: MailboxId;
    readonly address: string;
    readonly erase: boolean;
    readonly typed: string;
  } | null;
  open(row: MailboxRow): void;
  choose(erase: boolean): void;
  type(typed: string): void;
  close(): void;
  confirm(): void;
}

export interface PaneModel {
  /** The shell's wire, for a row's own readers (the check, the filings). */
  readonly wire: PaneCalls;
  /** The mail state's own re-read. */
  readonly refreshMailState: () => void;
  readonly list: MailboxesList;
  readonly lines: Lines;
  readonly gated: Gated;
  /** The last gated press's refusal, until the next press or the confirmation's close says it was read. */
  readonly refused: { readonly act: GatedAct; readonly refusal: GatedRefusal<GatedWord> } | null;
  readonly peek: Peek;
  readonly acts: Acts;
  readonly removal: Removal;
  /** A take-over this pane asked for: its press is spent until the row's own role moves. */
  readonly takingOver: ReadonlySet<string>;
  takeover(id: MailboxId): void;
  /** An erasure the worker still sweeps, and what it answered: said when its row leaves the list. */
  readonly erasing: { readonly receipt: MailboxErased; readonly address: string } | null;
  /** A sign-in's last call is on its way. */
  readonly finishing: boolean;
  /** The connect form in a row ended with a write the server took. */
  wrote(): void;
}

const NOTHING: Watched<null> = { read: () => null, subscribe: () => () => undefined };

function erasedLine(r: MailboxErased, address: string): PaneLine {
  const values = {
    address: displayAddress(address),
    messages: r.messages,
    drafts: r.drafts,
    unanchored: r.draftsUnanchored,
  };
  return { said: { key: r.draftsUnanchored > 0 ? "removeErasedUnanchored" : "removeErased", values } };
}

function takenLine(outcome: OrganizeAnswer["outcome"], filer: "cloud" | "server"): PaneLine {
  const key =
    outcome === "authorized"
      ? filerKey("takeoverQueued", filer)
      : outcome === "already_organizing"
        ? filerKey("takeoverAlready", filer)
        : "organizerDisconnected";
  return { said: { key } };
}

function useRemoval(gated: Gated, lines: Lines): Removal {
  const [removing, setRemoving] = useState<Removal["removing"]>(null);
  return {
    removing,
    open: (row) => {
      lines.clear();
      gated.drop();
      setRemoving({ id: row.id, address: row.address, erase: false, typed: "" });
    },
    choose: (erase) => {
      gated.drop();
      lines.clear();
      setRemoving((r) => (r === null ? r : { ...r, erase }));
    },
    type: (typed) => {
      gated.drop();
      lines.clear();
      setRemoving((r) => (r === null ? r : { ...r, typed }));
    },
    close: () => {
      gated.drop();
      lines.clear();
      setRemoving(null);
    },
    confirm: () => {
      if (removing === null) return;
      const { id, address, erase, typed } = removing;
      lines.clear();
      gated.tryAct(erase ? { verb: "erase", id, address, typed } : { verb: "remove", id, address });
    },
  };
}

/** What a sign-in came back with, said here: a mailbox connected, or why nothing was. */
function useReturned(
  input: PaneInput,
  list: MailboxesList,
  lines: Lines,
  afterMailboxWrite: () => void,
): boolean {
  const watched = input.returned === NONE ? NOTHING : input.returned;
  const back = useSyncExternalStore(watched.subscribe, watched.read, watched.read);
  const said = useRef<SignInReturn | null>(null);
  useEffect(() => {
    if (back === null || said.current === back) return;
    said.current = back;
    if (back.kind === "running") return;
    if (back.kind === "connected") {
      const address = displayAddress(back.address ?? "");
      lines.tell({
        said: { key: back.created ? "oauthConnected" : "oauthReconnected", values: { address } },
      });
      void list.refresh();
      afterMailboxWrite();
      return;
    }
    const { said: why, calm } = saidOfReturn(back, "add");
    const line: PaneLine =
      "server" in why
        ? { server: why.server }
        : { said: { key: why.key, ...(why.values ? { values: why.values } : {}) } };
    if (calm) lines.tell(line);
    else lines.fail(line);
  }, [afterMailboxWrite, back, lines, list]);
  return back?.kind === "running";
}

export function usePane(input: PaneInput): PaneModel {
  const { wire, ground, filer } = input;
  const list = useMailboxes({ wire, hidden: input.hidden });
  const told = useLines();
  const gatedRef = useRef<Gated | null>(null);
  const [read, setRead] = useState<GatedState<GatedAct, GatedWord> | null>(null);
  // A new press, or the confirmation closed: what the last gated press was refused with has been read.
  const lines = useMemo<Lines>(
    () => ({
      ...told,
      clear: () => {
        told.clear();
        const state = gatedRef.current?.state;
        if (state?.at === "refused") setRead(state);
      },
    }),
    [told],
  );
  const afterMailboxWrite = useCallback(() => {
    ground.refresh();
    ground.sync();
  }, [ground]);
  const [erasing, setErasing] = useState<PaneModel["erasing"]>(null);
  const [spent, setSpent] = useState<ReadonlySet<string>>(() => new Set());
  const peekWins = useLatestWins(list.alive);
  const peek = useOrganizerPeek({ wire, wins: peekWins, onRefused: lines.refused });
  const removalRef = useRef<Removal | null>(null);

  const onTaken = useCallback(
    (act: GatedAct, value: unknown): void => {
      if (act.verb === "organize") {
        lines.tell(takenLine((value as OrganizeAnswer).outcome, filer));
        setSpent((s) => new Set(s).add(act.id));
        void list.afterWrite().then(() => list.alive.current && peek.close());
        return;
      }
      if (act.verb === "erase") {
        const receipt = value as MailboxErased;
        if (receipt.erasing) setErasing({ receipt, address: act.address });
        else lines.tell(erasedLine(receipt, act.address));
      }
      void list.afterWrite().then(() => {
        if (list.alive.current) removalRef.current?.close();
        afterMailboxWrite();
      });
    },
    [afterMailboxWrite, filer, lines, list, peek],
  );
  const gated = useGated({ wire, factor: input.factor, onTaken });
  gatedRef.current = gated;
  const removal = useRemoval(gated, lines);
  removalRef.current = removal;
  const acts = useActs({ wire, list, lines, refreshMailState: ground.refresh, fold: list.fold, filer });
  const finishing = useReturned(input, list, lines, afterMailboxWrite);

  // A factor that landed after Cancel ran nothing: said once as it happens, beside the rows.
  const nothingRan = gated.state.nothingRan;
  const { nothing } = lines;
  useEffect(() => {
    if (nothingRan) nothing();
  }, [nothing, nothingRan]);

  // The erasure finished when a read no longer lists its row; a read from before it is not absence.
  const rows = list.rows;
  useEffect(() => {
    if (erasing === null || rows === null) return;
    if (rows.some((m) => m.id === erasing.receipt.mailboxId)) return;
    lines.tell(erasedLine(erasing.receipt, erasing.address));
    setErasing(null);
  }, [erasing, lines, rows]);

  // A take-over refused or parked closes its check, as the shipped pane's did.
  const parkedTakeover =
    (gated.state.at === "asking" || gated.state.at === "refused") && gated.state.act.verb === "organize";
  const { close: closePeek } = peek;
  useEffect(() => {
    if (parkedTakeover) closePeek();
  }, [closePeek, parkedTakeover]);

  const trying =
    gated.state.at === "trying" && gated.state.act.verb === "organize" ? gated.state.act.id : null;
  const takingOver = trying === null || spent.has(trying) ? spent : new Set(spent).add(trying);
  const refused =
    gated.state.at === "refused" && gated.state !== read
      ? { act: gated.state.act, refusal: gated.state.refusal }
      : null;
  return {
    wire,
    refreshMailState: ground.refresh,
    list,
    lines,
    gated,
    refused,
    peek,
    acts,
    removal,
    takingOver,
    takeover: (id) => {
      lines.clear();
      gated.tryAct({ verb: "organize", id });
    },
    erasing,
    finishing,
    wrote: () => {
      void list.afterWrite().then(() => afterMailboxWrite());
    },
  };
}
