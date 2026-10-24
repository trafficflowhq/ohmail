/** @vitest-environment jsdom */
/**
 * SETTINGS → RULES → CHANGE LISTS EVERY PLACE AND SAYS WHAT MOVES.
 *
 * Measured on web 0.25.1: Change on a screened-out rule offered Ohbox, News, Receipts, Screener and
 * Spam — the current place was left out, so a rule changed away from Screened out could not be set
 * back on that page — and changing it to Ohbox moved the sender's five screened messages with the
 * pane saying "Mail already filed stays where it is". Driven through `SettingsView`, the surface the
 * web and the desktop both render.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import type { EngineMessage, Folder, RuleDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SettingsView } from "../app/views/SettingsView";
import { rulePastMail } from "../app/shell/rule-past-mail";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

function rule(over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id: "r-1", kind: "sender", match: "knock@door.test", destination: "ohmail/Screened", priority: 0,
    provenance: "promoted", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-12T10:00:00.000Z", updatedAt: "2026-09-12T10:00:00.000Z", ...over,
  };
}

let host: HTMLDivElement;
let root: Root | null = null;
type Call = [string, Folder, boolean | "walk" | undefined];

async function render(
  items: RuleDTO[], count: number | null | ((rule: RuleDTO, dest: Folder | null) => number | null) = 5,
): Promise<Call[]> {
  const calls: Call[] = [];
  const view = h(SettingsView, {
    notifications: null, tags: [], tagCounts: {},
    rules: {
      items,
      onRevoke: async () => ({ status: "confirmed" as const }),
      onRetarget: async (id: string, dest: Folder, refile?: boolean | "walk") => {
        calls.push([id, dest, refile]);
        return { status: "confirmed" as const };
      },
      pastMail: typeof count === "function" ? count : () => count,
    },
  });
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-26T08:00:00.000Z"),
      children: h(ThemeProvider, { children: h(ToastHost, { children: view }) }),
    }));
  });
  return calls;
}

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>("button")];
async function press(label: string): Promise<void> {
  const b = buttons().find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no "${label}" — have: ${buttons().map((x) => x.textContent?.trim()).join(" | ")}`);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
/** The places the open confirm offers, current one included, Cancel and the switch left out. */
const offered = (): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>(".rules-confirm .rules-places button")];
async function pressPlace(label: string): Promise<void> {
  const b = offered().find((x) => x.textContent?.trim() === label)!;
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function openChange(): Promise<void> {
  await press("Rules");
  await press("Change");
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
});

describe("Change lists the sender sheet's places, the current one marked", () => {
  it("a screened-out rule is offered Screened out, marked as where it files now", async () => {
    await render([rule()]);
    await openChange();
    expect(offered().map((b) => b.textContent?.trim())).toEqual(["Ohbox", "News", "Receipts", "Screened out", "Spam"]);
    const current = offered().filter((b) => b.getAttribute("aria-current") === "true");
    expect(current.map((b) => b.textContent?.trim())).toEqual(["Screened out"]);
    expect(current[0]!.disabled).toBe(true);
  });

  it("an Ohbox rule marks Ohbox, and every other place is pressable", async () => {
    await render([rule({ destination: "INBOX" })]);
    await openChange();
    const marked = offered().filter((b) => b.getAttribute("aria-current") === "true").map((b) => b.textContent?.trim());
    expect(marked).toEqual(["Ohbox"]);
    expect(offered().filter((b) => !b.disabled).map((b) => b.textContent?.trim())).toEqual(["News", "Receipts", "Screened out", "Spam"]);
  });
});

describe("a change that moves mail says so before and after, with Undo", () => {
  it("before the press: the count and the switch, on by default", async () => {
    await render([rule()]);
    await openChange();
    const sw = host.querySelector<HTMLButtonElement>('.rules-confirm [role="switch"]');
    expect(sw, "no past-mail switch in the confirm").not.toBeNull();
    expect(sw!.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("5 messages ohmail has synced were filed in Screened out by this rule");
    expect(host.textContent).toContain("ohmail also moves the mail it filed in Screened out");
    expect(host.textContent).not.toContain("Mail already filed stays where it is.");
  });

  it("the press asks for a re-filing, and the toast names the count and offers Undo", async () => {
    const calls = await render([rule()]);
    await openChange();
    await press("Ohbox");
    expect(calls).toEqual([["r-1", "INBOX", true]]);
    expect(host.textContent).toContain("Ohbox — the rule files there now, and ohmail is moving the 5 messages it filed in Screened out there too.");
    await press("Undo");
    expect(calls[1]).toEqual(["r-1", "ohmail/Screened", false]);
    expect(host.textContent).toContain("The rule files into Screened out again, and nothing moved.");
  });

  it("with the switch off nothing already filed is asked for, and the pane says so", async () => {
    const calls = await render([rule()]);
    await openChange();
    const sw = host.querySelector<HTMLButtonElement>('.rules-confirm [role="switch"]')!;
    await act(async () => { sw.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(host.textContent).toContain("Mail already filed stays where it is.");
    await press("Ohbox");
    expect(calls).toEqual([["r-1", "INBOX", false]]);
    expect(host.textContent).toContain("New mail matching this rule will go to Ohbox. Mail already filed stays where it is.");
  });

  it("a rule this device cannot count says so, and never states a number", async () => {
    await render([rule({ bodyContains: "invoice" })], null);
    await openChange();
    expect(host.textContent).toContain("The text is matched when mail is filed, so this device cannot count it.");
    await press("Ohbox");
    expect(host.textContent).toContain("Ohbox — the rule files there now, and ohmail is moving the mail it filed in Screened out there too.");
  });
});

/* Counted by the real `rulePastMail`: one letter placed in News, one in News by a subject rule, two
   kept in the Ohbox. The confirm names News and one message, and so does the toast. */
describe("a Change says it moves the rule's pile, and nothing else", () => {
  const from = { name: "Nora", address: "nora@corr.example" };
  const nora = rule({ id: "r-n", match: "nora@corr.example", destination: "ohmail/News", provenance: "manual" });
  const weekly = rule({ id: "r-w", match: "nora@corr.example", destination: "ohmail/News", subjectContains: "weekly", provenance: "manual" });
  const mail = (id: string, subject: string, folder: string, placeDecided = false) => ({
    id, from, to: [], cc: [], subject, snippet: "", date: "2026-10-24T18:00:00.000Z", folder, flags: [],
    ...(placeDecided ? { placeDecided } : {}),
  }) as unknown as EngineMessage;
  const rows = [
    mail("n1", "letter one", "ohmail/News", true), mail("n2", "weekly digest two", "ohmail/News"),
    mail("n3", "letter three", "INBOX"), mail("n4", "letter four", "INBOX"),
  ];
  const counted = (r: RuleDTO, dest: Folder | null) => rulePastMail(r, [r, weekly], rows, dest);

  it("names News and one message, re-files it on the press, and Undo moves nothing", async () => {
    const calls = await render([nora], counted);
    await openChange();
    expect(host.textContent).toContain("ohmail also moves the mail it filed in News");
    expect(host.textContent).toContain("1 message ohmail has synced was filed in News by this rule");
    await pressPlace("Receipts");
    expect(calls).toEqual([["r-n", "ohmail/Receipts", true]]);
    expect(host.textContent).toContain("Receipts — the rule files there now, and ohmail is moving the 1 message it filed in News there too.");
    await press("Undo");
    expect(calls[1]).toEqual(["r-n", "ohmail/News", false]);
    expect(host.textContent).toContain("The rule files into News again, and nothing moved.");
  });

  it("a re-filing still waiting is named by where it started, and Undo restores it", async () => {
    const pending = { ...nora, destination: "ohmail/Receipts" as Folder,
      retro: { requestedAt: "2026-10-24T19:07:18.000Z", doneAt: null, from: "ohmail/News" as Folder } };
    const calls = await render([pending], counted);
    await openChange();
    expect(host.textContent).toContain("ohmail also moves the mail it filed in News");
    await pressPlace("Screened out");
    expect(calls).toEqual([["r-n", "ohmail/Screened", true]]);
    await press("Undo");
    expect(calls[1]).toEqual(["r-n", "ohmail/Receipts", true]);
    expect(host.textContent).toContain("The rule files into Receipts again, and ohmail is moving the mail it filed in News there.");
  });

  /* The sender sheet asked for past mail and that walk is still owed: not walked yet, or parked days
     ago behind a mailbox only read here. Either way the Change takes the walk to the new place, so the
     pane says what the walk moves and never that mail is still on its way; Undo asks for it again. */
  it("a walk still owed is named and counted as the walk, and Undo asks for it again", async () => {
    const owed = { ...nora, destination: "ohmail/Receipts" as Folder,
      retro: { requestedAt: "2026-10-24T19:07:18.000Z", doneAt: null, from: null } };
    const sheet = [mail("n1", "letter one", "ohmail/Receipts", true), mail("n3", "letter three", "INBOX"), mail("n4", "letter four", "INBOX")];
    const calls = await render([owed], (r, dest) => rulePastMail(r, [r], sheet, dest));
    await openChange();
    expect(host.textContent).toContain("ohmail also moves the mail it matches, except messages you replied to, filed yourself here");
    expect(host.textContent).toContain("2 messages ohmail has synced match this rule");
    expect(host.textContent).not.toContain("on its way");
    await pressPlace("News");
    expect(calls).toEqual([["r-n", "ohmail/News", true]]);
    expect(host.textContent).toContain("News — the rule files there now, and ohmail is moving the 2 messages it matches there too.");
    await press("Undo");
    expect(calls[1]).toEqual(["r-n", "ohmail/Receipts", "walk"]);
    expect(host.textContent).toContain("The rule files into Receipts again, and ohmail is moving the mail it matches there.");
  });

  /* A re-filing past its first move (or parked) names the rule's own place: a Change re-files from
     there, and its Undo puts the rule back and moves nothing, as no re-filing was waiting. */
  it("a re-filing under way is named by the rule's own place, and Undo moves nothing", async () => {
    const underWay = { ...nora, destination: "ohmail/Receipts" as Folder,
      retro: { requestedAt: "2026-10-24T19:07:18.000Z", doneAt: null, from: "ohmail/Receipts" as Folder } };
    const calls = await render([underWay], 1);
    await openChange();
    expect(host.textContent).toContain("ohmail also moves the mail it filed in Receipts");
    await pressPlace("Screened out");
    expect(calls).toEqual([["r-n", "ohmail/Screened", true]]);
    await press("Undo");
    expect(calls[1]).toEqual(["r-n", "ohmail/Receipts", false]);
    expect(host.textContent).toContain("The rule files into Receipts again, and nothing moved.");
  });

  it("back to the place the re-filing started from: the mail is already there", async () => {
    const pending = { ...nora, destination: "ohmail/Receipts" as Folder,
      retro: { requestedAt: "2026-10-24T19:07:18.000Z", doneAt: null, from: "ohmail/News" as Folder } };
    await render([pending], counted);
    await openChange();
    await pressPlace("News");
    expect(host.textContent).toContain("News — the rule files there now. The mail it filed is already there.");
  });
});
