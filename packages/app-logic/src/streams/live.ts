"use client";

/**
 * A STREAM, LIVE (News, Receipts): what a stream place's seat calls once (`packages/app/src/stream/Seat.tsx`). It
 * assembles the stream's input (`StreamInput`) from the frame's side (`args`), the mail ground's readers and the
 * engine, and calls the stream's model (`useStream`) once. The two streams share this shape, as their model does: the
 * place is its first argument.
 *
 * WHERE EACH INPUT COMES FROM. The frame: the open item (the address's) and the way to open one, the one press seam
 * (Mark unread, and the Undo of Mark all read). The ground: the presented mirror the pile is partitioned from, the
 * mail state's two facts every count waits for. The engine: the stream's line, the bodies, the glances and the leave's
 * commit (`writes.ts`). What only the seat can read (`own`): the tab going away, the clock's zone, the sentences.
 *
 * A hit opened INTO the stream as entered (the frame's one-shot) drives the stream once its item is the open one, so
 * the item it lands on is read by the rule at rest; a landing by address, a reload or Back drives nothing.
 */
import type { EngineMessage, FeedView, MessageBody } from "@ohmail/wire";
import { useEffect, useMemo, useState } from "react";
import {
  feedPartition,
  type EntityReader,
  type FeedPartition,
  type OhmailEngine,
} from "@ohmail/client-engine";
import { useDerivedVersion, useEngine } from "../engine/context.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { useStableCallback } from "../press/stable-callback.js";
import { useTakeEntered } from "../place-list/entered.js";
import { markSeenOver } from "../reader/mark-seen.js";
import { readLetterBody } from "../reader/open-conversation.js";
import { useBodyStamp } from "../reading/body-arrival.js";
import { usePresented } from "../reading/presented-mirror.js";
import { useDayClock } from "../session/day-clock.js";
import { stampOver } from "../text/format.js";
import type { Translator } from "../text/translator.js";
import { useStream, type StreamModel, type StreamPlace } from "./use-stream.js";
import { useStreamWrites } from "./writes.js";

/** Each stream's line and glances, by the engine's own name for its pile. */
export const FEED_OF: Readonly<Record<StreamPlace, FeedView>> = { news: "reads", receipts: "receipts" };

/** Each stream's partition of a presented mirror, by the stamp it was read at. */
const PARTITION_AT = new WeakMap<
  EntityReader,
  { readonly at: number; readonly views: Map<FeedView, FeedPartition> }
>();

/**
 * A stream's partition of what the mail ground presents, derived once a mirror's stamp: the stream's rail entry and
 * its seat read this one.
 */
export function useGroundPartition(view: FeedView): FeedPartition {
  const presented = usePresented(); // throws where no ground stands above
  const derived = useDerivedVersion();
  return useMemo(() => {
    let held = PARTITION_AT.get(presented);
    if (held === undefined || held.at !== derived) {
      held = { at: derived, views: new Map() };
      PARTITION_AT.set(presented, held);
    }
    const kept = held.views.get(view);
    if (kept !== undefined) return kept;
    const partition = feedPartition(presented, view);
    held.views.set(view, partition);
    return partition;
  }, [presented, derived, view]);
}

/** What only a stream's seat can read. */
export interface StreamLiveOwn {
  /** The place's own words: what Mark all read says, and its Undo. */
  readonly t: Translator;
  /** The zone the reader's clock runs in. */
  readonly zone: string;
  /** The tab going away, as a subscription the seat keeps on the page's own window. */
  readonly onPageHide: (leave: () => void) => () => void;
}

/** A background fetch keeps the folded snippet until a complete body is available. */
type PrefetchedBodies = Map<string, MessageBody | null>;
const PREFETCHED = new WeakMap<OhmailEngine, { scope: string; bodies: PrefetchedBodies }>();

function prefetchesFor(engine: OhmailEngine, scope: string): PrefetchedBodies {
  let record = PREFETCHED.get(engine);
  if (record?.scope !== scope) {
    record = { scope, bodies: new Map() };
    PREFETCHED.set(engine, record);
  }
  return record.bodies;
}

function prefetchBodies(
  engine: OhmailEngine,
  scope: string,
  presented: EntityReader,
  ids: readonly string[],
) {
  const asked = prefetchesFor(engine, scope);
  for (const id of ids) {
    if (asked.has(id)) continue;
    const body = streamBody(engine, presented, id);
    if (!body) continue;
    asked.set(id, readableText(body) === null ? body : null);
    void engine.hydrateBody(id);
  }
}

function streamBody(engine: OhmailEngine, presented: EntityReader, id: string) {
  const message =
    presented.get<EngineMessage>("message", id) ?? engine.read().get<EngineMessage>("message", id);
  return message ? readLetterBody(engine, message) : undefined;
}

function readableText(body: MessageBody | undefined): string | null {
  return body?.state === "full" || body?.state === "withheld" ? body.text : null;
}

export function useStreamLive(place: StreamPlace, args: PlaceLiveArgs, own: StreamLiveOwn): StreamModel {
  const engine = useEngine();
  const presented = usePresented(); // throws where no ground stands above
  const { state: mail } = useMailState();
  const { press, scope, route, commands, entered } = args;
  const view = FEED_OF[place];
  const partition = useGroundPartition(view);
  /* The items' words are their bodies: the place draws again as one lands. */
  useBodyStamp();
  const now = useDayClock(null, own.zone);
  const { t } = own;
  const words = useMemo(
    () => ({ done: (count: number) => t("markAll.done", { count }), undo: t("markAll.undo") }),
    [t],
  );
  const writes = useStreamWrites(engine, view, press, words);
  const markSeen = useMemo(() => markSeenOver(press), [press]);
  /* The pending glances leave with the tab, and with the place. */
  const { flush } = writes;
  const { onPageHide } = own;
  useEffect(() => onPageHide(flush), [onPageHide, flush]);
  useEffect(() => flush, [flush]);

  const top = partition.fresh[0]?.id ?? partition.seen[0]?.id ?? null;
  const bodyFor = useStableCallback((id: string) => streamBody(engine, presented, id));
  const [, refreshPreview] = useState(0);
  const prefetch = useStableCallback((ids: readonly string[]) =>
    prefetchBodies(engine, scope, presented, ids),
  );
  const scopedPrefetch = () => {
    const record = PREFETCHED.get(engine);
    return record?.scope === scope ? record.bodies : undefined;
  };
  const snapshotOf = (id: string) => scopedPrefetch()?.get(id) ?? null;
  const previewOf = (id: string) => {
    const body = bodyFor(id);
    return readableText(body) === null ? (snapshotOf(id) ?? body) : body;
  };
  const model = useStream({
    place,
    settled: mail.settled,
    owed: mail.owed,
    partition,
    markSeen: writes.markSeen,
    onLeaveSeen: writes.onLeaveSeen,
    markUnread: (id) => void markSeen([id], true),
    markAllRead: (ids) => writes.markAllRead(ids, top),
    textOf: (id) => readableText(previewOf(id)),
    hasPreviewMarkup: (id) => Boolean(previewOf(id)?.html),
    bodyReady: (id) => readableText(bodyFor(id)) !== null,
    bodyStateOf: (id) => previewOf(id)?.state,
    prefetch,
    prefetchSource: presented,
    revealPrefetch: (id) => {
      const asked = prefetchesFor(engine, scope);
      const snapshot = asked.get(id);
      asked.set(id, null);
      if (snapshot) refreshPreview((version) => version + 1);
    },
    hydrate: (ids) => {
      for (const id of ids) void engine.hydrateBody(id);
    },
    onPageHide,
    openId: route.open,
    open: commands.open,
    inlineKeys: args.plan.device === "phone",
    entered,
    stamp: useMemo(() => stampOver(now), [now]),
  });

  /* On a phone the reader stands over the stream. The desktop stream consumes the hit when its card can land. */
  useTakeEntered(
    entered,
    (id) => args.plan.device === "phone" && id === model.openId,
    (id) => model.read.enter(id),
  );
  return model;
}
