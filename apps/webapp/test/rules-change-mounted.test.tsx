/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { screen, within } from "@testing-library/react";
import type { EngineMessage, Folder, MailboxProfileEntity, RuleEntity, SyncResponse, WaitingRequestWire } from "@ohmail/wire";
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core/folder-name";
import { PUBLISHED_RULE_ID } from "@trafficflow/core/rule-order";
import messages from "../messages/en.json";
import {
  ACCOUNT, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const rules = messages.rules;
const settings = messages.settings;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(status < 300 ? { "X-Ohmail-Account": ACCOUNT } : {}) } });

function installRulesShell(): void {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
}

beforeAll(warmCloudShell);
beforeEach(installRulesShell);
afterEach(teardownConfirmEnv);

const click = async (button: HTMLElement): Promise<void> => {
  await act(async () => { button.click(); });
  await tick(0);
};

type Write = { method: string; path: string; body: unknown };

async function openRulesPane() {
  window.location.hash = "#/settings";
  const frame = await mountCloudShell();
  await tick(3000);
  const nav = within(frame).getByRole("navigation", { name: settings.navAria });
  await click(within(nav).getByRole("button", { name: settings.rules }));
  await tick(250);
  expect(window.location.hash).toBe("#/settings/rules");

  return within(within(frame).getByRole("region", { name: settings.rules }));
}

function testMessage(id: string, address: string, folder: Folder, mailboxId = "mb-1"): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId, threadId: null, messageIdHeader: null, subject: id,
    from: { name: "Lena", address }, to: [], cc: [], date: ISO, folder, snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

function testRule(over: Partial<RuleEntity> = {}): RuleEntity {
  return {
    id: "r-1",
    kind: "sender",
    match: ["lena", "example.invalid"].join("@"),
    destination: "INBOX",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

async function mountedRules({
  item = testRule(), refuse = false, includeFiledMail = false, seededMail = [], otherRules = [],
}: {
  item?: RuleEntity;
  refuse?: boolean;
  includeFiledMail?: boolean;
  seededMail?: EngineMessage[];
  otherRules?: RuleEntity[];
} = {}) {
  const { id, destination } = item;
  const mail = includeFiledMail ? [
    ...Array.from({ length: 5 }, (_, i) => testMessage(`filed-${i}`, item.match, destination)),
    testMessage("kept-in-ohbox", item.match, "INBOX"),
    testMessage("read-elsewhere", item.match, destination, "mb-reader"),
  ] : seededMail;
  const seededRules = [item, ...otherRules];
  const writes: Write[] = [];
  let current = item;
  let seq = mail.length + seededRules.length;
  scriptSync(() => json({
    changes: {
      creates: [
        ...seededRules.map((rule, i) => ({
          type: "rule" as const, op: "create" as const, id: rule.id, seq: i + 1, updatedAt: ISO, entity: rule,
        })),
        ...mail.map((message, i) => ({
          type: "message" as const, op: "create" as const, id: message.id, seq: i + seededRules.length + 1,
          updatedAt: ISO, entity: message,
        })),
      ],
      updates: current !== item
        ? [{ type: "rule", op: "update", id, seq, updatedAt: ISO, entity: current }]
        : [],
      moves: [],
      deletes: [],
    },
    cursor: `c${seq}`, hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));

  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/mailboxes") {
      const organizer = {
        id: "mb-1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      };
      const reader = {
        ...organizer, id: "mb-reader", address: ["reader", "example.invalid"].join("@"), organizerRole: "reader",
      };
      return json({ items: includeFiledMail ? [organizer, reader] : [organizer] });
    }
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
    if (method !== "GET" && /^\/api\/(rules|messages)(\/|$)/.test(path)) {
      writes.push({ method, path, body });
    }
    if (path === `/api/rules/${id}` && method === "PATCH") {
      if (refuse) return json({ error: { code: "forbidden", message: "The server refused this change." } }, 403);
      const change = body as { destination: Folder; applyRetro: boolean; refile?: boolean };
      const refiling = current.retro;
      const wholeWalk = refiling != null && refiling.requestedAt !== null && refiling.doneAt === null && refiling.from == null;
      const from = change.refile && !wholeWalk ? refiling?.from ?? current.destination : null;
      current = {
        ...current, destination: change.destination, provenance: "manual",
        retro: { requestedAt: change.refile || change.applyRetro ? ISO : null, doneAt: null, from },
      };
      seq += 1;
      return new Response(JSON.stringify(current), {
        status: 200, headers: { "content-type": "application/json", "X-Ohmail-Account": ACCOUNT, "x-sync-seq": String(seq) },
      });
    }
    return fixture(input, init);
  };

  const pane = await openRulesPane();
  const openChange = async (place = destination === "ohmail/Screened" ? "Screened out" : "Ohbox", row?: HTMLElement) => {
    await click((row ? within(row) : pane).getByRole("button", { name: `Files into ${place}` }));
    expect(writes).toEqual([]);
    return within(screen.getByRole("dialog", { name: rules.change }));
  };
  return { pane, openChange, writes };
}

describe("changing where a rule files", () => {
  it("offers the sender sheet's five places, the one it already uses marked and not pressable", async () => {
    const { openChange, writes } = await mountedRules();
    const menu = await openChange();
    const places = menu.getAllByRole<HTMLButtonElement>("menuitemradio");
    expect(places.map((place) => place.textContent?.trim())).toEqual(["Ohbox", "News", "Receipts", "Screened out", "Spam"]);
    const current = menu.getByRole<HTMLButtonElement>("menuitemradio", { name: "Ohbox", checked: true });
    expect(current.disabled).toBe(true);
    await click(current);
    expect(writes).toEqual([]);
  });

  it("with the past-mail switch off it discloses, before the choice, that mail already filed stays", async () => {
    const { openChange, writes } = await mountedRules();
    const menu = await openChange();
    const movePastMail = menu.getByRole("switch");
    expect(movePastMail.getAttribute("aria-checked")).toBe("true");
    await click(movePastMail);
    expect(menu.getByText(/Mail already filed stays where it is\./)).toBeTruthy();
    expect(writes).toEqual([]);
    await click(menu.getByRole("menuitemradio", { name: "News" }));
    await tick(1500);
    expect(writes).toEqual([{
      method: "PATCH", path: "/api/rules/r-1", body: { destination: "ohmail/News", applyRetro: false },
    }]);
  });

  it("dispatches the chosen folder as a canonical path, not a label", async () => {
    const { openChange, writes } = await mountedRules({ item: testRule({ id: "r-3" }) });
    const menu = await openChange();
    expect(menu.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    await click(menu.getByRole("menuitemradio", { name: "News" }));
    await tick(1500);
    expect(writes).toEqual([{
      method: "PATCH", path: "/api/rules/r-3", body: { destination: "ohmail/News", applyRetro: false, refile: true },
    }]);
  });
});

const destinationOptions = ["Ohbox", "News", "Receipts", "Screened out", "Spam"];
const optionNames = (items: HTMLElement[]) => items.map((item) => item.textContent?.trim());

describe("Change lists the sender sheet's places, the current one marked", () => {
  it("a screened-out rule is offered Screened out, marked as where it files now", async () => {
    const { pane, openChange, writes } = await mountedRules({ item: testRule({ destination: "ohmail/Screened" }) });
    const trigger = pane.getByRole("button", { name: "Files into Screened out" });
    trigger.focus();
    expect(writes).toEqual([]);
    const menu = await openChange();
    expect(optionNames(menu.getAllByRole("menuitemradio"))).toEqual(destinationOptions);
    const marked = menu.getAllByRole<HTMLButtonElement>("menuitemradio", { checked: true });
    expect(optionNames(marked)).toEqual(["Screened out"]);
    expect(marked[0]!.disabled).toBe(true);
    await click(marked[0]!);
    expect(writes).toEqual([]);

    const dialog = screen.getByRole("dialog", { name: rules.change });
    const focused = document.activeElement;
    expect(dialog.contains(focused)).toBe(true);
    await act(async () => { focused?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(screen.queryByRole("dialog", { name: rules.change })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(writes).toEqual([]);
  });

  it("an Ohbox rule marks Ohbox, and every other place is pressable", async () => {
    const { openChange, writes } = await mountedRules();
    const menu = await openChange();
    expect(optionNames(menu.getAllByRole("menuitemradio", { checked: true }))).toEqual(["Ohbox"]);
    const offered = menu.getAllByRole<HTMLButtonElement>("menuitemradio");
    expect(optionNames(offered.filter((option) => !option.disabled))).toEqual(["News", "Receipts", "Screened out", "Spam"]);
    expect(writes).toEqual([]);
  });
});

describe("both spellings of the News pile are ONE chip", () => {
  it("a rule stored in the old spelling is not offered News as somewhere new", async () => {
    const { openChange, writes } = await mountedRules({
      item: testRule({ id: "l0", destination: LEGACY_NEWS_FOLDER as Folder }),
      otherRules: [testRule({ id: "i0", match: ["other", "example.invalid"].join("@") })],
    });
    const menu = await openChange("News");
    const offered = menu.getAllByRole<HTMLButtonElement>("menuitemradio");
    expect(optionNames(offered)).toEqual(destinationOptions);
    expect(optionNames(offered.filter((option) => option.disabled))).toEqual(["News"]);
    const current = menu.getByRole<HTMLButtonElement>("menuitemradio", { name: "News", checked: true });
    await click(current);
    expect(writes).toEqual([]);
  });
});

const reports = () => screen.queryAllByRole("status").map((report) => report.textContent);

describe("a change that moves mail says so before and after, with Undo", () => {
  const filedRule = { item: testRule({ destination: "ohmail/Screened" }), includeFiledMail: true };

  it("before the press: the count and the switch, on by default", async () => {
    const { openChange, writes } = await mountedRules(filedRule);
    const menu = await openChange();
    expect(menu.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(menu.getByText(/^5 messages ohmail has synced were filed in Screened out by this rule/)).toBeTruthy();
    expect(menu.getByText(/ohmail also moves the mail it filed in Screened out/)).toBeTruthy();
    expect(menu.queryByText(/Mail already filed stays where it is\./)).toBeNull();
    expect(writes).toEqual([]);
  });

  it("the press asks for a re-filing, and the toast names the count and offers Undo", async () => {
    const { pane, openChange, writes } = await mountedRules(filedRule);
    const menu = await openChange();
    await click(menu.getByRole("menuitemradio", { name: "Ohbox" }));
    await tick(750);
    expect(writes).toEqual([{
      method: "PATCH", path: "/api/rules/r-1", body: { destination: "INBOX", applyRetro: false, refile: true },
    }]);
    expect(reports()).toEqual(expect.arrayContaining([expect.stringContaining(
      "Ohbox — the rule files there now, and ohmail is moving the 5 messages it filed in Screened out there too.",
    )]));
    expect(pane.getByRole("button", { name: "Files into Ohbox" })).toBeTruthy();

    await click(screen.getByRole("button", { name: rules.undo }));
    await tick(750);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({
      method: "PATCH", path: "/api/rules/r-1", body: { destination: "ohmail/Screened", applyRetro: false },
    });
    expect(reports()).toContain("The rule files into Screened out again, and nothing moved.");
    expect(pane.getByRole("button", { name: "Files into Screened out" })).toBeTruthy();
  });

  it("with the switch off nothing already filed is asked for, and the pane says so", async () => {
    const { openChange, writes } = await mountedRules(filedRule);
    const menu = await openChange();
    await click(menu.getByRole("switch"));
    expect(menu.getByText(/Mail already filed stays where it is\./)).toBeTruthy();
    await click(menu.getByRole("menuitemradio", { name: "Ohbox" }));
    await tick(750);
    expect(writes).toEqual([{
      method: "PATCH", path: "/api/rules/r-1", body: { destination: "INBOX", applyRetro: false },
    }]);
    expect(reports()).toEqual(expect.arrayContaining([expect.stringContaining(
      "New mail matching this rule will go to Ohbox. Mail already filed stays where it is.",
    )]));
  });

  it("a rule this device cannot count says so, and never states a number", async () => {
    const { openChange, writes } = await mountedRules({
      ...filedRule, item: { ...filedRule.item, bodyContains: "invoice" },
    });
    const menu = await openChange();
    expect(menu.getByText("The text is matched when mail is filed, so this device cannot count it.")).toBeTruthy();
    expect(menu.queryByText(/\d+ messages? ohmail has synced/)).toBeNull();
    await click(menu.getByRole("menuitemradio", { name: "Ohbox" }));
    await tick(750);
    expect(writes).toEqual([{
      method: "PATCH", path: "/api/rules/r-1", body: { destination: "INBOX", applyRetro: false, refile: true },
    }]);
    expect(reports()).toEqual(expect.arrayContaining([expect.stringContaining(
      "Ohbox — the rule files there now, and ohmail is moving the mail it filed in Screened out there too.",
    )]));
  });
});

describe("a Change says it moves the rule's pile, and nothing else", () => {
  const match = ["nora", "example.invalid"].join("@");
  const nora = testRule({ id: "r-n", match, destination: "ohmail/News", provenance: "manual" });
  const weekly = { ...nora, id: "r-w", subjectContains: "weekly" };
  const mail: EngineMessage[] = [
    { ...testMessage("n1", match, "ohmail/News"), subject: "letter one", placeDecided: true },
    { ...testMessage("n2", match, "ohmail/News"), subject: "weekly digest two" },
    testMessage("n3", match, "INBOX"),
    testMessage("n4", match, "INBOX"),
  ];
  const outstanding = (from: Folder | null): RuleEntity => ({
    ...nora, destination: "ohmail/Receipts", retro: { requestedAt: ISO, doneAt: null, from },
  });
  const patch = (destination: Folder, options: { applyRetro: boolean; refile?: true }): Write => ({
    method: "PATCH", path: "/api/rules/r-n", body: { destination, ...options },
  });
  async function choose(menu: ReturnType<typeof within>, place: string): Promise<void> {
    await click(menu.getByRole("menuitemradio", { name: place }));
    await tick(750);
  }
  async function undo(): Promise<void> {
    await click(screen.getByRole("button", { name: rules.undo }));
    await tick(750);
  }
  const report = (words: string) =>
    expect(reports()).toEqual(expect.arrayContaining([expect.stringContaining(words)]));

  it("names News and one message, re-files it on the press, and Undo moves nothing", async () => {
    const { pane, openChange, writes } = await mountedRules({ item: nora, seededMail: mail, otherRules: [weekly] });
    const menu = await openChange("News", pane.getByRole("group", { name: `Mail from ${match}` }));
    expect(menu.getByText(/ohmail also moves the mail it filed in News/)).toBeTruthy();
    expect(menu.getByText(/^1 message ohmail has synced was filed in News by this rule/)).toBeTruthy();
    await choose(menu, "Receipts");
    expect(writes).toEqual([patch("ohmail/Receipts", { applyRetro: false, refile: true })]);
    report("Receipts — the rule files there now, and ohmail is moving the 1 message it filed in News there too.");

    await undo();
    expect(writes).toEqual([
      patch("ohmail/Receipts", { applyRetro: false, refile: true }),
      patch("ohmail/News", { applyRetro: false }),
    ]);
    report("The rule files into News again, and nothing moved.");
    const sibling = pane.getByRole("group", { name: /Mail from .*weekly/ });
    expect(within(sibling).getByRole("button", { name: "Files into News" })).toBeTruthy();
  });

  it("a re-filing still waiting is named by where it started, and Undo restores it", async () => {
    const { openChange, writes } = await mountedRules({
      item: outstanding("ohmail/News"), seededMail: mail, otherRules: [weekly],
    });
    const menu = await openChange("Receipts");
    expect(menu.getByText(/ohmail also moves the mail it filed in News/)).toBeTruthy();
    await choose(menu, "Screened out");
    expect(writes).toEqual([patch("ohmail/Screened", { applyRetro: false, refile: true })]);
    await undo();
    expect(writes).toEqual([
      patch("ohmail/Screened", { applyRetro: false, refile: true }),
      patch("ohmail/Receipts", { applyRetro: false, refile: true }),
    ]);
    report("The rule files into Receipts again, and ohmail is moving the mail it filed in News there.");
  });

  it("a walk still owed is named and counted as the walk, and Undo asks for it again", async () => {
    const placed: EngineMessage = { ...testMessage("placed", match, "ohmail/Receipts"), placeDecided: true };
    const { openChange, writes } = await mountedRules({
      item: outstanding(null), seededMail: [placed, mail[2]!, mail[3]!],
    });
    const menu = await openChange("Receipts");
    expect(menu.getByText(/ohmail also moves the mail it matches, except messages you replied to, filed yourself here/)).toBeTruthy();
    expect(menu.getByText(/^2 messages ohmail has synced match this rule/)).toBeTruthy();
    expect(menu.queryByText(/on its way/)).toBeNull();
    await choose(menu, "News");
    expect(writes).toEqual([patch("ohmail/News", { applyRetro: false, refile: true })]);
    report("News — the rule files there now, and ohmail is moving the 2 messages it matches there too.");
    await undo();
    expect(writes).toEqual([
      patch("ohmail/News", { applyRetro: false, refile: true }),
      patch("ohmail/Receipts", { applyRetro: true }),
    ]);
    report("The rule files into Receipts again, and ohmail is moving the mail it matches there.");
  });

  it("a re-filing under way is named by the rule's own place, and Undo moves nothing", async () => {
    const { openChange, writes } = await mountedRules({
      item: outstanding("ohmail/Receipts"), seededMail: [testMessage("filed", match, "ohmail/Receipts")],
    });
    const menu = await openChange("Receipts");
    expect(menu.getByText(/ohmail also moves the mail it filed in Receipts/)).toBeTruthy();
    await choose(menu, "Screened out");
    expect(writes).toEqual([patch("ohmail/Screened", { applyRetro: false, refile: true })]);
    await undo();
    expect(writes).toEqual([
      patch("ohmail/Screened", { applyRetro: false, refile: true }),
      patch("ohmail/Receipts", { applyRetro: false }),
    ]);
    report("The rule files into Receipts again, and nothing moved.");
  });

  it("back to the place the re-filing started from: the mail is already there", async () => {
    const { openChange, writes } = await mountedRules({
      item: outstanding("ohmail/News"), seededMail: mail, otherRules: [weekly],
    });
    await choose(await openChange("Receipts"), "News");
    expect(writes).toEqual([patch("ohmail/News", { applyRetro: false, refile: true })]);
    report("News — the rule files there now. The mail it filed is already there.");
  });
});

describe("the toast reports the outcome, not the intent", () => {
  it("a refused destination change does not claim the destination changed", async () => {
    const { pane, openChange, writes } = await mountedRules({ refuse: true });
    const menu = await openChange();
    await click(menu.getByRole("menuitemradio", { name: "News" }));
    await tick(1500);
    expect(writes).toEqual([{
      method: "PATCH", path: "/api/rules/r-1", body: { destination: "ohmail/News", applyRetro: false, refile: true },
    }]);
    expect(screen.getByText("Couldn't change that rule. Nothing has changed.")).toBeTruthy();
    expect(screen.queryByText(/will go to News|the rule files there now/)).toBeNull();
    expect(pane.getByRole("button", { name: "Files into Ohbox" })).toBeTruthy();
  });

  it("an organizer-queued change keeps the published rule in place and names the holder", async () => {
    const { pane, writes, match } = await mountPublishedRules(true);
    await click(pane.getByRole("button", { name: "Files into News" }));
    const menu = within(screen.getByRole("dialog", { name: rules.change }));
    await click(menu.getByRole("switch"));
    await click(menu.getByRole("menuitemradio", { name: "Ohbox" }));
    await tick(1500);
    expect(writes).toEqual([{
      method: "PATCH", path: `/api/rules/${PUBLISHED_RULE_ID}`,
      body: {
        key: { kind: "sender", match, subjectContains: null, bodyContains: null },
        destination: "INBOX", priority: 5, applyRetro: false,
      },
    }]);
    expect(reports()).toContain("Queued for Studio laptop — the rule is unchanged, and still filing mail, until its next pass.");
    expect(pane.getByText(/^Change to Ohbox waits on Studio laptop/)).toBeTruthy();
    expect(pane.getByRole("button", { name: "Files into News" })).toBeTruthy();
    expect(pane.queryByRole("button", { name: "Files into Ohbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: rules.undo })).toBeNull();
  });
});

const holder = { kind: "local", name: "Studio laptop", since: ISO };
const mailboxId = "mb-1";
type RuleKey = { kind: string; match: string; subjectContains: string | null; bodyContains: string | null };
const keyOf = (rule: RuleEntity): RuleKey => ({
  kind: rule.kind,
  match: rule.match,
  subjectContains: rule.subjectContains ?? null,
  bodyContains: rule.bodyContains ?? null,
});

function waitingRule(
  id: string, kind: "rule.create" | "rule.delete" | "rule.update", rule: RuleEntity, destination?: string,
): WaitingRequestWire {
  return {
    id, kind, mailboxId, state: "sent", holder, decidedAt: ISO, resolvedAt: null, refusedReason: null,
    target: { rule: keyOf(rule), ...(destination === undefined ? {} : { destination }) },
  };
}

async function mountPublishedRules(
  acceptsRequests: boolean,
  { published, local = [], waiting = [] }: {
    published?: RuleEntity[];
    local?: RuleEntity[];
    waiting?: WaitingRequestWire[];
  } = {},
) {
  const match = ["lena", "shop.example.invalid"].join("@");
  const sender: RuleEntity = {
    id: "published-sender", kind: "sender", match, destination: "ohmail/News",
    priority: 0, enabled: true, provenance: "manual",
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  };
  const domain: RuleEntity = {
    ...sender, id: "published-domain", kind: "domain", match: "shop.example.invalid",
    destination: "ohmail/Screened", priority: 5,
  };
  const profile: MailboxProfileEntity = {
    mailboxId, asOf: ISO, updatedAt: ISO, from: holder, rules: published ?? [sender, domain],
  };
  const page: SyncResponse = {
    changes: {
      creates: [
        { type: "mailbox_profile", op: "create", id: mailboxId, seq: 1, updatedAt: ISO, entity: profile },
        ...local.map((item, index) => ({
          type: "rule" as const, op: "create" as const, id: item.id, seq: index + 2, updatedAt: ISO, entity: item,
        })),
      ],
      updates: [], moves: [], deletes: [],
    },
    cursor: `c${local.length + 1}`, hasMore: false, serverTime: ISO,
  };
  scriptSync(() => json(page));

  const writes: Write[] = [];
  const requests = [...waiting];
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/mailboxes") {
      return json({ items: [{
        id: mailboxId, address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "reader", organizedBy: holder, organizerState: "held",
        organizerAcceptsRequests: acceptsRequests, organizerReleasedAt: null,
        initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
    if (method !== "GET" && /^\/api\/(rules|messages)(\/|$)/.test(path)) {
      writes.push({ method, path, body });
    }
    const publishedKey = (body as { key?: RuleKey } | null)?.key;
    const copy = path === `/api/rules/${PUBLISHED_RULE_ID}`
      ? profile.rules.find((rule) => rule.match === publishedKey?.match)
      : undefined;
    if (method === "PATCH" && copy) {
      const destination = (body as { destination: Folder }).destination;
      const requestId = `change-${copy.id}`;
      requests.push(waitingRule(requestId, "rule.update", copy, destination));
      return json({ pending: true, travel: { appliedLocally: [], pending: [{ mailboxId, requestId, holder }], refused: [] } }, 202);
    }
    if (method === "DELETE") {
      const own = local.find((rule) => path === `/api/rules/${rule.id}`);
      const rule = copy ?? own;
      if (rule) {
        const requestId = `remove-${rule.id}`;
        requests.push(waitingRule(requestId, "rule.delete", rule));
        return json({
          pending: true,
          travel: { appliedLocally: [], pending: [{ mailboxId, requestId, holder }], refused: [] },
          ...(own === undefined ? {} : { rule: own }),
        }, 202);
      }
    }
    if (path === "/api/organizer-requests") return json({ items: requests });
    return fixture(input, init);
  };
  const pane = await openRulesPane();
  return { pane, writes, match };
}

describe("a reader-only install lists the organizer's copy", () => {
  it("a rule made there can be lifted over its domain's, and its controls wait outside posture pending", async () => {
    const pending = await mountPublishedRules(true);
    expect(pending.pane.getByText(/Studio laptop organizes your mail/)).toBeTruthy();
    await click(pending.pane.getByRole("button", { name: rules.liftAction }));
    await tick(1500);
    expect(pending.writes).toEqual([{
      method: "PATCH", path: `/api/rules/${PUBLISHED_RULE_ID}`,
      body: {
        key: { kind: "sender", match: pending.match, subjectContains: null, bodyContains: null },
        destination: "ohmail/News", priority: 5, applyRetro: false,
      },
    }]);
    expect(screen.queryByText("This rule decides their mail again.")).toBeNull();

    await teardownConfirmEnv();
    installRulesShell();

    const blocked = await mountPublishedRules(false);
    const lift = blocked.pane.getByRole<HTMLButtonElement>("button", { name: rules.liftAction });
    const row = lift.closest<HTMLElement>('[role="group"]');
    expect(row).toBeTruthy();
    const actions = within(row!);
    expect(lift.disabled).toBe(true);
    expect(actions.getByRole<HTMLButtonElement>("button", { name: "Files into News" }).disabled).toBe(true);
    expect(actions.getByRole<HTMLButtonElement>("button", { name: rules.revoke }).disabled).toBe(true);
    await click(lift);
    expect(blocked.writes).toEqual([]);
  });

  function relayRule(id: string, name: string, destination: RuleEntity["destination"]): RuleEntity {
    return {
      id, kind: "sender", match: [name, "shop.example.invalid"].join("@"), destination,
      priority: 0, enabled: true, provenance: "manual",
      stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
    };
  }

  const alice = relayRule("local-1", "alice", "ohmail/Receipts");
  const dana = relayRule("local-2", "dana", "ohmail/Receipts");
  const bob = relayRule("published-bob", "bob", "ohmail/News");
  const cy = relayRule("published-cy", "cy", "ohmail/News");
  const local = [alice, dana];
  const published = [{ ...alice, id: "published-alice" }, { ...dana, id: "published-dana" }, bob, cy];
  const names = { alice: /^Mail from alice@/, bob: /^Mail from bob@/ };
  const revoked = () => screen.queryAllByRole("status").some((status) => status.textContent?.includes("revoked."));

  it("names the holder; a rule made there has Change and Revoke and takes part in a bulk revoke", async () => {
    const { pane, writes } = await mountPublishedRules(true, { local, published });
    expect(pane.getByText(/^Studio laptop organizes your mail, and these are the rules it files by\./)).toBeTruthy();
    const row = within(pane.getByRole("group", { name: names.bob }));
    expect(row.getByRole<HTMLButtonElement>("button", { name: "Files into News" }).disabled).toBe(false);
    expect(row.getByRole<HTMLButtonElement>("button", { name: rules.revoke }).disabled).toBe(false);
    expect(pane.queryByText(/change or revoke it there/)).toBeNull();

    await click(pane.getByRole("button", { name: "Revoke all 4 matching" }));
    const dialog = within(screen.getByRole("dialog", { name: "Revoke 4 rules" }));
    expect(writes).toEqual([]);
    await click(dialog.getByRole("button", { name: "Revoke 4 rules" }));
    await tick(1500);
    expect(writes).toHaveLength(4);
    expect(writes).toEqual(expect.arrayContaining([
      { method: "DELETE", path: "/api/rules/local-1", body: null },
      { method: "DELETE", path: "/api/rules/local-2", body: null },
      { method: "DELETE", path: `/api/rules/${PUBLISHED_RULE_ID}`, body: { key: keyOf(bob) } },
      { method: "DELETE", path: `/api/rules/${PUBLISHED_RULE_ID}`, body: { key: keyOf(cy) } },
    ]));
    expect(screen.queryAllByRole("status").map((status) => status.textContent)).toContain(
      "Queued for Studio laptop — the rule is unchanged, and still filing mail, until its next pass.",
    );
    expect(revoked()).toBe(false);
    expect(pane.getAllByRole("listitem")).toHaveLength(4);
  });

  it("a twin row's Revoke sends the local id", async () => {
    const { pane, writes } = await mountPublishedRules(true, { local, published });
    const row = within(pane.getByRole("group", { name: names.alice }));
    await click(row.getByRole("button", { name: rules.revoke }));
    const dialog = within(screen.getByRole("dialog", { name: rules.revokeConfirm }));
    await click(dialog.getByRole("button", { name: rules.revokeConfirm }));
    await tick(1500);
    expect(writes).toEqual([{ method: "DELETE", path: "/api/rules/local-1", body: null }]);
    expect(within(pane.getByRole("group", { name: names.alice })).getByText(/^Removal waits on Studio laptop/)).toBeTruthy();
    expect(revoked()).toBe(false);
  });

  it("a waiting note rides its row by key: a create there reads as a change, a removal with no row still waits", async () => {
    const absent = relayRule("gone", "ellen", "INBOX");
    const waiting = [
      waitingRule("next-rule", "rule.create", alice, "INBOX"),
      waitingRule("remove-rule", "rule.delete", absent),
    ];
    const { pane, writes } = await mountPublishedRules(true, { local, published, waiting });
    const row = within(pane.getByRole("group", { name: names.alice }));
    expect(row.getByText(/^Change to Ohbox waits on Studio laptop/)).toBeTruthy();
    expect(row.queryByText(/^Removal waits/)).toBeNull();
    expect(pane.getByText(/^Removal waits on Studio laptop/)).toBeTruthy();
    expect(pane.queryByText(/Removed here/)).toBeNull();
    expect(writes).toEqual([]);
  });
});
