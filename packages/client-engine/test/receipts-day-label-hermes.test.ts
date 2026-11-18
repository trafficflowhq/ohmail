/**
 * `receiptsByDay` on a runtime without `Intl.RelativeTimeFormat` — Hermes, the phone's engine.
 * Measured 2026-09-21: the day a receipt arrived, every iOS launch died in `WorldProvider` with
 * "undefined cannot be used as a constructor" — the day heading built the word "today" with an API
 * Hermes does not ship. The heading now takes the caller's own word, falls back to the platform's
 * where it exists and to the weekday where neither does; this file deletes the constructor for the
 * duration of a case and drives all three arms of that order, asking for a label, not an exception.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { FOLDER_OF_VIEW, receiptsByDay, type EntityReader } from "@ohmail/client-engine";

const NOW = new Date("2026-09-21T10:30:00.000Z");
const intl = Intl as unknown as Record<string, unknown>;
const saved = intl.RelativeTimeFormat;
afterEach(() => { intl.RelativeTimeFormat = saved; });

function readerOf(byType: Record<string, unknown[]>): EntityReader {
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) => (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({ id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i })),
    version: () => 1,
    /* This fixture's mirror never moves, so every stamp is the one version — the reader gained
       the pair for the window's narrow rebuild and nothing here derives against it. */
    stampOf: () => 1,
    stampExcept: () => 1,
  };
}
function receipt(id: string, date: string): EngineMessage {
  return {
    id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: id,
    from: { name: id, address: `${id}@example.test` }, to: [], cc: [], date, folder: FOLDER_OF_VIEW.receipts,
    snippet: "s", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as EngineMessage;
}
const weekday = (locale: string) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(NOW);

describe("receiptsByDay — a receipt dated today where Intl.RelativeTimeFormat is absent (Hermes)", () => {
  it("with the API: today is the platform's own word", () => {
    const r = readerOf({ message: [receipt("r1", NOW.toISOString())] });
    expect(receiptsByDay(r, NOW, "en", "UTC").map((g) => g.label)).toEqual(["Today"]);
    expect(receiptsByDay(r, NOW, "de", "UTC").map((g) => g.label)).toEqual(["Heute"]);
  });

  it("without the API: no throw, and today keeps its weekday's name in both languages", () => {
    delete intl.RelativeTimeFormat;
    expect(typeof Intl.RelativeTimeFormat).toBe("undefined");
    const r = readerOf({ message: [receipt("r1", NOW.toISOString()), receipt("r0", "2026-09-19T08:00:00.000Z")] });
    const en = receiptsByDay(r, NOW, "en", "UTC");
    expect(en.map((g) => g.label)).toEqual([weekday("en"), "Saturday"]);
    expect(en[0]?.items.map((m) => m.id)).toEqual(["r1"]);
    expect(receiptsByDay(r, NOW, "de", "UTC").map((g) => g.label)).toEqual([weekday("de"), "Samstag"]);
  });

  it("the caller's own word stands first, with the API and without it", () => {
    const r = readerOf({ message: [receipt("r1", NOW.toISOString())] });
    expect(receiptsByDay(r, NOW, "de", "UTC", { today: "heute" }).map((g) => g.label)).toEqual(["Heute"]);
    delete intl.RelativeTimeFormat;
    expect(receiptsByDay(r, NOW, "de", "UTC", { today: "heute" }).map((g) => g.label)).toEqual(["Heute"]);
  });
});
