/**
 * What the tests share. Nothing here calls the package: an expected instant is written as text and
 * read by the platform's own date parser, so no expectation is worked out by the code under test.
 */
import type { Fixture } from "./corpus/types.js";

/** A fixture's text as a file carries it: CRLF after every line. */
export const text = (f: Fixture): string => f.lines.map((l) => `${l}\r\n`).join("");

/** `2026-12-02T18:00:00Z` as milliseconds since the epoch. */
export const at = (iso: string): number => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !iso.endsWith("Z")) throw new Error(`not a UTC instant: ${iso}`);
  return ms;
};

/** Milliseconds as `2026-12-02T18:00:00Z`, for a failure that reads as a calendar. */
export const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

/** The text a writer gave; a test that expected text fails with the writer's own word when it gave none. */
export const textOf = (written: { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }): string => {
  if (!written.ok) throw new Error(`not written: ${written.reason}`);
  return written.text;
};

/** A calendar holding one event with these lines, for a rule that needs nothing else around it. */
export const oneEvent = (eventLines: readonly string[], extra: readonly string[] = []): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//corpus//EN", ...extra, "BEGIN:VEVENT", "UID:corpus-1@atelier.example", "DTSTAMP:20261113T120000Z", ...eventLines, "END:VEVENT", "END:VCALENDAR"]
    .map((l) => `${l}\r\n`)
    .join("");
