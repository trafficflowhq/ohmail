/**
 * WHAT THE FOUR LIST PLACES BESIDE THE READER FEED ALIKE (History, a tag, a folder, an address): the letter open in
 * the place, its mark through the one seam and a letter's verbs (the list places' one verbs record, `verbs.ts`,
 * called here once a place), the hit another place opened into it as entered, the walk's seat, the mail state's
 * two facts and the mirror's tags. Each place's own `live.ts` calls this once and adds what is its own; nothing here is a place's.
 */
import type { EngineMessage, TagDTO } from "@ohmail/wire";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import type { PlaceList, PlaceListInput } from "./place-list.js";
import { usePlaceVerbs, type PlaceVerbsOwn } from "./verbs.js";
import { CURSOR_HINT_MS, useListWalkKeys, type ListWalkSeat, type ListZones } from "./walk.js";

/** What only a list place's seat can read, alike for the four: what the verbs record takes, and the walk's words. */
export interface PlaceListLiveOwn extends PlaceVerbsOwn, ListZones {
  /** A restored entry can have an intentionally empty reading column. */
  readonly readerClosed?: boolean;
  /** The walk's keys as the key sheet names them, and the sentence a placed cursor is said with. */
  readonly keys: ListWalkSeat["labels"] & { readonly placed: (label: string) => string };
}

/**
 * What a list's model takes of the frame and of the verbs, WHOLE: the letter open and the way to open one, the mark,
 * a letter's verbs, the entered hit and the walk's seat. A place spreads it into its model's input (`...feed.list`),
 * so a member the list's model gains reaches every place through that one line. What is left is the place's own: its
 * rows, and its word on arrival.
 */
export type PlaceListSeat = Omit<PlaceListInput, "rows" | "arrival">;

export interface PlaceListFeed {
  readonly list: PlaceListSeat;
  readonly settled: boolean;
  readonly owed: boolean;
  /** The mirror's tags, as the stamp of the mirror read them. */
  readonly tags: readonly TagDTO[];
}

/**
 * The feed of a list place beside the reader. `surface`: the rows the place shows past the mirror (History's store
 * pages), by which a verb resolves a row the mirror does not hold.
 */
export function usePlaceListFeed(
  args: PlaceLiveArgs,
  own: PlaceListLiveOwn,
  surface: readonly EngineMessage[],
): PlaceListFeed {
  const { verbs, markSeen, tags, settled, owed } = usePlaceVerbs(args, own, surface);
  const { route, report } = args;
  const { placed, ...labels } = own.keys;
  const list: PlaceListSeat = {
    openId: route.open,
    open: args.commands.open,
    markSeen,
    act: verbs.onMessageAction,
    entered: args.entered,
    walk: {
      columns: args.plan.columns,
      readerClosed: own.readerClosed === true,
      /* A tag, a folder and an address are each a list of their own under the place's one seat. */
      list: `${route.place}/${route.sub ?? ""}`,
      labels,
      say: (label) => report(placed(label), { duration: CURSOR_HINT_MS }),
    },
  };
  return { list, settled, owed, tags };
}

/**
 * THE LIST's KEYS, bound once a place: what the place's live hook calls after its model, with the model's list. `j`,
 * `k`, the arrows and Enter walk it, and a first verb key places its cursor (`walk.ts`).
 */
export function usePlaceListKeys(list: PlaceList, own: PlaceListLiveOwn): void {
  useListWalkKeys(list.walk, own);
}
