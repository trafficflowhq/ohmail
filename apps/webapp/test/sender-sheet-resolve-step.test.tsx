/** @vitest-environment jsdom */
import type { EngineMessage, RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { clickMounted, withMountedSender } from "./fixtures/mounted-sender-sheet.js";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb,
  teardownScreeningWeb, tick, warmScreeningWeb,
} from "./fixtures/screening-web.js";
import { UNDO_MS } from "@ohmail/app-logic/press/routing-undo";

/**
 * THE SHEET NAMES THE RULE THAT DISAGREES, AND THE PRESS WINS BY DEFAULT. A subject rule for the
 * pressed address filing elsewhere turns the press into a step: the rule is listed with the rows it
 * keeps, "All their mail" is chosen, Enter commits it, ↑/↓ changes the answer, and Escape goes back
 * to the list before it closes the sheet. No rule in the way: no step, the press commits.
 *
 * Which door a sheet press goes through (the planner alone, no sheet drawn) stands in
 * `sender-sheet-resolve-step-plan.test.ts`.
 */
const NOW = new Date("2026-09-25T13:00:00.000Z");
const ADDR = "alerts@kestrel.example";

function msg(id: string, o: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Invoice ready", from: { name: "Kestrel", address: ADDR }, to: [], cc: [],
    date: "2026-09-24T12:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T12:00:00.000Z", ...o,
  } as EngineMessage;
}

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-01T08:00:00.000Z", ...o,
  } as RuleDTO;
}

beforeAll(warmScreeningWeb, 30_000);
let mounted = false;
afterEach(async () => {
  if (mounted) await teardownScreeningWeb();
  mounted = false;
});

async function render(messages: EngineMessage[], rules: RuleDTO[], locale: "en" | "de" = "en") {
  const seed = messages[0]!;
  const words = locale === "de" ? de : en;
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let seq = messages.length + rules.length;
  installScreeningWeb(`#/ohbox/m/${seed.id}`, (path, query, method, init) => {
    if (path === "/api/mailboxes") return Response.json({ items: [{
      id: "mb", address: ["fixture", "mailbox.example"].join("@"), status: "connected",
      organizerRole: "organizer", organizerChecked: true, createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
    }] });
    if (path === "/api/sync") return query.get("types") === "rule"
      ? syncScreeningWeb(rules.map((rule, index) => ({
        type: "rule", op: "create", id: rule.id, seq: index + 1, updatedAt: rule.updatedAt, entity: rule,
      })), rules.length)
      : syncScreeningWeb(messages.map((message, index) => ({
        type: "message", op: "create", id: message.id, seq: index + rules.length + 1,
        updatedAt: message.updatedAt, entity: message,
      })), messages.length + rules.length);
    if (method !== "GET" && /^\/api\/(rules|messages)(?:\/|$)/.test(path)) {
      const headers = { "X-Ohmail-Account": ACCOUNT, "X-Sync-Seq": String(++seq) };
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      writes.push({ method, path, body });
      if (method === "DELETE") return new Response(null, { status: 204, headers });
      if (path.startsWith("/api/rules")) {
        const id = path === "/api/rules" ? "new-rule" : path.split("/").at(-1)!;
        return Response.json({ ...rule({ id, destination: "INBOX" }), ...body }, { status: 201, headers });
      }
      const message = messages.find(({ id }) => path === `/api/messages/${id}/move`);
      if (message) return Response.json({ ...message, folder: body.folder }, { headers });
    }
    return undefined;
  });
  mounted = true;
  vi.setSystemTime(NOW);
  const frame = within(await mountScreeningWeb(locale));
  await tick(4000);
  const reader = within(frame.getByRole("region", { name: words.frame.landmark.reading }));
  await clickMounted(reader.getByRole("button", { name: /^Kestrel / }));
  const page = within(document.body);
  const contact = within(page.getByRole("dialog", { name: words.message.contactAria.replace("{who}", "Kestrel") }));
  await clickMounted(contact.getByRole("menuitem", { name: words.screening.action }));
  const name = words.screening.aria.replace("{sender}", ADDR);
  const el = page.getByRole("dialog", { name });
  return {
    el,
    open: () => page.queryByRole("dialog", { name }) !== null,
    ruleWrites: () => writes.filter(({ path }) => path.startsWith("/api/rules")),
  };
}

const press = clickMounted;
const key = async (node: HTMLElement, k: string) => {
  await act(async () => { node.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
};
const ohbox = (el: HTMLElement) => within(el).getByRole("option", { name: /^Ohbox/ });
const choices = (el: HTMLElement) => within(el).getByRole("radiogroup", { name: en.screening.resolveChoiceAria });
const tilesOf = (el: HTMLElement) => within(choices(el)).getAllByRole("radio");
const ruleForOhbox = expect.objectContaining({
  body: expect.objectContaining({ destination: "INBOX", applyRetro: true }),
});

const owner = () => [
  [msg("plain"), msg("mon", { subject: "[Monitor] disk at 91%", folder: "ohmail/News" })],
  [rule({ id: "bare", destination: "INBOX", createdAt: "2026-07-01T08:00:00.000Z" }),
    rule({ id: "term", destination: "ohmail/News", subjectContains: "[Monitor]" })],
] as const;

describe("the sheet lists the rules in play", () => {
  it("both rules, each with the rows it places, under Their rules", async () => {
    const [m, r] = owner();
    const { el } = await render([...m], [...r]);
    const lines = [...el.querySelectorAll(".sm-rules .sm-rule-line")].map((n) => n.textContent);
    expect(el.querySelector(".sm-rules-head")?.textContent).toBe("Their rules");
    // The router's order, the winner first: a term outranks the bare rule it narrows.
    expect(lines).toEqual(["Subject contains »[Monitor]« → News1", "All their mail → Ohbox1"]);
    expect(el.querySelector(".sm-now")?.textContent).toBe("2 messages — Ohbox 1 · News 1");
  });

  it("a single bare rule says nothing new", async () => {
    const { el } = await render([msg("plain")], [rule({ id: "bare", destination: "INBOX" })]);
    expect(el.querySelector(".sm-rules")).toBeNull();
  });
});

describe("the resolve step", () => {
  it("pressing the Ohbox over their subject rule asks, with All chosen, and Enter commits it", async () => {
    const [m, r] = owner();
    const { el, ruleWrites } = await render([...m], [...r]);
    await press(ohbox(el));
    expect(ruleWrites(), "the press committed over a rule that disagrees").toEqual([]);
    const step = el.querySelector(".sm-resolve");
    expect(step?.querySelector("p")?.textContent).toBe("Ohbox — one of your rules says otherwise");
    const tiles = tilesOf(el);
    expect(tiles.map((n) => n.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(tiles[0]!.textContent).toContain("All their mail → Ohbox");
    expect(tiles[0]!.textContent).toContain("2 messages");
    expect(tiles[1]!.textContent).toContain("Keep the split");
    expect(document.activeElement, "focus is on the chosen tile").toBe(tiles[0]);
    await key(choices(el), "Enter");
    await tick(UNDO_MS + 500);
    expect(ruleWrites().filter(({ method }) => method === "DELETE"))
      .toEqual([{ method: "DELETE", path: "/api/rules/term", body: {} }]);
    expect(ruleWrites().filter(({ method }) => method !== "DELETE")).toHaveLength(1);
  });

  it("↓ chooses Keep the split, and it is what commits", async () => {
    const [m, r] = owner();
    const { el, ruleWrites } = await render([...m], [...r]);
    await press(ohbox(el));
    await key(choices(el), "ArrowDown");
    expect(tilesOf(el).map((n) => n.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    await press(within(el).getByRole("button", { name: "File to Ohbox" }));
    await tick(UNDO_MS + 500);
    expect(ruleWrites().filter(({ method }) => method === "DELETE")).toEqual([]);
  });

  it("Escape steps back to the list and hands focus back to the destination; a second Escape closes", async () => {
    const [m, r] = owner();
    const { el, open } = await render([...m], [...r]);
    await press(ohbox(el));
    await key(tilesOf(el)[0]!, "Escape");
    expect(open(), "Escape in the step closed the sheet").toBe(true);
    expect(el.querySelector(".sm-resolve")).toBeNull();
    expect(document.activeElement).toBe(ohbox(el));
    await key(ohbox(el), "Escape");
    expect(open(), "Escape on the list must close the sheet").toBe(false);
  });

  it("no rule in the way: no step, the press commits at once", async () => {
    const { el, ruleWrites } = await render([msg("plain")], [rule({ id: "bare", destination: "ohmail/News" })]);
    await press(ohbox(el));
    expect(el.querySelector(".sm-resolve")).toBeNull();
    expect(within(document.body).getByRole("button", { name: "Undo" })).toBeTruthy();
    await tick(UNDO_MS + 500);
    expect(ruleWrites()).toEqual([ruleForOhbox]);
  });

  it("a higher-priority domain rule: the exception is the default, and says who stays", async () => {
    const wide = rule({ id: "dom", kind: "domain", match: "kestrel.example", destination: "ohmail/Screened", priority: 5 });
    const { el, ruleWrites } = await render([msg("m1")], [wide]);
    await press(ohbox(el));
    const tiles = tilesOf(el);
    expect(tiles[0]!.textContent).toContain("Only this address → Ohbox");
    expect(tiles[0]!.textContent).toContain("Everyone else at kestrel.example stays in Screened out");
    await key(choices(el), "Enter");
    await tick(UNDO_MS + 500);
    expect(ruleWrites()).toEqual([expect.objectContaining({
      method: "POST", body: expect.objectContaining({ kind: "sender", match: ADDR, destination: "INBOX" }),
    })]);
  });

  it("the German step at the longest title", async () => {
    const wide = rule({ id: "dom", kind: "domain", match: "kestrel.example", destination: "ohmail/Screened", priority: 5 });
    const { el } = await render([msg("m1")], [wide], "de");
    await press(ohbox(el));
    expect(el.querySelector(".sm-resolve p")?.textContent).toContain("deine Regel für alle bei kestrel.example");
  });
});

describe("no address press past the gate reaches the wire outside the window", () => {
  it("changeScreening hands the window path to the held press before any dispatch", async () => {
    await withMountedSender(async ({ sheet, writes, sender }) => {
      await clickMounted(sheet.getByRole("option", { name: /^Ohbox/ }));
      expect(within(document.body).getByRole("button", { name: "Undo" })).toBeTruthy();
      expect(writes.filter(({ path }) => path.startsWith("/api/rules"))).toEqual([]);
      await tick(UNDO_MS + 500);
      expect(writes.filter(({ path }) => path.startsWith("/api/rules"))).toEqual([{
        method: "POST", path: "/api/rules",
        body: expect.objectContaining({ kind: "sender", match: sender, destination: "INBOX", applyRetro: true }),
      }]);
    });

    await withMountedSender(async ({ sheet, writes }) => {
      await clickMounted(sheet.getByRole("radio", { name: /^Everyone at sender\.example/ }));
      await clickMounted(sheet.getByRole("option", { name: /^News/ }));
      await clickMounted(sheet.getByRole("radio", { name: /Changes that rule too/ }));
      expect(writes).toEqual([]);
      await clickMounted(sheet.getByRole("button", { name: "File to News" }));
      await tick(500);
      expect(writes.filter(({ path }) => path.startsWith("/api/rules"))).toEqual([
        { method: "POST", path: "/api/rules", body: expect.objectContaining({
          kind: "domain", match: "sender.example", destination: "ohmail/News", applyRetro: true,
        }) },
        { method: "DELETE", path: "/api/rules/subject-rule", body: {} },
      ]);
    }, { subjectRule: true });
  });

  it("the held press dispatches its rules only through the window", async () => {
    await withMountedSender(async ({ sheet, writes }) => {
      await clickMounted(sheet.getByRole("option", { name: /^Ohbox/ }));
      await clickMounted(within(document.body).getByRole("button", { name: "Undo" }));
      await tick(UNDO_MS + 500);
      expect(writes.filter(({ path }) => /\/rules|\/move$|\/screener/.test(path))).toEqual([]);
    });
  });
});
