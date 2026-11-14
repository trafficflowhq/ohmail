/**
 * AN ADDRESS'S MODEL: every letter from and to one address, newest first, as All, From them or To them, each with its
 * count. The address is the route's; what it is called and where each letter is are the seat's words.
 */
import type { EngineMessage } from "@ohmail/wire";
import { createContext, useContext, useMemo, useState } from "react";
import type { AddressView } from "./archive.js";
import { newestFirst, usePlaceList, type PlaceList, type PlaceListInput } from "../place-list/place-list.js";

export type AddressSide = "all" | "from" | "to";

export interface AddressInput extends Omit<PlaceListInput, "rows"> {
  readonly address: string;
  /** Every letter that names the address, as sender or recipient. */
  readonly messages: readonly EngineMessage[];
  readonly settled: boolean;
  readonly owed: boolean;
  readonly side?: AddressSide;
  readonly choose?: (side: AddressSide) => void;
  readonly archive?: AddressView & { readonly rows: readonly EngineMessage[] };
  readonly placeOf: (m: EngineMessage) => string;
  readonly stamp: (iso: string) => string;
  /** The way back to the list the address was opened from. */
  readonly back: { readonly label: string; readonly run: () => void } | null;
}

export interface AddressModel {
  readonly list: PlaceList;
  readonly address: string;
  /** The newest name the address goes by as a sender or recipient, else the address. */
  readonly name: string;
  readonly side: AddressSide;
  readonly choose: (side: AddressSide) => void;
  readonly counts: Readonly<Record<AddressSide, number>>;
  readonly archive?: AddressView;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly placeOf: (m: EngineMessage) => string;
  readonly stamp: (iso: string) => string;
  readonly back: AddressInput["back"];
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
function newestName(messages: readonly EngineMessage[], address: string): string {
  for (const message of messages) {
    for (const person of [message.from, ...message.to, ...message.cc]) {
      if (same(person.address, address) && person.name?.trim()) return person.name.trim();
    }
  }
  return address;
}

export function useAddressList(input: AddressInput): AddressModel {
  const { address, messages, settled, owed } = input;
  const [localSide, choose] = useState<AddressSide>(input.side ?? "all");
  const side = input.choose ? (input.side ?? "all") : localSide;
  const { archive } = input;
  const { from, to, all } = useMemo(() => {
    const sorted = [...messages].sort(newestFirst);
    const fromThem = sorted.filter((m) => same(m.from.address, address));
    const toThem = sorted.filter((m) => [...m.to, ...m.cc].some((p) => same(p.address, address)));
    const both = sorted.filter((m) => fromThem.includes(m) || toThem.includes(m));
    return { from: fromThem, to: toThem, all: both };
  }, [messages, address]);
  const rows = archive?.rows ?? (side === "from" ? from : side === "to" ? to : all);
  const counts = archive
    ? { all: archive.counts.any, from: archive.counts.from, to: archive.counts.to }
    : { all: all.length, from: from.length, to: to.length };
  const pass = archive?.archive;
  if (pass?.state === "ready") {
    const device = new Set(messages.map((m) => m.id));
    const extras = pass.items.filter((m) => !device.has(m.id)).length;
    counts.all += extras;
    if (pass.direction !== "any") counts[pass.direction] += extras;
  }
  const list = usePlaceList({ ...input, rows });
  const none = rows.length === 0;
  return {
    list,
    address,
    name: newestName([...all, ...rows].sort(newestFirst), address),
    side,
    choose: input.choose ?? choose,
    counts,
    archive,
    loading: none && (!settled || owed || archive?.indexing === true || pass?.state === "searching"),
    empty:
      none &&
      settled &&
      !owed &&
      !archive?.indexing &&
      pass?.state !== "searching" &&
      pass?.state !== "failed",
    placeOf: input.placeOf,
    stamp: input.stamp,
    back: input.back,
  };
}

export const AddressModelContext = createContext<AddressModel | null>(null);

export function useAddressModel(): AddressModel {
  const model = useContext(AddressModelContext);
  if (model === null) throw new Error("An address was drawn with no model above it (AddressModelContext)");
  return model;
}
