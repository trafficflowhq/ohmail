"use client";

/**
 * THE LETTERS OHMAIL FILED TO SPAM FOR CLAIMING A COMPANY — the Screener's one quiet line (owner,
 * 2026-11-09). Read through the engine (`GET /screener/auto-filed`) once per mount and after a Put
 * back, never mirrored; only `impersonation` filings newer than this device's mark count. OK records
 * the newest as seen on this device, and a refused storage keeps it for the session. Put back returns
 * letters to the Screener for good. One line per batch, no toast.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import type { AutoFiledItemWire, OhmailEngine } from "@ohmail/client-engine";
import { durableSet } from "./durable";
import { storageOwner } from "./storage-owner";

/**
 * This device's mark, per account (`searchSortKey`'s keying): the newest filing it has acknowledged,
 * as its ISO instant. A timestamp, no mail in it, so it survives sign-out.
 */
export const IMPERSONATION_SEEN_PREFIX = "ohmail.screener.impersonationSeen.";
export const impersonationSeenKey = (): string => `${IMPERSONATION_SEEN_PREFIX}${storageOwner() ?? "local"}`;

export interface ImpersonationFiledNotice {
  /** The filings the line counts, newest first. */
  items: AutoFiledItemWire[];
  /** The list is open (Review). */
  open: boolean;
  toggle: () => void;
  /** A Put back is in flight; a second one is refused rather than queued. */
  busy: boolean;
  /** What the last Put back answered when it did not simply take the letters back. */
  said: "requested" | "failed" | null;
  putBack: (ids: readonly string[]) => void;
  /** OK: the line goes until a newer filing. */
  acknowledge: () => void;
}

/** The device's mark, or `""` when there is none or storage cannot be read. */
export function readImpersonationSeen(): string {
  try {
    const v = (globalThis as { localStorage?: Storage }).localStorage?.getItem(impersonationSeenKey());
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** The filings the line counts: impersonations filed after the mark (ISO instants compare as text). */
export function unseenImpersonations(items: readonly AutoFiledItemWire[], seen: string): AutoFiledItemWire[] {
  return items.filter((i) => i.why === "impersonation" && i.filedAt > seen);
}

/** The notice, or `null` while unread, unanswerable, acknowledged, or where a press is walled (`blocked`). */
export function useImpersonationFiled(engine: OhmailEngine, blocked: boolean): ImpersonationFiledNotice | null {
  const [items, setItems] = useState<AutoFiledItemWire[] | null>(null);
  const [seen, setSeen] = useState<string>(readImpersonationSeen);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<"requested" | "failed" | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  // Asked once per mount and again after each Put back; no memoized closure holds this frame.
  const [asked, ask] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let live = true;
    // A door that cannot say leaves the state alone: no render for an answer that changes nothing.
    void engine.autoFiled().then((page) => { if (live && page !== null) setItems(page.items); });
    return () => { live = false; };
  }, [engine, asked]);

  if (items === null || blocked) return null;
  const unseen = unseenImpersonations(items, seen);
  if (unseen.length === 0) return null;

  const putBack = (ids: readonly string[]): void => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    void engine.putBackAutoFiled(ids)
      .then((r) => {
        if (!alive.current) return;
        if (r.putBack.length === 0 && r.requested.length > 0) setSaid("requested");
        ask();
      })
      .catch(() => { if (alive.current) setSaid("failed"); })
      .finally(() => { if (alive.current) setBusy(false); });
  };
  const acknowledge = (): void => {
    const newest = unseen.reduce((m, i) => (i.filedAt > m ? i.filedAt : m), seen);
    setSeen(newest);
    setOpen(false);
    // A refused jar is announced once by the door itself; the mark still holds for this session.
    durableSet(impersonationSeenKey(), newest, "screener.impersonationSeen");
  };
  return { items: unseen, open, toggle: () => setOpen((o) => !o), busy, said, putBack, acknowledge };
}
