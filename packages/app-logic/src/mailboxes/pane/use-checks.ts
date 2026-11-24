"use client";

/**
 * A MAILBOX AGAINST ITS SERVER, AND ITS FILINGS THAT WAIT: the two readers of an opened row (moved out of the web
 * shell's `MailboxSelfCheck.tsx` and `MailboxFilings.tsx`). The check is one press, one sentence back, and reads only;
 * the filings are re-read when the row's own figures move, and their two presses move no mail here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readSelfCheck } from "@trafficflow/core/diagnostics";
import type { MailboxId } from "../connect/types.js";
import { NONE, type FilingCalls, type None, type PaneCalls } from "./calls.js";
import { filingGroupsOf, type FilingGroup } from "./filings.js";
import type { SelfCheckPress } from "./self-check.js";
import type { MailboxRow } from "./types.js";

export interface SelfChecks {
  readonly press: (id: MailboxId) => SelfCheckPress;
  run(id: MailboxId): void;
}

export function useSelfChecks(check: PaneCalls["selfCheck"]): SelfChecks {
  const [press, setPress] = useState<Readonly<Record<string, SelfCheckPress>>>({});
  const run = useCallback(
    (id: MailboxId): void => {
      if (check === NONE) return;
      setPress((p) => ({ ...p, [id]: { k: "busy" } }));
      void check(id).then((answer) => {
        const reading = answer.ok ? readSelfCheck(answer.value) : null;
        const next: SelfCheckPress =
          reading !== null && reading.mailboxId === id ? { k: "read", check: reading } : { k: "failed" };
        setPress((p) => ({ ...p, [id]: next }));
      });
    },
    [check],
  );
  return { press: (id) => press[id] ?? { k: "rest" }, run };
}

export type FilingsRead =
  | { readonly k: "loading" }
  | { readonly k: "read"; readonly groups: FilingGroup[] }
  | { readonly k: "unread" };
export type FilingsNote =
  { readonly k: "retried" | "left"; readonly count: number } | { readonly k: "failed" | "elsewhere" } | null;

export interface Filings {
  readonly read: FilingsRead;
  readonly busy: boolean;
  readonly note: FilingsNote;
  retry(folder: string): void;
  leave(folder: string, through: string): void;
}

/** One opened row's filings: read again when its own figures move; no clock of its own, the facts' poll is it. */
export function useFilings(calls: FilingCalls | None, m: MailboxRow, refreshMailState: () => void): Filings {
  const wire = calls;
  const [read, setRead] = useState<FilingsRead>({ k: "loading" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<FilingsNote>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(async (): Promise<void> => {
    if (wire === NONE) return;
    const answer = await wire.read(m.id);
    const groups = answer.ok ? filingGroupsOf(answer.value, m.id) : null;
    if (alive.current) setRead(groups === null ? { k: "unread" } : { k: "read", groups });
  }, [m.id, wire]);
  const f = m.filing;
  useEffect(() => {
    void load();
  }, [load, f?.stuck, f?.deferred, m.pendingMoves]);

  const pressed = (act: () => Promise<FilingsNote>): void => {
    setBusy(true);
    void act().then(async (next) => {
      refreshMailState();
      await load();
      if (!alive.current) return;
      setNote(next);
      setBusy(false);
    });
  };
  const failed = (status: number): FilingsNote => (status === 409 ? { k: "elsewhere" } : { k: "failed" });
  return {
    read,
    busy,
    note,
    retry: (folder) => {
      if (wire === NONE) return;
      pressed(async () => {
        const a = await wire.retry(m.id, folder);
        return a.ok ? { k: "retried", count: a.value.reset } : failed(a.refusal.status);
      });
    },
    leave: (folder, through) => {
      if (wire === NONE) return;
      pressed(async () => {
        const a = await wire.leave(m.id, folder, through);
        return a.ok ? { k: "left", count: a.value.settled } : failed(a.refusal.status);
      });
    },
  };
}
