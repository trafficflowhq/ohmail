/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import {
  ISO, act, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv,
  tick,
} from "./fixtures/live-walk-shell";

/**
 * TAG — one tag, across everything, read WITHOUT leaving it, and managed from its own page.
 *
 * What only the rendered tag page can be wrong about:
 *
 *   1. a row reads IN PLACE — the route stays on the tag, it does not jump to the message's
 *      home view (the aliasing that was objected to);
 *   2. the page IS the two-pane layout — no mode to pick — and a row reads in the column
 *      rather than in a sheet;
 *   3. Rename and Delete are present, and Delete STATES THE COUNT and that the mail stays put
 *      BEFORE it asks — the two-step the Settings pane and the rules pane also hold.
 *
 * The WIRE for `tag_rename`/`tag_delete` is proven in `packages/client-engine`; this is about
 * the surface. The fixture tags two ordinary Ohbox messages, so the OLD `openMessage` row would
 * have navigated to the Ohbox — which is exactly what assertion 1 watches for.
 */

const message = (o: { id: string; from: string; labels?: string[]; subject?: string }, seq: number) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1",
    threadId: null, messageIdHeader: null,
    subject: o.subject ?? `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: [], cc: [], date: ISO, folder: "INBOX",
    snippet: `snippet of ${o.id}`, unread: false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: o.labels ?? [], remoteContent: "none", updatedAt: ISO,
  },
});

const rule = (address: string, seq: number) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
    provenance: "seeded-from-sent", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  },
});

const tag = (id: string, name: string, seq: number) => ({
  type: "tag", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, hue: "moss", createdAt: ISO, updatedAt: ISO },
});

const world = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          tag("tg1", "Invoices", 1),
          // Consented sender ⇒ these present in the Ohbox. Their home view is NOT the tag, which
          // is what makes "the route stays on the tag" a real assertion.
          rule("friend@example.invalid", 2),
          message({ id: "tg-a", from: "friend@example.invalid", labels: ["tg1"] }, 3),
          message({ id: "tg-b", from: "friend@example.invalid", labels: ["tg1"] }, 4),
          // An untagged sibling, to prove the list is the tag's and not the whole Ohbox.
          message({ id: "plain", from: "friend@example.invalid" }, 5),
          tag("tg2", "Travel", 6),
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c1", hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const list = () => screen.getByRole("listbox", { name: "Invoices" });
const row = (id: string) => within(list()).getByRole("option", { name: `Sender ${id}: subject of ${id}` });
const column = (name: string) => within(screen.getByRole("region", { name }));
const messages = () => column("Messages");

const click = async (control: HTMLElement): Promise<void> => {
  await act(async () => { control.click(); await Promise.resolve(); });
  await tick(0);
};

async function openTag(id = "tg1") {
  await mountShell([mailbox({ lastSyncAt: ISO })]);
  await tick(0);
  await goTo(`tag/${id}`);
}

async function listMenu() {
  await click(messages().getByRole("button", { name: "List" }));
  return within(screen.getByRole("menu", { name: "List" }));
}

describe("Tag view", () => {
  beforeEach(() => {
    installShellEnv();
    answerSyncWith(world);
  });
  afterEach(teardownShellEnv);

  it("lists only the tagged mail, under the tag's name", async () => {
    await openTag();
    expect(messages().getByRole("heading", { name: "Invoices" })).toBeTruthy();
    expect(row("tg-a")).toBeTruthy();
    expect(row("tg-b")).toBeTruthy();
    expect(within(list()).queryByRole("option", { name: /subject of plain/ })).toBeNull();
  });

  it("states when nothing carries the tag", async () => {
    await openTag("tg2");
    expect(messages().getByRole("heading", { name: "Travel" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Messages" }).textContent).toContain("Nothing tagged");
    expect(messages().queryByRole("option")).toBeNull();
  });

  it("reads a row IN PLACE — the route stays on the tag, it does not jump to the Ohbox", async () => {
    await openTag();
    await click(row("tg-a"));

    // `openMessage` would have set the hash to `#/ohbox`. The reader-in-place keeps the tag up,
    // and the address names the letter on the tag's route.
    expect(window.location.hash).toBe("#/tag/tg1/m/tg-a");
    expect(column("Reading").getByRole("heading", { name: "subject of tg-a" })).toBeTruthy();
  });

  it("is the two-pane layout on arrival, with no mode to pick, and a row reads in the column", async () => {
    await openTag();
    expect(messages().getByRole("listbox", { name: "Invoices" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Reading" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Split" })).toBeNull();
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-haspopup")).toBe("menu");

    await click(row("tg-b"));

    expect(window.location.hash).toBe("#/tag/tg1/m/tg-b");
    expect(column("Reading").getByRole("heading", { name: "subject of tg-b" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Reading" })).toBeNull();
  });

  it("offers Rename and Delete, and Delete states the count and what survives BEFORE it asks", async () => {
    await openTag();
    const address = window.location.hash;
    expect(address).toMatch(/^#\/tag\/tg1(?:\/m\/[^/]+)?$/);
    const menu = await listMenu();
    expect(menu.getByRole("menuitem", { name: "Rename" })).toBeTruthy();

    // The first Delete opens the confirm — it must NOT delete on the first press. The count is
    // the number of tagged messages, and the sentence about the mail is on screen before the ask.
    await click(menu.getByRole("menuitem", { name: "Delete" }));
    expect(window.location.hash, "the first press only asks").toBe(address);
    const ask = within(screen.getByRole("dialog", { name: /Delete Invoices/ }));
    expect(ask.getByText("2 messages carry it and stay where they are.")).toBeTruthy();
    expect(ask.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("Rename opens a field starting from the current name", async () => {
    await openTag();
    const menu = await listMenu();
    await click(menu.getByRole("menuitem", { name: "Rename" }));
    const head = screen.getByRole("heading", { name: "Invoices" }).closest("header")!;
    expect(within(head).getByRole("textbox", { name: "Name" })).toHaveProperty("value", "Invoices");
    expect(screen.queryByRole("dialog", { name: /Rename Invoices/ })).toBeNull();
  });
});
