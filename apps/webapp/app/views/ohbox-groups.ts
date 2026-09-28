import type { OhboxRow } from "@ohmail/client-engine";

/*
 * The Ohbox's rows are the ENGINE's fold (`foldOhboxRows`, `packages/client-engine/src/ohbox-rows.ts`),
 * one row per conversation across every section, and the phone draws the same one. The view keeps
 * this name for its signatures; there is no second fold here to import.
 */
export type OhboxRowGroup = OhboxRow;
