/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADDRESS, routeOf, useFrame } from "@ohmail/app/frame";
import { mailPlaces } from "@ohmail/app/mail";
import * as room from "../../../packages/app/src/frame/room.js";
import { json } from "./account/account-harness";
import {
  act, closeMailPage, inboxPage, MAILBOX, mountMailPage, prepareMailPage, scopedSyncResponse, tick,
} from "./fixtures/mounted-mail-page";

const WORK = { ...MAILBOX, displayName: "Work" };
const HOME = { ...MAILBOX, id: "mb_home", address: ["home", "mail.invalid"].join("@"), displayName: "Home" };
const BOXES = [WORK, HOME];
const FOLDERS = ["ohmail/News", "ohmail/Receipts", "ohmail/Screener", "INBOX", "Trash", "Archive"];

afterEach(() => {
  vi.restoreAllMocks();
  closeMailPage();
});

async function mountedDeliveries(withhold?: string) {
  const inbox = await inboxPage(FOLDERS.length * BOXES.length).json();
  const [rule, ...letters] = inbox.changes.creates;
  const rows = letters.map((row: (typeof letters)[number], index: number) => {
    const box = BOXES[index % BOXES.length]!;
    const folder = FOLDERS[Math.floor(index / BOXES.length)]!;
    const name = `Delivery ${index + 1}`;
    return {
      ...row, entity: { ...row.entity, mailboxId: box.id, folder, subject: name,
        from: folder === "INBOX" ? row.entity.from : { name, address: [`sender-${index}`, "mail.invalid"].join("@") },
      },
    };
  });
  if (withhold) {
    const real = room.useMailboxWord;
    vi.spyOn(room, "useMailboxWord").mockImplementation(() => {
      const resolve = real();
      return useFrame().route.place === withhold ? () => null : resolve;
    });
  }
  await prepareMailPage({
    "GET /api/mailboxes": () => json({ items: BOXES }),
    "GET /api/sync": () => scopedSyncResponse({ ...inbox, changes: { ...inbox.changes, creates: [rule, ...rows] } }),
  });
  const page = await mountMailPage();
  const mounted = new Map<string, Array<{ name: string; actual: string | undefined; expected: string }>>();
  for (const id of labelPlaces()) {
    const fragment = `#/${ADDRESS[id]}`;
    expect(routeOf(fragment).place).toBe(id);
    await act(async () => { window.location.hash = fragment; });
    await tick(0);
    const options = rows.flatMap(({ entity }: (typeof rows)[number]) => {
      const option = page.queryByRole("option", { name: new RegExp(`\\b${entity.subject}(?:\\b|$)`) });
      if (!option) return [];
      const mailbox = BOXES.find(({ id }) => id === entity.mailboxId)!;
      return [{ name: entity.subject, actual: within(option).queryByTitle(/^Delivered to /)?.title,
        expected: `Delivered to ${mailbox.displayName}` }];
    });
    mounted.set(id, options);
  }
  return mounted;
}

function labelPlaces() {
  const registered = mailPlaces();
  return (Object.keys(ADDRESS) as Array<keyof typeof ADDRESS>).filter((id) => registered[id]?.rowMailboxLabels);
}

function assertLabels(rows: Awaited<ReturnType<typeof mountedDeliveries>>) {
  expect([...rows.keys()]).toEqual(labelPlaces());
  for (const [place, options] of rows) {
    expect(options.map(({ expected }) => expected)).toEqual(expect.arrayContaining(BOXES.map((box) => `Delivered to ${box.displayName}`)));
    for (const { name, actual, expected } of options) expect(actual, `${place}: ${name}`).toBe(expected);
  }
}

describe("the shell hands the mailbox label to every view that can draw it", () => {
  it("the derived set is the two views that take the prop — never empty", async () => {
    const mounted = await mountedDeliveries();
    expect([...mounted.keys()]).toEqual(expect.arrayContaining(["news", "screener"]));
    assertLabels(mounted);
  });

  it("each is passed the shell's one resolver", async () => {
    const mounted = await mountedDeliveries();
    expect(mounted.size).toBeGreaterThan(0);
    assertLabels(mounted);
  });

  it("…and a render without the attribute is what it refuses", async () => {
    const mounted = await mountedDeliveries("news");
    expect(mounted.get("news")).toHaveLength(2);
    expect(mounted.get("news")!.every(({ actual }) => actual === undefined)).toBe(true);
    expect(() => assertLabels(mounted)).toThrow(/news: Delivery/);
  });
});
