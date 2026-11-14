/** @vitest-environment jsdom */
import type { EngineMessage, Folder, RuleEntity as RuleDTO, StayedWhy } from "@ohmail/wire";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import { within } from "@testing-library/react";
import {
  ACCOUNT, ISO, installScreeningWeb, mountScreeningWeb, syncScreeningWeb,
  teardownScreeningWeb, tick, warmScreeningWeb,
} from "./fixtures/screening-web.js";
import { clickMounted } from "./fixtures/mounted-sender-sheet.js";
import {
  MemoryMirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { screeningReadBack, verdictAction, verdictArgs, verdictKeyOf } from "@ohmail/app-logic/press/press-verdict";
import { placeLabel } from "../app/shell/format";

/**
 * THE SHEET AND THE TOAST NAME ONE MESSAGE'S PLACE THE SAME WAY, AND A SENTENCE NAMES EXACTLY THE
 * MAIL ITS MOVE MOVES (the review's findings, with the reviewer's probes as
 * controls). Two folders of the person's own read as two places on the sheet and as "several
 * places" in the toast, whose Move takes every row it counted.
 */
const ADDR = "letters@vendor.example";
const NOW = "2026-10-02T21:00:00.000Z";
const CONSENT = { known: true, standalone: false, dormancyDays: 60, screeningBaselineAt: null, screeningScope: "window" as const, foldersEnabled: false };
const OWN = ["me@home.example"];
let seq = 0;

function msg(id: string, folder: string, o: { date?: string; from?: string; mailbox?: string; auth?: "fail" } = {}): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: o.mailbox ?? "mb", threadId: null, messageIdHeader: null, subject: `Issue ${id}`,
    from: { name: null, address: o.from ?? ADDR }, to: [], cc: [], date: o.date ?? "2026-09-25T09:00:00.000Z", folder: folder as Folder,
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW, ...(o.auth ? { authVerdict: o.auth } : {}),
  } as EngineMessage;
}
const rule = (): RuleDTO => ({
  id: "r-1", kind: "sender", match: ADDR, destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW, updatedAt: NOW, subjectContains: null, bodyContains: null,
  retro: { requestedAt: NOW, doneAt: NOW },
} as RuleDTO);
const five = Array.from({ length: 5 }, (_, i) => msg(`in-${i}`, "INBOX", { date: `2026-09-${String(30 - i).padStart(2, "0")}${"T"}09:00:00.000Z` }));

beforeAll(warmScreeningWeb, 30_000);
afterEach(teardownScreeningWeb);

async function render(rows: EngineMessage[], o: {
  seed?: string; why?: Record<string, StayedWhy>; locale?: "en" | "de"; labels?: Record<string, string | null>;
} = {}) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW, entity: m })),
    { type: "rule", op: "create", id: "r-1", seq: ++seq, updatedAt: NOW, entity: rule() },
  ] as SyncChange[]);
  const seed = o.seed ?? "in-0";
  const messages = o.locale === "de" ? de : en;
  const mailboxes = [...new Set(rows.map((row) => row.mailboxId))].map((id, index) => ({
    id, address: index === 0 ? OWN[0] : ["fixture-home", "mailbox.example"].join("@"),
    displayName: o.labels?.[id] ?? null, status: "connected", organizerRole: "organizer",
    organizerChecked: true, createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
  }));
  const reply = (body: unknown) => Response.json(body, { headers: { "X-Ohmail-Account": ACCOUNT } });
  const standing = rule();
  installScreeningWeb(`#/ohbox/m/${seed}`, (path, query) => {
    if (path === "/api/mailboxes") return reply({ items: mailboxes });
    if (path === "/api/sync") return query.get("types") === "rule"
      ? syncScreeningWeb([{ type: "rule", op: "create", id: standing.id, seq: 1, updatedAt: NOW, entity: standing }], 1)
      : syncScreeningWeb(rows.map((row, index) => ({
        type: "message", op: "create", id: row.id, seq: index + 2, updatedAt: NOW, entity: row,
      })), rows.length + 1);
    if (path === "/api/screener/stayed") {
      const ids = query.get("ids")?.split(",") ?? [];
      return reply({ stayed: ids.filter((id) => !id.startsWith("in-"))
        .map((id) => ({ id, why: o.why?.[id] ?? "filed-elsewhere" })) });
    }
    return undefined;
  });
  vi.setSystemTime(new Date(NOW));
  const frame = within(await mountScreeningWeb(o.locale));
  await tick(4000);
  const reader = within(frame.getByRole("region", { name: messages.frame.landmark.reading }));
  await clickMounted(reader.getByRole("button", { name: (name) => name.startsWith(ADDR) }));
  const page = within(document.body);
  const contact = within(page.getByRole("dialog", { name: messages.message.contactAria.replace("{who}", ADDR) }));
  await clickMounted(contact.getByRole("menuitem", { name: messages.screening.action }));
  const sheet = page.getByRole("dialog", { name: messages.screening.aria.replace("{sender}", ADDR) });
  await tick(200);
  const lines = [...sheet.querySelectorAll<HTMLElement>(".sm-stayed-line")].map((line) => ({
    text: line.querySelector("span")!.textContent!,
    move: within(line).queryByRole("button", { name: /^(Move (them|it) too|Auch verschieben)$/ })?.textContent ?? null,
  }));
  const back = screeningReadBack(store, seed, undefined, "ohbox", "sender", { consent: CONSENT, now: new Date(NOW), ownAddresses: OWN, retro: true });
  const t = createTranslator({ locale: o.locale ?? "en", messages: messages as never, namespace: "screening" as never }) as unknown as
    (k: string, v?: Record<string, unknown>) => string;
  const v = back!.verdict;
  // The shared read-back text and the action it offers.
  const toast = v.key === "none" ? null : t(verdictKeyOf(v), verdictArgs(v, {
    sender: ADDR, place: "Ohbox", history: t("placeHistory"), label: placeLabel, domain: (d) => d,
  }));
  const chips = [...sheet.querySelectorAll(".sm-scope small")].map((e) => e.textContent!);
  return { now: sheet.querySelector(".sm-now")?.textContent ?? null, lines, v, toast, action: verdictAction(v, { scope: "sender", address: ADDR }), chips };
}

describe("H1: one place named with its rows, several named as several", () => {
  it("two folders of the person's own: two places on the sheet, 'several places' in the toast, Move takes both", async () => {
    const r = await render([...five, msg("a-1", "Projects"), msg("b-1", "Receipts-2019", { date: "2026-09-24T09:00:00.000Z" })]);
    expect(r.now).toBe("7 messages — Ohbox 5 · Projects 1 · Receipts-2019 1");
    expect(r.lines.map((l) => l.text)).toEqual([
      "1 stays in Projects: filed in another mail app.", "1 stays in Receipts-2019: filed in another mail app.",
    ]);
    expect(r.toast).toBe("5 are in Ohbox · 2 are still in several places.");
    expect(r.action).toEqual({ kind: "move", ids: expect.arrayContaining(["a-1", "b-1"]) });
    expect((r.action as { ids: string[] }).ids).toHaveLength(2);
  });

  it("two in A and one in B: never '3 are still in A'", async () => {
    const r = await render([...five, msg("a-1", "Projects"), msg("a-2", "Projects"), msg("b-1", "Receipts-2019")]);
    expect(r.now).toBe("8 messages — Ohbox 5 · Projects 2 · Receipts-2019 1");
    expect(r.toast).toBe("5 are in Ohbox · 3 are still in several places.");
    expect((r.action as { ids: string[] }).ids).toHaveLength(3);
  });

  it("in German", async () => {
    const r = await render([...five, msg("a-1", "Projects"), msg("b-1", "Receipts-2019")], { locale: "de" });
    expect(r.toast).toBe("5 liegen in Ohbox · 2 liegen noch an mehreren Orten.");
  });

  it("one folder: the toast names it, with its rows only", async () => {
    const r = await render([...five, msg("a-1", "Projects"), msg("a-2", "Projects")]);
    expect(r.toast).toBe("5 are in Ohbox · 2 are still in Projects.");
    expect((r.action as { ids: string[] }).ids.sort()).toEqual(["a-1", "a-2"]);
  });
});

describe("L1: the toast names the place the sheet names", () => {
  it("an old letter another app filed, put in History by the lists: History on both", async () => {
    const r = await render([...five, msg("f-1", "Fixture", { date: "2024-01-05T09:00:00.000Z" })]);
    expect(r.now).toBe("6 messages — Ohbox 5 · History 1");
    expect(r.lines.map((l) => l.text)).toEqual(["1 stays in History: filed in another mail app."]);
    expect(r.toast).toBe("5 are in Ohbox · 1 is still in History.");
  });
});

describe("L3 and L4: no number for mail in no place", () => {
  it("a sender whose mail is all in Sent, Trash or Junk has no count line", async () => {
    const r = await render([msg("t-1", "Trash"), msg("s-1", "Sent"), msg("j-1", "INBOX/Junk")], { seed: "t-1" });
    expect(r.now).toBeNull();
  });

  it("the domain chip counts only senders with a message in a place", async () => {
    const r = await render([...five, msg("o-1", "Trash", { from: "billing@vendor.example" })]);
    expect(r.chips).toEqual(["5 messages", "5 messages · 1 sender"]);
  });
});

describe("L6: a folder place is its mailbox and path", () => {
  it("two paths with the same leaf show their parent", async () => {
    const r = await render([...five, msg("w-1", "Work/Fixture"), msg("h-1", "Home/Fixture", { date: "2026-09-24T09:00:00.000Z" })]);
    expect(r.now).toBe("7 messages — Ohbox 5 · Work/Fixture 1 · Home/Fixture 1");
    expect(r.lines.map((l) => l.text)).toEqual([
      "1 stays in Work/Fixture: filed in another mail app.", "1 stays in Home/Fixture: filed in another mail app.",
    ]);
  });

  it("the same path in two mailboxes is two counts, each named with its mailbox's label", async () => {
    const r = await render([...five, msg("a-1", "Fixture", { mailbox: "mb" }), msg("b-1", "Fixture", { mailbox: "mb-2", date: "2026-09-24T09:00:00.000Z" })],
      { labels: { mb: "Work", "mb-2": "Home" } });
    expect(r.now).toBe("7 messages — Ohbox 5 · Fixture (Work) 1 · Fixture (Home) 1");
    expect(r.lines.map((l) => l.text)).toEqual([
      "1 stays in Fixture (Work): filed in another mail app.", "1 stays in Fixture (Home): filed in another mail app.",
    ]);
    expect(r.toast).toBe("5 are in Ohbox · 2 are still in several places.");
  });

  it("in German, the same pattern", async () => {
    const r = await render([...five, msg("a-1", "Fixture", { mailbox: "mb" }), msg("b-1", "Fixture", { mailbox: "mb-2", date: "2026-09-24T09:00:00.000Z" })],
      { labels: { mb: "Arbeit", "mb-2": "Privat" }, locale: "de" });
    expect(r.now).toBe("7 Nachrichten — Ohbox 5 · Fixture (Arbeit) 1 · Fixture (Privat) 1");
  });

  it("a mailbox with no label is never named by its address: only the labelled one is qualified", async () => {
    const r = await render([...five, msg("a-1", "Fixture", { mailbox: "mb" }), msg("b-1", "Fixture", { mailbox: "mb-2", date: "2026-09-24T09:00:00.000Z" })],
      { labels: { mb: "Work", "mb-2": null } });
    expect(r.now).toBe("7 messages — Ohbox 5 · Fixture (Work) 1 · Fixture 1");
    expect(r.now).not.toContain("@");
  });

  it("positive control: one mailbox's folder takes no label even when labels exist", async () => {
    const r = await render([...five, msg("a-1", "Fixture", { mailbox: "mb" })], { labels: { mb: "Work", "mb-2": "Home" } });
    expect(r.now).toBe("6 messages — Ohbox 5 · Fixture 1");
  });
});

describe("L7: no move offered past a message that failed its checks", () => {
  it("the sheet and the toast both withhold it", async () => {
    const r = await render([...five, msg("f-1", "Fixture", { auth: "fail" })], { why: { "f-1": "failed-checks" } });
    expect(r.lines).toEqual([{ text: "1 stays in Fixture: it failed the sender's sign-in checks.", move: null }]);
    expect(r.toast).toBe("5 are in Ohbox · 1 is still in Fixture.");
    expect(r.action).toBeNull();
  });

  it("positive control: one that passed takes the move", async () => {
    const r = await render([...five, msg("f-1", "Fixture")]);
    expect(r.action).toEqual({ kind: "move", ids: ["f-1"] });
  });
});
