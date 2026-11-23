/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { fireEvent, within } from "@testing-library/react";
import type { RuleEntity, SyncResponse } from "@ohmail/wire";
import { groupByDestination, ruleDate } from "@ohmail/app-logic/press/rule-list";
import { setActiveFormatZone } from "../app/shell/locale";
import messages from "../messages/en.json";
import {
  installConfirmEnv,
  ISO,
  mountCloudShell,
  refresh204,
  rememberOwner,
  scriptRefresh,
  scriptSession,
  scriptSync,
  sessionFull,
  syncCalls,
  teardownConfirmEnv,
  tick,
  warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const rules = messages.rules;
const settings = messages.settings;
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
});
afterEach(teardownConfirmEnv);

function rule(id: string, domain: string, destination: RuleEntity["destination"] = "INBOX"): RuleEntity {
  return {
    id,
    kind: "sender",
    match: [id, `${domain}.example.invalid`].join("@"),
    destination,
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO,
    updatedAt: ISO,
  };
}

async function mountRulesList(items: RuleEntity[], { keepDates = false } = {}) {
  scriptSync(() =>
    json({
      changes: {
        creates: items.map((item, index) => ({
          type: "rule",
          op: "create",
          id: item.id,
          seq: index + 1,
          updatedAt: ISO,
          entity: keepDates
            ? item
            : { ...item, createdAt: new Date(Date.parse(ISO) - index * 1000).toISOString() },
        })),
        updates: [],
        moves: [],
        deletes: [],
      },
      cursor: `c${items.length}`,
      hasMore: false,
      serverTime: ISO,
    } satisfies SyncResponse),
  );
  const writes: string[] = [];
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET" && /^\/api\/(rules|messages)(\/|$)/.test(path)) writes.push(`${method} ${path}`);
    if (path === "/api/mailboxes") {
      return json({
        items: [
          {
            id: "mb-1",
            address: ["mailbox", "example.invalid"].join("@"),
            status: "connected",
            organizerRole: "organizer",
            initialImportCompletedAt: ISO,
            organizeConsentedAt: ISO,
            lastSyncAt: ISO,
            createdAt: ISO,
          },
        ],
      });
    }
    return fixture(input, init);
  };

  window.location.hash = "#/settings";
  const frame = await mountCloudShell();
  await tick(3000);
  const nav = within(frame).getByRole("navigation", { name: settings.navAria });
  await act(async () => {
    within(nav).getByRole("button", { name: settings.rules }).click();
  });
  await tick(250);
  expect(window.location.hash).toBe("#/settings/rules");

  const region = within(frame).getByRole("region", { name: settings.rules });
  const pane = within(region);
  const facets = () => within(pane.getByRole("group", { name: rules.facetLabel }));
  return {
    region,
    pane,
    writes,
    facets,
    items: () =>
      pane.queryAllByRole("listitem").map((row) => within(row).getByRole("group").getAttribute("aria-label")),
    async search(value: string) {
      const field = pane.getByRole("searchbox", { name: rules.searchLabel });
      await act(async () => {
        fireEvent.change(field, { target: { value } });
      });
    },
    async pick(name: string) {
      const facet = facets();
      await act(async () => {
        facet.getByRole("button", { name }).click();
      });
      expect(facet.getByRole("button", { name, pressed: true })).toBeTruthy();
    },
  };
}

const sentence = ({ match }: RuleEntity): string => `Mail from ${match}`;

describe("ruleDate", () => {
  afterEach(() => setActiveFormatZone(null));

  const dated = (id: string, createdAt: string): RuleEntity => ({ ...rule(id, "acme"), createdAt });

  it("always carries the year — a standing decision outlives the current one", async () => {
    setActiveFormatZone("UTC");
    const older = dated("alice", "2025-01-09T23:30:00.000Z");
    const newer = dated("birch", "2026-08-04T00:00:00.000Z");
    expect(ruleDate(older.createdAt)).toBe("9 Jan 2025");
    expect(ruleDate(newer.createdAt)).toBe("4 Aug 2026");

    const { pane } = await mountRulesList([older, newer], { keepDates: true });
    const olderRow = within(pane.getByRole("group", { name: sentence(older) }));
    const newerRow = within(pane.getByRole("group", { name: sentence(newer) }));
    expect(olderRow.getByText("Screener decision · 9 Jan 2025")).toBeTruthy();
    expect(newerRow.getByText("Screener decision · 4 Aug 2026")).toBeTruthy();
  });

  it("dates a rule by the reader's day: made at 00:59 in Zurich it reads that day, not UTC's", async () => {
    const item = dated("alice", "2026-10-22T22:59:00.000Z");
    setActiveFormatZone("Europe/Zurich");
    expect(ruleDate(item.createdAt)).toBe("23 Oct 2026");
    const { pane } = await mountRulesList([item], { keepDates: true });
    const row = within(pane.getByRole("group", { name: sentence(item) }));
    expect(row.getByText("Screener decision · 23 Oct 2026")).toBeTruthy();
    expect(row.queryByText(/22 Oct 2026/)).toBeNull();

    setActiveFormatZone("America/New_York");
    expect(ruleDate("2026-01-01T03:00:00.000Z")).toBe("31 Dec 2025");
  });

  it("renders nothing for an unparseable stamp rather than 'Invalid Date'", async () => {
    const item = dated("alice", "not a date");
    expect(ruleDate(item.createdAt)).toBe("");
    const { pane } = await mountRulesList([item], { keepDates: true });
    const row = within(pane.getByRole("group", { name: sentence(item) }));
    expect(row.getByText(/Screener decision/)).toBeTruthy();
    expect(row.queryByText(/Invalid Date|not a date/)).toBeNull();
  });
});

describe("the pane exists and says what the rule is", () => {
  it("distinguishes a rule the user made from one a Screener decision made", async () => {
    const manual = { ...rule("alice", "acme"), provenance: "manual" } as const;
    const promoted = rule("birch", "shops");
    const { pane } = await mountRulesList([manual, promoted]);
    const userRule = within(pane.getByRole("group", { name: sentence(manual) }));
    const screenerRule = within(pane.getByRole("group", { name: sentence(promoted) }));
    expect(userRule.getByText(/You made this one/)).toBeTruthy();
    expect(screenerRule.getByText(/Screener decision/)).toBeTruthy();
  });

  it("says a paused rule sorts nothing, rather than showing it like a live one", async () => {
    const paused = { ...rule("alice", "acme"), enabled: false };
    const live = rule("birch", "shops");
    const { pane } = await mountRulesList([paused, live]);
    const pausedRow = within(pane.getByRole("group", { name: sentence(paused) }));
    const liveRow = within(pane.getByRole("group", { name: sentence(live) }));
    expect(pausedRow.getByText(/paused, so it sorts nothing/)).toBeTruthy();
    expect(liveRow.queryByText(/paused, so it sorts nothing/)).toBeNull();
  });

  it("claims no message count anywhere", async () => {
    const existing = rule("alice", "acme");
    const { region, pane } = await mountRulesList([existing]);
    expect(pane.getByRole("group", { name: sentence(existing) })).toBeTruthy();
    const text = region.textContent ?? "";
    expect(text).not.toMatch(/\b0 messages\b/);
    expect(text).not.toMatch(/\bmessages? filed\b/);
    expect(text).not.toContain("Nothing records how many messages a rule has filed");
  });

  it("an account with no rules says so, and still says the count is not recorded", async () => {
    const view = await mountRulesList([]);
    expect(syncCalls()).toBeGreaterThan(0);
    expect(view.items()).toEqual([]);
    expect(view.region.textContent).toContain("No rules yet.");
    expect(view.region.textContent).not.toContain("Nothing records how many messages a rule has filed");
    expect(view.writes).toEqual([]);
  });
});

describe("grouping rules by destination", () => {
  it("buckets each rule under its own destination, canonical order first", async () => {
    const a = rule("alice", "acme", "ohmail/News");
    const b = rule("birch", "shops");
    const c = rule("casey", "acme", "ohmail/News");
    const view = await mountRulesList([a, b, c]);
    expect(
      view
        .facets()
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["All", "Ohbox", "News"]);
    await view.pick("Ohbox");
    expect(view.items()).toEqual([sentence(b)]);
    await view.pick("News");
    expect(view.items()).toEqual([sentence(a), sentence(c)]);
  });

  it("returns no bucket for a destination with no rules", async () => {
    const item = rule("alice", "acme");
    expect(groupByDestination([item]).map((group) => group.destination)).toEqual(["INBOX"]);
    const view = await mountRulesList([item]);
    expect(view.items()).toEqual([sentence(item)]);
    expect(view.facets().getAllByRole("button").map((button) => button.textContent)).toEqual(["All", "Ohbox"]);
    await view.pick("Ohbox");
    expect(view.items()).toEqual([sentence(item)]);
  });
});

describe("search over the rules list", () => {
  const a = rule("alice", "ACME");
  const b = rule("birch", "shops");
  const c = rule("casey", "acme", "ohmail/News");

  it("filterRules keeps only rules whose match contains the query, case-insensitively", async () => {
    const view = await mountRulesList([a, b, c]);
    await view.search("AcMe");
    expect(view.items()).toEqual([sentence(a), sentence(c)]);
    await view.search("  ");
    expect(view.items()).toEqual([sentence(a), sentence(b), sentence(c)]);
  });

  it("filterRules narrows to the chosen destination and combines with the query", async () => {
    const other = rule("dogwood", "shops", "ohmail/News");
    const view = await mountRulesList([a, c, other]);
    await view.pick("News");
    expect(view.items()).toEqual([sentence(c), sentence(other)]);
    await view.search("acme");
    expect(view.items()).toEqual([sentence(c)]);
    expect(view.writes).toEqual([]);
  });

  it("typing in the search box drops the rows that no longer match", async () => {
    const view = await mountRulesList([a, b, c]);
    expect(view.items()).toEqual([sentence(a), sentence(b), sentence(c)]);
    await view.search("acme");
    expect(view.items()).toEqual([sentence(a), sentence(c)]);
    expect(view.pane.queryByRole("group", { name: sentence(b) })).toBeNull();
  });

  it("a query that matches nothing says so, and still says the count is not recorded", async () => {
    const view = await mountRulesList([a, b]);
    expect(view.items()).toEqual([sentence(a), sentence(b)]);
    await view.search("nobody-here");
    expect(view.items()).toEqual([]);
    expect(view.region.textContent).toContain("No rules match");
    expect(view.pane.queryByText(/^Nothing records how many messages a rule has filed/)).toBeNull();
    expect(view.pane.getByText("0")).toBeTruthy();
  });
});

describe("the destination facet", () => {
  it("clicking a destination chip narrows the list to that bucket", async () => {
    const inbox = rule("alice", "shops");
    const news = rule("birch", "acme", "ohmail/News");
    const receipts = rule("casey", "paper", "ohmail/Receipts");
    const view = await mountRulesList([inbox, news, receipts]);
    expect(
      view
        .facets()
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["All", "Ohbox", "News", "Receipts"]);
    await view.pick("News");
    expect(view.items()).toEqual([sentence(news)]);
  });
});
