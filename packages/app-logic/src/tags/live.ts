/**
 * TAGS, LIVE: what Tags' seat calls once (`packages/app/src/tags/Seat.tsx`). The tag the route names (none: every
 * tag), the letters that carry a tag as the ground presents them, and a tag's own two verbs, Rename and Delete,
 * each said once through the seam as the old shell said it (`../press/tag-verbs.ts`).
 */
import { useMemo } from "react";
import type { EngineMessage, TagDTO } from "@ohmail/wire";
import { atStamp, useDerivedVersion, useEngine } from "../engine/context.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { usePlaceListFeed, usePlaceListKeys, type PlaceListLiveOwn } from "../place-list/live.js";
import { deleteTag, renameTag } from "../press/tag-verbs.js";
import { useStableCallback } from "../press/stable-callback.js";
import { usePresented } from "../reading/presented-mirror.js";
import { useDayClock } from "../session/day-clock.js";
import { stampOver } from "../text/format.js";
import { useTagsList, type TagsModel } from "./model.js";

/** What only Tags' seat can read. */
export interface TagsLiveOwn extends PlaceListLiveOwn {
  /** The zone the reader's clock runs in. */
  readonly zone: string;
}

export function useTagsLive(args: PlaceLiveArgs, own: TagsLiveOwn): TagsModel {
  const presented = usePresented(); // throws where no ground stands above
  const derived = useDerivedVersion();
  const now = useDayClock(null, own.zone);
  /* Every letter that carries a tag, as the lists present them: a tag is a lens over every place. */
  const messages = useMemo(
    () =>
      atStamp(
        derived,
        presented.list<EngineMessage>("message").filter((m) => (m.labels?.length ?? 0) > 0),
      ),
    [presented, derived],
  );
  const feed = usePlaceListFeed(args, own, messages);
  const { press } = args;
  const cx = { press, t: own.words, tags: feed.tags };
  const model = useTagsList({
    ...feed.list,
    arrival: "first",
    tags: feed.tags,
    messages,
    tagId: args.route.sub,
    settled: feed.settled,
    owed: feed.owed,
    stamp: useMemo(() => stampOver(now), [now]),
    rename: useStableCallback((tagId: string, name: string) => renameTag(cx, tagId, name)),
    remove: useStableCallback((tagId: string) => deleteTag(cx, tagId)),
  });
  usePlaceListKeys(model.list, own);
  return model;
}

// Older local rows can lack a creation time. Give them a stable place before dated tags.
function tagCreatedAt(tag: TagDTO): number {
  const time = Date.parse(tag.createdAt);
  return Number.isNaN(time) ? -Infinity : time;
}

/**
 * What the rail's Tags group draws for the frame's life, off the ground alone: every tag by name, and how many
 * letters carry each, as the lists present them.
 */
export function useTagsRailLive(): {
  readonly tags: readonly { readonly tag: TagDTO; readonly count: number }[];
} {
  const engine = useEngine();
  const presented = usePresented(); // throws where no ground stands above
  const derived = useDerivedVersion();
  return useMemo(() => {
    const carrying = new Map<string, number>();
    /* A row held without its labels (an older mirror's, as the engine's shadow reads it) carries none: the group is
       drawn at every place, and one such row must not take the frame down with it. */
    for (const m of presented.list<EngineMessage>("message"))
      for (const id of m.labels ?? []) carrying.set(id, (carrying.get(id) ?? 0) + 1);
    // Match the account's tag list even when sync or the reopened mirror delivers rows in another order.
    const tags = [...engine.read().list<TagDTO>("tag")].sort((a, b) =>
      tagCreatedAt(a) - tagCreatedAt(b) || a.id.localeCompare(b.id),
    );
    return atStamp(derived, { tags: tags.map((tag) => ({ tag, count: carrying.get(tag.id) ?? 0 })) });
  }, [engine, presented, derived]);
}
