/**
 * AN ADDRESS'S MODEL: every letter from and to one address, newest first, as All, From them or To them, each with its
 * count. The address is the route's; what it is called and where each letter is are the seat's words.
 */
import { createContext, useContext, useMemo, useState } from "react";
import type { EngineMessage } from "@ohmail/client-engine";
import { newestFirst, usePlaceList, type PlaceList, type PlaceListInput } from "../place-list/place-list.js";

export type AddressSide = "all" | "from" | "to";

export interface AddressInput extends Omit<PlaceListInput, "rows"> {
  readonly address: string;
  /** Every letter that names the address, as sender or recipient. */
  readonly messages: readonly EngineMessage[];
  readonly settled: boolean;
  readonly owed: boolean;
  readonly side?: AddressSide;
  readonly placeOf: (m: EngineMessage) => string;
  readonly stamp: (iso: string) => string;
  /** The way back to the list the address was opened from. */
  readonly back: { readonly label: string; readonly run: () => void } | null;
}

export interface AddressModel {
  readonly list: PlaceList;
  readonly address: string;
  /** The name the address goes by in its newest letter from it, else the address. */
  readonly name: string;
  readonly side: AddressSide;
  readonly choose: (side: AddressSide) => void;
  readonly counts: Readonly<Record<AddressSide, number>>;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly placeOf: (m: EngineMessage) => string;
  readonly stamp: (iso: string) => string;
  readonly back: AddressInput["back"];
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
export function useAddressList(input: AddressInput): AddressModel {
  const { address, messages, settled, owed } = input;
  const [side, choose] = useState<AddressSide>(input.side ?? "all");
  const { from, to, all } = useMemo(() => {
    const sorted = [...messages].sort(newestFirst);
    const fromThem = sorted.filter((m) => same(m.from.address, address));
    const toThem = sorted.filter((m) => [...m.to, ...m.cc].some((p) => same(p.address, address)));
    const both = sorted.filter((m) => fromThem.includes(m) || toThem.includes(m));
    return { from: fromThem, to: toThem, all: both };
  }, [messages, address]);
  const rows = side === "from" ? from : side === "to" ? to : all;
  const list = usePlaceList({ ...input, rows });
  const named = from.find((m) => (m.from.name ?? "").trim().length > 0)?.from.name?.trim();
  const none = rows.length === 0;
  return {
    list,
    address,
    name: named ?? address,
    side,
    choose,
    counts: { all: all.length, from: from.length, to: to.length },
    loading: none && (!settled || owed),
    empty: none && settled && !owed,
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
