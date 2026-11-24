"use client";

/**
 * IS THE SERVER THIS SHELL READS THE MANAGED SERVICE? One fact, stated by the host that mounts the
 * shell — the browser build by its flavor, the desktop by its door's origin — because `app/shell`
 * carries no build flavor of its own. It decides two sentences: what an unnamed server holder is
 * called, and whether a credit price is said. They are one fact because the managed service is the
 * only host that meters AI: the open server composes `UNMETERED` and the desktop engine no spend port.
 * Absent reads as managed — the shipped wording, and never a spend offered without its price.
 */
import { createContext, useContext } from "react";

export const ManagedServiceContext = createContext<boolean>(true);

export function useManagedService(): boolean {
  return useContext(ManagedServiceContext);
}
