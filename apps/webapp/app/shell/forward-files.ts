"use client";

/**
 * THE FILES A FORWARD CARRIES, LISTED BEFORE IT GOES — the phone's contract (`apps/mobile/src/compose/
 * forward-files.ts`), name for name. The server streams the original's parts onto the forward; once the
 * person removes one, the send names the ids kept (`forwardParts`), so a removed part never leaves.
 * With nothing removed no list goes and the server sends every part. Until the server's answer is known
 * the rows are read-only and a choice made earlier still goes (the adapter's send-time check refuses it in
 * words if the server cannot honour it). Where the server said it cannot, every part goes, and a choice
 * made earlier is said lost.
 *
 * Three bounds: files added here stay under the composer's own cap (`ComposeAttach` enforces it), the
 * kept parts under the send's forwarded ceiling, and both together under what the mailbox takes.
 */
import { useEffect, useReducer } from "react";
import {
  COMPOSE_FORWARD_MAX_TOTAL_BYTES, SENT_FORWARD_MAX_PARTS, composeAttachCap, type OhmailEngine,
} from "@ohmail/client-engine";

export interface ForwardPart { id: string; filename: string; sizeBytes: number; inline: boolean }

export interface ForwardFilesRead { state: "loading" | "ready" | "failed"; parts: ForwardPart[] }

/**
 * The original's parts as the send takes them: every raw part, embedded pictures and calendar bodies
 * included, sorted by id, the first `SENT_FORWARD_MAX_PARTS`. Never the reader's display list, which
 * hides calendar bodies: a hidden part would drop out of the kept list on any removal.
 */
export function forwardFilesOf(engine: OhmailEngine, messageId: string): ForwardFilesRead {
  const list = engine.attachmentsOf(messageId, { includeInlineParts: true });
  if (list.state === "failed" || list.state === "unavailable") return { state: "failed", parts: [] };
  if (list.state !== "ready") return { state: "loading", parts: [] };
  const parts = [...list.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, SENT_FORWARD_MAX_PARTS);
  return {
    state: "ready",
    parts: parts.map((i) => ({ id: i.id, filename: i.filename, sizeBytes: i.sizeBytes, inline: i.inline })),
  };
}

/** A sentence of the `compose` namespace, with the byte counts it names. */
export interface ForwardLine { key: string; bytes?: Record<string, number> }

export interface ForwardFilesInput {
  list: ForwardFilesRead;
  /** The server sends only the named parts (`GET /hello` `features.forwardParts`); `null` is not known yet. */
  supported: boolean | null;
  /** The ids kept after a removal; `null` is nothing removed. */
  kept: readonly string[] | null;
  /** Bytes of the files added here. */
  addedBytes: number;
  caps: { forwarded: number; message: number };
}

export interface ForwardFilesPlan {
  rows: Array<ForwardPart & { removable: boolean }>;
  kept: string[];
  /** What the send carries: the kept ids once one was removed, else absent (every part). */
  wire: string[] | undefined;
  keptBytes: number;
  /** The sentence under the rows; `null` when the original has no files. */
  line: ForwardLine | null;
  /** Why Send cannot go now, said in place of sending. */
  refusal: ForwardLine | null;
}

export function forwardFilesPlan(o: ForwardFilesInput): ForwardFilesPlan {
  const chosen = o.supported === false ? null : o.kept;
  const lost = o.supported === false && o.kept !== null;
  if (o.list.state === "loading") {
    // Nothing removed sends no list either way, and the server holds the forwarded bound.
    return {
      rows: [], kept: [], wire: undefined, keptBytes: 0, line: null,
      refusal: chosen === null ? null : { key: "forwardFilesReading" },
    };
  }
  if (o.list.state === "failed") {
    // Unread here: a choice made earlier still goes; without one the server sends every part.
    return {
      rows: [], kept: chosen === null ? [] : [...chosen], wire: chosen === null ? undefined : [...chosen], keptBytes: 0,
      line: { key: lost ? "forwardFilesUnreadRemovedGo" : chosen === null ? "forwardFilesUnreadAllGo" : "forwardFilesUnreadKept" },
      refusal: null,
    };
  }
  const all = o.list.parts.map((p) => ({ ...p, removable: o.supported === true }));
  const keptRows = chosen === null ? all : all.filter((r) => chosen.includes(r.id));
  const kept = keptRows.map((r) => r.id);
  const keptBytes = keptRows.reduce((n, r) => n + r.sizeBytes, 0);
  const line: ForwardLine | null = all.length === 0 ? null
    : o.supported === true || chosen !== null ? { key: "forwardFilesLine", bytes: { kept: keptBytes } }
      : { key: lost ? "forwardFilesRemovedGo" : "forwardFilesAllGo", bytes: { size: keptBytes } };
  const refusal: ForwardLine | null = keptBytes > o.caps.forwarded ? { key: "forwardFilesTooLarge", bytes: { limit: o.caps.forwarded } }
    : keptBytes + o.addedBytes > o.caps.message ? { key: "forwardFilesTotalTooLarge", bytes: { limit: o.caps.message } }
      : null;
  // Rows shown are the kept ones; a part already removed stays out of the list as it stays out of the send.
  return { rows: keptRows, kept, wire: chosen === null ? undefined : kept, keptBytes, line, refusal };
}

/** The decoded bytes of the files added here, from their base64 without decoding it. */
export function attachmentBytes(items: ReadonlyArray<{ contentBase64: string }>): number {
  return items.reduce((n, a) => {
    const len = a.contentBase64.length;
    const pad = a.contentBase64.endsWith("==") ? 2 : a.contentBase64.endsWith("=") ? 1 : 0;
    return n + (len === 0 ? 0 : Math.floor((len * 3) / 4) - pad);
  }, 0);
}

/** A forward's bounds for the sending mailbox's announced `SIZE` (`null`: unmeasured). */
export function forwardCaps(maxMessageBytes: number | null | undefined): ForwardFilesInput["caps"] {
  return { forwarded: COMPOSE_FORWARD_MAX_TOTAL_BYTES, message: composeAttachCap(maxMessageBytes, null) };
}

/** Do not ask a silent server more often than this while its answer is still unknown. */
export const FORWARD_SUPPORT_REASK_MS = 5_000;

interface SupportReader { said: boolean | null; asking: boolean; askedAt: number; listeners: Set<() => void> }
const readers = new WeakMap<OhmailEngine, SupportReader>();

function readerOf(engine: OhmailEngine): SupportReader {
  let r = readers.get(engine);
  if (!r) {
    r = { said: null, asking: false, askedAt: -Infinity, listeners: new Set() };
    readers.set(engine, r);
  }
  return r;
}

/**
 * THE ENGINE'S ANSWER, HELD — one per engine: asked when a forward opens, asked again while it is still
 * unanswered, and latched `false` once a send was refused `forward_parts_unsupported`.
 */
export function forwardPartsSupport(engine: OhmailEngine): {
  said: () => boolean | null; ask: () => void; refused: () => void; subscribe: (fn: () => void) => () => void;
} {
  const r = readerOf(engine);
  const tell = (): void => { for (const fn of r.listeners) fn(); };
  return {
    said: () => r.said,
    ask: () => {
      if (r.asking || r.said !== null || Date.now() - r.askedAt < FORWARD_SUPPORT_REASK_MS) return;
      r.asking = true;
      r.askedAt = Date.now();
      void engine.forwardPartsAnnounced().then((v) => {
        r.asking = false;
        if (r.said === null) r.said = v;
        tell();
      }, () => { r.asking = false; });
    },
    refused: () => {
      if (r.said === false) return;
      r.said = false;
      tell();
    },
    subscribe: (fn) => { r.listeners.add(fn); return () => { r.listeners.delete(fn); }; },
  };
}

/**
 * THE PLAN FOR ONE OPEN FORWARD, live: the original's parts (asked again on the open, a press of the
 * person's), the server's answer, the kept list and the added bytes. `null` when nothing is forwarded.
 * `refusedCode` is the lane's send refusal: `forward_parts_unsupported` latches the answer to `false`.
 */
export function useForwardFiles(
  engine: OhmailEngine,
  forwardOf: string | null,
  o: { kept: readonly string[] | null; addedBytes: number; maxMessageBytes: number | null | undefined; refusedCode?: string | null },
): ForwardFilesPlan | null {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const support = forwardPartsSupport(engine);
  useEffect(() => {
    if (forwardOf === null) return undefined;
    const offEngine = engine.subscribe(tick);
    const offSupport = support.subscribe(tick);
    support.ask();
    void engine.loadAttachments(forwardOf, { retry: true }).catch(() => undefined);
    return () => { offEngine(); offSupport(); };
    // `support` is a view over the engine's one reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, forwardOf]);
  useEffect(() => {
    if (o.refusedCode === "forward_parts_unsupported") support.refused();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, o.refusedCode]);
  const list = forwardOf === null ? null : forwardFilesOf(engine, forwardOf);
  // A reader leaving the original releases its list; ask again (single-flight while a read is out).
  useEffect(() => {
    if (forwardOf !== null && list?.state === "loading") void engine.loadAttachments(forwardOf).catch(() => undefined);
  }, [engine, forwardOf, list?.state]);
  if (forwardOf === null || list === null) return null;
  const supported = support.said();
  // Unknown: asked again (bounded), so a launch without the network does not hold the rows read-only for good.
  if (supported === null) support.ask();
  return forwardFilesPlan({
    list, supported, kept: o.kept, addedBytes: o.addedBytes,
    caps: forwardCaps(o.maxMessageBytes),
  });
}
