/**
 * THE MIRROR AS THE LISTS PRESENT IT, handed to the reading column beside the list's visit. A reply the presentation
 * holds at the gate (a sender nobody decided on, still in INBOX on the mail server), a letter inside its delete
 * window, a routing press held for its Undo: the column reads them where the lists show them, never off the raw
 * mirror. Bodies, hydration and every mutation keep the raw mirror. Null: nobody handed one, and the column fails
 * closed (no letter loads a remote picture by itself).
 */
import { createContext, useContext, type Context } from "react";
import {
  presentAt,
  presentationReader,
  type ConsentPartition,
  type EntityReader,
  type Folder,
} from "@ohmail/client-engine";
import { hideMessages } from "../press/delete-undo.js";

export const PresentedMirrorContext: Context<EntityReader | null> = createContext<EntityReader | null>(null);

/**
 * The presented mirror a shell handed, or null where none was. It belongs to the reading column alone: its null arm
 * is the column's fail-closed on a host that hands a reader and no ground. A place reads `usePresented()`.
 */
export function usePresentedMirror(): EntityReader | null {
  return useContext(PresentedMirrorContext);
}

/**
 * The mirror as the lists present it, as the ground stands it above every pane. Throws where none stands: a place
 * never reads the raw mirror in its place.
 */
export function usePresented(): EntityReader {
  const mirror = useContext(PresentedMirrorContext);
  if (mirror === null)
    throw new Error("usePresented: no presented mirror stands above (PresentedMirrorContext)");
  return mirror;
}

/**
 * The web shell's composition of the presented mirror, written once: the consent partition's places (none in the
 * demo), minus every letter inside its delete window, with each held routing press shown where it was filed.
 */
export function presentedOver(
  raw: EntityReader,
  partition: ConsentPartition | null,
  held: ReadonlySet<string>,
  places: ReadonlyMap<string, Folder>,
): EntityReader {
  return presentAt(hideMessages(partition ? presentationReader(raw, partition) : raw, held), places);
}
