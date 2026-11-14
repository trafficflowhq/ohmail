/**
 * AN ADDRESS, LIVE: what an address's seat calls once (`packages/app/src/address/Seat.tsx`). Every letter this device
 * holds from and to one address (the engine's address index, the same answer Search's address rows read), the
 * address the route names, and each letter's place in the person's words.
 *
 * The archive pass is scoped to the address and selected direction.
 */
import { useMemo, useState } from "react";
import type { EngineMessage } from "@ohmail/wire";
import { atStamp, useDerivedVersion, useEngine } from "../engine/context.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { usePlaceListFeed, usePlaceListKeys, type PlaceListLiveOwn } from "../place-list/live.js";
import { useStableCallback } from "../press/stable-callback.js";
import { useDayClock } from "../session/day-clock.js";
import { stampOver } from "../text/format.js";
import { useAddressView } from "./archive.js";
import { useAddressList, type AddressModel, type AddressSide } from "./model.js";

/** What only an address's seat can read. */
export interface AddressLiveOwn extends PlaceListLiveOwn {
  readonly back: AddressModel["back"];
  /** The zone the reader's clock runs in. */
  readonly zone: string;
  /** A folder as the person reads it: its place's word where it is a place's, else its last part. */
  readonly placeLabel: (folder: string) => string;
}

export function useAddressLive(args: PlaceLiveArgs, own: AddressLiveOwn): AddressModel {
  const engine = useEngine();
  const derived = useDerivedVersion();
  const now = useDayClock(null, own.zone);
  /* The route names the address; a link that names none is an answered question with nothing in it. */
  const address = args.route.sub ?? "";
  const [choice, setChoice] = useState<{ address: string; side: AddressSide }>({ address, side: "all" });
  const side = choice.address === address ? choice.side : "all";
  if (choice.address !== address) setChoice({ address, side });
  const archive = useAddressView({
    engine,
    version: derived,
    address,
    direction: side === "all" ? "any" : side,
  });
  const messages = useMemo(
    () =>
      atStamp(
        derived,
        engine.messagesWith(address, "any").items.map((hit) => hit.message),
      ),
    [engine, address, derived],
  );
  const archiveRows = useMemo(
    () =>
      atStamp(
        derived,
        archive.items.map(({ hit }) => engine.storePageRow(hit.message)).filter((row) => row !== null),
      ),
    [archive.items, engine, derived],
  );
  const feed = usePlaceListFeed(args, own, archiveRows);
  const { placeLabel } = own;
  const model = useAddressList({
    ...feed.list,
    walk: { ...feed.list.walk, replacePreview: (id) => args.commands.open(id, "replace") },
    arrival: "first",
    address,
    messages,
    side,
    archive: { ...archive, rows: archiveRows },
    choose: (next) => setChoice({ address, side: next }),
    settled: feed.settled,
    owed: feed.owed,
    placeOf: useStableCallback((message: EngineMessage) => placeLabel(message.folder)),
    stamp: useMemo(() => stampOver(now), [now]),
    back: own.back,
  });
  usePlaceListKeys(model.list, own);
  return model;
}
