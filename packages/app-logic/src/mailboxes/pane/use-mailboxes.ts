"use client";

/**
 * THE MAILBOXES PANE'S LIST, read through the shell's wire: counts once as the pane opens, a tick that keeps a young
 * mailbox's row true and never asks for counts, and the last rows kept over a refused read. A write answered is
 * shown only over a read issued after it ("record, then paint"): past a bound the rows are withheld and a sentence
 * stands in their place until such a read answers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Refusal } from "../connect/types.js";
import { NONE, type PaneCalls } from "./calls.js";
import { TICK_MS, WRITE_SETTLE_MS, useLatestWins, type LatestWins } from "./rows.js";
import type { ConnectAllowance, MailboxRow } from "./types.js";

export interface MailboxesInput {
  readonly wire: Pick<PaneCalls, "list" | "allowance">;
  /** Nobody is looking: the tick reads nothing (the clock still moves). */
  readonly hidden: () => boolean;
}

export interface MailboxesList {
  /** The account's rows; `null` until a read answered. */
  readonly rows: readonly MailboxRow[] | null;
  /** The last read was refused: the rows stay as they were, and this says why. */
  readonly refused: Refusal | null;
  /** A write answered and no read since its bound: the rows from before it are withheld. */
  readonly behind: boolean;
  /** The clock the relative stamps read, moved by the tick. */
  readonly now: number;
  /** Whether another mailbox may be connected, once read; `null` while unread. */
  readonly allowance: ConnectAllowance | null;
  readonly allowanceRead: boolean;
  /** Read the list again; `true` when it answered. */
  refresh(): Promise<boolean>;
  /** After a write the server answered: `true` once a read issued after it answered, inside the bound. */
  afterWrite(): Promise<boolean>;
  /** Read the allowance again (the pane does on every return to rest). */
  readAllowance(): void;
  /** A row a press answered, folded in at once; the count it never carries is kept. */
  fold(row: MailboxRow): void;
  /** A press's own channel of the ordering rule: its answer retires every read issued before it. */
  readonly wins: () => LatestWins;
  /** The pane still stands. */
  readonly alive: { readonly current: boolean };
}

const UNKNOWN: ConnectAllowance = Object.freeze({ emailVerified: null, access: null });

/**
 * A countless answer keeps each row's last count, matched on its id. `0` is a count; absent is not. Returns the new
 * answer itself when nothing was carried, so an unchanged poll draws nothing new.
 */
export function carryCounts(
  prev: readonly MailboxRow[] | null,
  got: readonly MailboxRow[],
): readonly MailboxRow[] {
  if (prev === null) return got;
  let carriedAny = false;
  const merged = got.map((m) => {
    if (m.messageCount !== undefined) return m;
    const carried = prev.find((p) => p.id === m.id)?.messageCount;
    if (carried === undefined) return m;
    carriedAny = true;
    return { ...m, messageCount: carried };
  });
  return carriedAny ? merged : got;
}

function useAlive(): { current: boolean } {
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export function useMailboxes(input: MailboxesInput): MailboxesList {
  const latest = useRef(input);
  latest.current = input;
  const alive = useAlive();
  const wins = useLatestWins(alive);
  const [rows, setRows] = useState<readonly MailboxRow[] | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [allowance, setAllowance] = useState<ConnectAllowance | null>(null);
  const [allowanceRead, setAllowanceRead] = useState(false);
  const writes = useRef(0);
  const owed = useRef(false);
  const late = useRef(false);
  const [behind, setBehind] = useState(false);

  const read = useCallback(
    async (counts: boolean): Promise<boolean> => {
      const mine = wins();
      const epoch = writes.current;
      const answer = await latest.current.wire.list({ counts });
      if (!answer.ok) {
        // A refused read is not an empty list: the rows stay, and the refusal says why.
        if (mine.claim()) setRefused(answer.refusal);
        return false;
      }
      if (mine.claim()) {
        setRows((prev) => carryCounts(prev, answer.value));
        setRefused(null);
      }
      // A read issued after the last answered write settles it, whichever read that is.
      if (epoch === writes.current && owed.current) {
        owed.current = false;
        if (late.current && alive.current) {
          late.current = false;
          setBehind(false);
        }
      }
      return true;
    },
    [alive, wins],
  );
  const refresh = useCallback(() => read(false), [read]);

  const afterWrite = useCallback(async (): Promise<boolean> => {
    writes.current += 1;
    owed.current = true;
    late.current = false;
    wins().publish();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      read(false),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), WRITE_SETTLE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!owed.current) return true;
    if (alive.current) {
      late.current = true;
      setBehind(true);
    }
    return false;
  }, [alive, read, wins]);

  const readAllowance = useCallback((): void => {
    const ask = latest.current.wire.allowance;
    if (ask === NONE) {
      setAllowance(UNKNOWN);
      setAllowanceRead(true);
      return;
    }
    void ask().then((answer) => {
      if (!alive.current) return;
      // Unreadable is unknown, and an unknown withholds nothing.
      setAllowance(answer.ok ? answer.value : UNKNOWN);
      setAllowanceRead(true);
    });
  }, [alive]);

  const fold = useCallback((row: MailboxRow): void => {
    setRows((list) =>
      list === null
        ? list
        : list.map((it) => (it.id === row.id ? { ...it, ...row, messageCount: it.messageCount } : it)),
    );
  }, []);

  // The one read that asks for counts: as the pane opens.
  useEffect(() => {
    void read(true);
  }, [read]);

  // Keep looking, never for counts, and not while nobody is.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      if (latest.current.hidden()) return;
      void read(false);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [read]);

  return {
    rows,
    refused,
    behind,
    now,
    allowance,
    allowanceRead,
    refresh,
    afterWrite,
    readAllowance,
    fold,
    wins,
    alive,
  };
}
