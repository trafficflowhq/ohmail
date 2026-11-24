/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb,
  teardownScreeningWeb, tick, warmScreeningWeb,
} from "./fixtures/screening-web.js";

/**
 * "N MESSAGES FROM SENDERS YOU HAVE NOT DECIDED ABOUT ARE STILL IN THE INBOX ON YOUR MAIL SERVER"
 * — THE ROW A PERSON PRESSES.
 *
 * Mail that arrived before the screening gate existed sits in the server's Inbox from senders
 * nobody ever decided about. The answer is not a repair that runs on its own: it is a row in this
 * header that states how much there is and does nothing until somebody presses it.
 *
 * Four claims, each a way the row could lie:
 *
 *  1. IT STATES THE SERVER'S NUMBER, AND WHERE THAT MAIL IS. The set is the arrival gate's own
 *     answer, which no client can work out, so the figure is the door's. The Ohbox never lists
 *     that mail (unruled INBOX mail presents at the gate or in History), so the row names the
 *     server's Inbox — measured on a self-hosted install: 299 said "in your Ohbox", 0 drawn there.
 *  2. IT MOVES NOTHING UNTIL THE PRESS. The Ohbox is arrival-ordered and a READ never moves a row
 *     (owner ruling 2026-09-18); this is a press, and what reaches the door is the press made.
 *  3. IT GOES THROUGH THE ENGINE THE PRODUCT BUILDS. `createEngine` wraps the transport in an
 *     explicit object literal and both capabilities are optional, so `satisfies` would accept the
 *     omission — the shape that left the held-release row unrenderable on the web for two releases.
 *  4. A DOOR WITH NOTHING TO OFFER DRAWS NO ROW — never a row stating zero.
 */

function waiting(id: string, from: string, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-22T08:00:00.000Z",
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-09-22T08:00:00.000Z",
  };
}

interface Door {
  groups: Array<{ address: string; count: number; newestAt: string }>;
  total: number;
  /** False: the server's walk stopped at its bound, so `total` is a floor. */
  complete?: boolean;
}

const scoped = { headers: { "X-Ohmail-Account": ACCOUNT } };
const endpoint = "/api/screener/unscreened";
let host: HTMLElement;
let calls: string[];
let presses: Array<readonly string[] | undefined>;

beforeAll(warmScreeningWeb, 30_000);
beforeEach(() => { calls = []; presses = []; });
afterEach(teardownScreeningWeb);

async function mount(door: Door | null): Promise<void> {
  const letter = waiting("m0", "stranger@example.test");
  installScreeningWeb("#/screener", (path, query, method, init) => {
    if (path === "/api/mailboxes") return Response.json({ items: [{
      id: letter.mailboxId, address: ["fixture", "mailbox.example"].join("@"), status: "connected", organizerRole: "organizer", organizerChecked: true,
      createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
    }] });
    if (path === "/api/sync") return query.get("types") === "rule"
      ? syncScreeningWeb([], 0)
      : syncScreeningWeb([{ type: "message", op: "create", id: letter.id, seq: 1, updatedAt: letter.updatedAt, entity: letter }], 1);
    if (path !== endpoint) return undefined;
    calls.push(`${method} ${path}`);
    if (!door) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { addresses?: string[] };
      presses.push(body.addresses);
      return Response.json({ screened: door.groups, total: door.total }, scoped);
    }
    return Response.json({ ...door, max: 200 }, scoped);
  });
  host = await mountScreeningWeb();
  await tick(3000);
}

const leadPattern = /^(?:At least )?\d+ messages? from /;
const lead = () => within(host).queryByText(leadPattern, { selector: "b" });
const row = () => within(host).queryAllByRole("status").find((notice) => within(notice).queryByText(leadPattern, { selector: "b" })) ?? null;
const pressButton = () => within(host).getByRole("button", { name: /^Screen \d+$/ });

const DOOR: Door = {
  groups: [
    { address: "paper@paper.test", count: 9, newestAt: "2024-03-01T08:00:00.000Z" },
    { address: "bills@paper.test", count: 3, newestAt: "2024-02-01T08:00:00.000Z" },
  ],
  total: 12,
};

describe("the row renders through the engine the product actually builds", () => {
  it("draws the row from the wire and presses back through it", async () => {
    await mount(DOOR);
    expect(calls, "the row never asked the door").toContain("GET /api/screener/unscreened");
    const text = lead()?.textContent ?? "";
    expect(text, "the undecided-sender row did not render on the live path").toContain("12");
    await act(async () => { pressButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick(1500);
    expect(calls, "the press never reached the door").toContain("POST /api/screener/unscreened");
  });

  it("a total the server's walk stopped at is said as a floor, off the wire", async () => {
    await mount({ ...DOOR, complete: false });
    expect(lead()?.textContent).toBe(
      "At least 12 messages from senders you have not decided about are still in the Inbox on your mail server",
    );
  });
});

describe("the undecided-sender row in the Screener header", () => {
  it("states the server's number and says what it is about", async () => {
    await mount(DOOR);
    const text = lead()?.textContent ?? "";
    expect(text).toContain("12");
    expect(text.toLowerCase()).toContain("not decided about");
    expect(text.toLowerCase()).toContain("inbox on your mail server");
    expect(text.toLowerCase(), "the Ohbox never lists this mail").not.toContain("ohbox");
  });

  it("is one sentence and one verb — no per-sender list to read", async () => {
    await mount(DOOR);
    expect((row()?.textContent ?? "")).not.toContain("paper.test");
    expect(pressButton().textContent).toContain("Screen 12");
  });

  it("moves nothing until the press, and then presses for every group shown", async () => {
    await mount(DOOR);
    expect(presses, "a READ moved somebody's mail").toEqual([]);
    await act(async () => { pressButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick(1500);
    expect(presses).toEqual([undefined]);
  });

  it("a floor says 'at least', and the press names what it moves", async () => {
    await mount({ ...DOOR, total: 40, complete: false });
    expect(lead()?.textContent).toBe(
      "At least 40 messages from senders you have not decided about are still in the Inbox on your mail server",
    );
    expect(pressButton().textContent).toContain("Screen 40");
    await teardownScreeningWeb();
    await mount({ ...DOOR, complete: true });
    expect(lead()?.textContent).toMatch(/^12 messages/);
  });

  /** A door with nothing to offer draws NO ROW — never a row stating zero. */
  it("draws no row when the door offers nothing", async () => {
    await mount(null);
    expect(row()).toBeNull();
  });

  it("draws no row when the door answers an empty set", async () => {
    await mount({ groups: [], total: 0 });
    expect(row()).toBeNull();
  });
});
