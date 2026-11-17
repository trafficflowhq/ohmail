/**
 * THE RECEIVING SIDE OF THE SWITCH, as one pure step: what this app does with an arrival, given what it holds. It
 * never changes account and never adds one: a place is opened only inside the account the sender named (its pairing's
 * digest equals this app's live pairing's), and only a place of the sender's direction. Anything else leaves the app
 * where it was. What a refusal counts is a closed word, for the native note.
 */
import { decodePlace } from "./place";
import type { SwitchPayload } from "./payload";

/** What this app holds when an arrival is taken up: a live pairing, by its digest (`sender.ts`). */
export type ReceiverHolds = { readonly k: "live"; readonly digest: string | null };

export type ArrivalStep =
  | { readonly act: "go"; readonly to: { readonly to: "event" | "message"; readonly id: string } }
  | { readonly act: "stay"; readonly why: "last" | "otherAccount" | "malformed" };

/** `from` is the sender's app: this app's sibling. */
export function stepArrival(payload: SwitchPayload, holds: ReceiverHolds, from: "ohmail" | "ohcal"): ArrivalStep {
  if (payload.k !== "open") return { act: "stay", why: "malformed" };
  const place = decodePlace(payload.p, from);
  if (place === null) return { act: "stay", why: "malformed" };
  if (payload.d === undefined || holds.digest === null || payload.d !== holds.digest) return { act: "stay", why: "otherAccount" };
  return place.to === "last" ? { act: "stay", why: "last" } : { act: "go", to: place };
}
