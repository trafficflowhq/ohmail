/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEED_SINCE_ID, MemoryMirrorStore, waterlineIdOf } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import {
  issue,
  mountStreamFrame as seat,
  receipt,
} from "../../../packages/app/test/streams/registered-world.js";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

describe("no visit yet in this browser: a read letter filed on top", () => {
  const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 7, 10, hour, minute)).toISOString();
  const dated = (message: EngineMessage, hour: number, minute = 0) => {
    const date = at(hour, minute);
    return { ...message, date, arrivedAt: date, updatedAt: date };
  };
  const warmMirror = async (letters: EngineMessage[], syncedAt?: string) => {
    const mirror = new MemoryMirrorStore();
    await mirror.load();
    await mirror.applyChanges(
      letters.map((entity, i) => ({
        type: "message",
        op: "create",
        id: entity.id,
        seq: i + 1,
        updatedAt: entity.updatedAt,
        entity,
      })),
    );
    if (syncedAt) await mirror.putLocal("view_meta", FEED_SINCE_ID, { at: syncedAt });
    return mirror;
  };
  const moveIn = async (
    mirror: MemoryMirrorStore,
    message: EngineMessage,
    folder: EngineMessage["folder"],
    seq: number,
  ) => {
    await mirror.applyChanges([
      {
        type: "message",
        op: "update",
        id: message.id,
        seq,
        updatedAt: message.updatedAt,
        entity: { ...message, folder },
      },
    ]);
  };
  const count = (place: "News" | "Receipts", text: string) => {
    const list = within(screen.getByRole("region", { name: place }));
    expect(within(list.getByRole("banner")).getByText(text)).toBeTruthy();
    return list;
  };

  it("News still says 2 new, and draws no line", async () => {
    const moved = dated(issue("w14", 10, { folder: "INBOX", unread: false }), 11, 43);
    const mirror = await warmMirror(
      [dated(issue("n1", 11), 11, 35), dated(issue("n2", 12), 11, 36), moved],
      at(11),
    );
    seat({ at: "#/reads", mirror });
    const before = count("News", "2 new since you were here");
    expect(before.queryByText(moved.subject!)).toBeNull();
    cleanup();

    await moveIn(mirror, moved, "ohmail/News", 4);
    const { mail } = seat({ at: "#/reads", mirror });
    const list = count("News", "2 new since you were here");
    expect(
      list
        .getAllByText(/^Issue /)[0]
        ?.closest("[data-id]")
        ?.getAttribute("data-id"),
    ).toBe("w14");
    expect(list.queryByText("Seen up to here")).toBeNull();
    expect(mail.mutations).toEqual([]);
  });

  it("Receipts still says 5 new, and draws no line", async () => {
    const moved = dated(
      receipt("w07", 10, { folder: "Sent" as EngineMessage["folder"], unread: false }),
      11,
      30,
    );
    const receipts = [1, 2, 3, 4, 5].map((i) => dated(receipt(`rc${i}`, i), 9, i));
    const mirror = await warmMirror([...receipts, moved], at(9));
    await moveIn(mirror, moved, "ohmail/Receipts", 7);
    const { mail } = seat({ at: "#/receipts", mirror });
    const list = count("Receipts", "5 new since you were here");
    expect(
      list
        .getAllByText(/^Order /)[0]
        ?.closest("[data-id]")
        ?.getAttribute("data-id"),
    ).toBe("w07");
    expect(list.queryByText("Seen up to here")).toBeNull();
    expect(mail.mutations).toEqual([]);
  });

  it("an imported pile of old unread mail names it on the first visit, and draws no line", async () => {
    const letters = Array.from({ length: 30 }, (_, i) => dated(issue(`old${i}`, 10), 1, i));
    const mirror = await warmMirror(letters, at(9));
    const { mail } = seat({ at: "#/reads", mirror });
    expect(count("News", "30 new since you were here").queryByText("Seen up to here")).toBeNull();
    expect(mail.mutations).toEqual([]);
  });

  it("control: a real visit draws the line, and nothing is new", async () => {
    const staged = dated(issue("w14", 10, { unread: false }), 11, 43);
    const mirror = await warmMirror([dated(issue("n1", 10, { unread: false }), 11, 35), staged]);
    await mirror.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: staged.id, at: at(11, 50) });
    const { mail } = seat({ at: "#/reads", mirror });
    const list = count("News", "Nothing new since you were here");
    expect(list.getAllByText("Seen up to here")).toHaveLength(1);
    expect(mail.mutations).toEqual([]);
  });
});
