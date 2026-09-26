/**
 * THE SHELL RELOADED THIS WINDOW BECAUSE ITS WEB PROCESS DIED, and marked the address to say so
 * (`src-tauri/src/renderer_recovery.rs`, `RELOADED_MARK`). The mark is taken once, before the
 * first render, and the address is put back without it so a later reload says nothing.
 */
import { useEffect } from "react";
import { useToast } from "@ohmail/ui";

import { DOOR_COPY } from "./door-copy.js";

export const RELOADED_PARAM = "renderer";
export const RELOADED_VALUE = "reloaded";

interface Place {
  search: string;
  pathname: string;
  hash: string;
}
interface Entries {
  state: unknown;
  replaceState(data: unknown, unused: string, url?: string): void;
}

/** True once when the address carries the mark; the mark is removed, the view (hash) kept. */
export function takeReloadedMark(place: Place = location, entries: Entries = history): boolean {
  const params = new URLSearchParams(place.search);
  if (params.get(RELOADED_PARAM) !== RELOADED_VALUE) return false;
  params.delete(RELOADED_PARAM);
  const rest = params.toString();
  entries.replaceState(entries.state, "", `${place.pathname}${rest ? `?${rest}` : ""}${place.hash}`);
  return true;
}

/** The one sentence. Inside the toast host (a polite live region) and the language provider. */
export function RendererReloaded({ reloaded }: { reloaded: boolean }): null {
  const toast = useToast();
  useEffect(() => {
    if (reloaded) toast(DOOR_COPY.rendererReloaded, { duration: 8000 });
  }, [reloaded, toast]);
  return null;
}

