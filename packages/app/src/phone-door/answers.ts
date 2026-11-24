/**
 * WHAT A STEP'S REQUEST CAME BACK WITH, read by its shape, and whether the step is still there to take it: the
 * pairing code sent from a blank (by hand and the scan's link by hand), the offer it answered, and a step's life.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { PhoneDoor, PhoneOffer, SaidRefusal } from "./contract.js";

/** What a press came back with: a ticket to confirm, or a refusal (null: no sentence crossed). */
export type Handed =
  | { readonly k: "offers"; readonly offer: Extract<PhoneOffer, { k: "offers" }> }
  | { readonly k: "refused"; readonly said: SaidRefusal | null };

/** An offer read by its shape: a ticket with its facts, or a refusal with its words; anything else is no answer. */
export function handedOf(offer: PhoneOffer | null | undefined): Handed {
  if (offer?.k === "offers" && typeof offer.ticket === "string" && typeof offer.facts?.address === "string")
    return { k: "offers", offer };
  if (offer?.k === "refused" && typeof offer.said?.code === "string")
    return { k: "refused", said: offer.said };
  return { k: "refused", said: null };
}

/**
 * The pairing code in a blank, sent once: taken out of the blank before the request leaves, never kept. A `link`
 * pasted into another blank goes as the token in its place, and the code's blank is emptied all the same.
 */
export async function sendCode(
  door: PhoneDoor,
  address: string | null,
  blank: RefObject<HTMLInputElement | null>,
  link?: string,
): Promise<Handed> {
  const field = blank.current;
  const token = link ?? field?.value ?? "";
  if (field) field.value = "";
  try {
    return handedOf(await door.hand({ address, token }));
  } catch {
    return { k: "refused", said: null };
  }
}

/** Mounted or gone: an answer that lands after its step is gone is dropped. */
export function useLive(): RefObject<boolean> {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return live;
}
