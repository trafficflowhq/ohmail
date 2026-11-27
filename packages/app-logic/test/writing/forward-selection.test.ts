/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { EntityReader } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import {
  forwardSourcesOf,
  loadForwardSources,
  selectedMessages,
  selectionSubject,
} from "../../src/writing/forward-selection.js";

const message = (id: string, subject: string, day: number, threadId: string | null = null) =>
  ({
    id,
    subject,
    threadId,
    from: { name: "Workshop sender" },
    folder: "INBOX",
    date: new Date(Date.UTC(2026, 1, day, 9)).toISOString(),
  }) as EngineMessage;

function readOf(messages: EngineMessage[]): EntityReader {
  return {
    get: (entity: string, id: string) =>
      entity === "message" ? messages.find((message) => message.id === id) : undefined,
    list: (entity: string) => (entity === "message" ? messages : []),
  } as EntityReader;
}

const first = message("first", "Plans", 1, "workshop");
const second = message("second", "Plans", 2, "workshop");
const third = message("third", "Materials", 3);
const read = readOf([first, second, third]);

describe("messages selected for forwarding", () => {
  it("orders delayed originals by their message dates", () => {
    const delayed = { ...first, sortAt: "2026-02-05T09:00:00.000Z" };
    const newer = { ...second, sortAt: second.date };
    expect(selectedMessages(readOf([newer, delayed]), [newer, delayed], [])).toEqual([delayed, newer]);
  });

  it("takes the whole selected conversation once and orders the originals by date", () => {
    const picked = selectedMessages(read, [third, first, first], [first.id]);
    expect(picked).toEqual([first, second, third]);
    expect(selectionSubject(picked, () => "3 messages")).toBe("Fwd: 3 messages");
    expect(selectionSubject(picked.slice(0, 2), () => "2 messages")).toBe("Fwd: Plans");
    expect(selectedMessages(read, [second], [])).toEqual([second]);
  });

  it("returns original bytes as separate message attachments within the remaining cap", async () => {
    const raw = "Subject: Plans\r\n\r\nOriginal wording.\r\n";
    const fetch = vi.fn(async (_id: string, _maxBytes: number) => new Blob([raw]));
    const files = await loadForwardSources(
      forwardSourcesOf([first, third], () => "No subject"),
      raw.length * 2,
      fetch,
      () => true,
    );
    expect(fetch.mock.calls).toEqual([
      [first.id, raw.length * 2],
      [third.id, raw.length],
    ]);
    expect(files).toEqual(
      [first, third].map((message) => ({
        filename: `Workshop sender — ${message.subject}.eml`,
        contentType: "message/rfc822",
        contentBase64: btoa(raw),
      })),
    );
  });

  it("refuses an oversized selection before reading any further original", async () => {
    const fetch = vi.fn(async () => new Blob(["more than one byte"]));
    await expect(
      loadForwardSources(
        forwardSourcesOf([first, third], () => "No subject"),
        1,
        fetch,
        () => true,
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a reopened original whose bytes differ from the saved copy", async () => {
    const [source] = forwardSourcesOf([first], () => "No subject");
    const sha256 = createHash("sha256").update("Saved original").digest("hex");
    await expect(
      loadForwardSources(
        [{ ...source!, sha256 }],
        100,
        async () => new Blob(["Different original"]),
        () => true,
      ),
    ).rejects.toThrow("Original message changed");
  });
});
