/** @vitest-environment jsdom */
import type { RuleEntity as RuleDTO, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";
import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

function rule(over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id: "r-1",
    kind: "sender",
    match: "lena@atelier-eichspan.example",
    destination: "INBOX",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

/**
 * A REAL ROW OFF THE PRODUCTION API, PASTED VERBATIM.
 *
 * Fetched 2026-08-04 from `GET https://api.ohmail.app/rules`, signed in as a test account
 * (never a person's own). It is the whole point of pinning it: every
 * fixture in this file was written by the same hand that wrote the component, so a field the
 * server actually sends in a different shape would be invisible to all of them. Note `stats`
 * — `hits: 0` on a rule that has been live since 3 August, which is the dead-counter finding
 * as the production database reports it, not as the schema promises it.
 */
const PRODUCTION_RULE: RuleDTO = {
  id: "db20a01d-7f59-465e-be48-2084ddfa137b",
  kind: "sender",
  match: "contact.442@quietharbor.invalid",
  destination: "INBOX",
  priority: 0,
  provenance: "promoted",
  enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-08-03T23:05:11.143Z",
  updatedAt: "2026-08-03T23:05:11.143Z",
};

const R = messages.rules;
const SETTINGS = messages.settings;
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const sentence = (item: RuleDTO) => item.kind === "domain" ? `Mail from anyone at ${item.match}` : `Mail from ${item.match}`;

async function renderRules(items: RuleDTO[]) {
  scriptSync(() => json({
    changes: {
      creates: items.map((entity, index) => ({
        type: "rule", op: "create", id: entity.id, seq: index + 1, updatedAt: entity.updatedAt, entity,
      })),
      updates: [], moves: [], deletes: [],
    },
    cursor: `c${items.length}`, hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));
  const wire = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/mailboxes") {
      return json({ items: [{
        id: "mb-1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    return wire(input, init);
  };

  window.location.hash = "#/settings";
  const host = within(await mountCloudShell());
  await tick(3000);
  const nav = within(host.getByRole("navigation", { name: SETTINGS.navAria }));
  await click(nav.getByRole("button", { name: SETTINGS.rules }));
  const pane = within(host.getByRole("region", { name: SETTINGS.rules }));
  const list = pane.getByRole("list", { name: SETTINGS.rules });
  return {
    pane,
    list,
    row: (item: RuleDTO) => within(list).getByRole("group", { name: sentence(item) }),
  };
}

async function click(button: HTMLElement) {
  await act(async () => { button.click(); });
  await tick(250);
}

describe("an unwired shell gets no pane at all", () => {
  it("omits Rules from the nav when the prop is absent", async () => {
    const { installShellEnv, mailbox, mountShell, teardownShellEnv, goTo } =
      await import("./fixtures/live-walk-shell");
    const { WEB_PANE_PARTS } = await import("../app/(product)/mailbox/pane-parts");
    installShellEnv();
    try {
      const frame = await mountShell([mailbox()], { general: WEB_PANE_PARTS.general });
      await goTo("settings");
      const nav = within(frame).getByRole("navigation", { name: SETTINGS.navAria });
      expect(within(nav).getByRole("button", { name: SETTINGS.general })).toBeTruthy();
      expect(within(nav).queryByRole("button", { name: SETTINGS.rules })).toBeNull();
    } finally {
      await teardownShellEnv();
    }
  });
});

function useRulesFixture() {
  beforeAll(warmCloudShell);
  beforeEach(() => {
    installConfirmEnv();
    rememberOwner();
    scriptRefresh(refresh204);
    scriptSession(sessionFull);
  });
  afterEach(async () => {
    setActiveFormatZone(null);
    await teardownConfirmEnv();
  });

}

describe("the pane exists and says what the rule is", () => {
  useRulesFixture();

  it("lists the sender, where it files, when it was made and where it came from", async () => {
    const item = rule();
    const { row } = await renderRules([item]);
    const text = within(row(item));
    expect(text.getByRole("button", { name: item.match })).toBeTruthy();
    expect(text.getByRole("button", { name: "Files into Ohbox" })).toBeTruthy();
    expect(text.getByText("Screener decision · 1 Aug 2026")).toBeTruthy();
  });

  it("says 'anyone at' for a domain rule — a domain is a different promise from an address", async () => {
    const item = rule({ kind: "domain", match: "lichtgrat.example" });
    const { list, row } = await renderRules([item]);
    expect(row(item).getAttribute("aria-label")).toBe("Mail from anyone at lichtgrat.example");
    expect(within(list).queryByRole("group", { name: "Mail from lichtgrat.example" })).toBeNull();
  });
});

describe("against a row the production API actually returned", () => {
  useRulesFixture();

  it("renders it whole, and still claims no count", async () => {
    setActiveFormatZone("UTC");
    const { pane, row } = await renderRules([PRODUCTION_RULE]);
    const text = within(row(PRODUCTION_RULE));
    expect(text.getByRole("button", { name: PRODUCTION_RULE.match })).toBeTruthy();
    expect(text.getByRole("button", { name: "Files into Ohbox" })).toBeTruthy();
    expect(text.getByText("Screener decision · 3 Aug 2026")).toBeTruthy();
    expect(pane.queryByText(/\b0 messages\b/)).toBeNull();
  });
});

describe("the long list is windowed", () => {
  useRulesFixture();

  it("mounts a viewport's worth of rows, not the whole set", async () => {
    const items = Array.from({ length: 1200 }, (_, i) =>
      rule({ id: `r-${i}`, match: [`sender-${i}`, "example.invalid"].join("@"),
        createdAt: new Date(Date.parse(ISO) - i * 1000).toISOString() }),
    );
    const { list } = await renderRules(items);
    const mounted = within(list).getAllByRole("listitem");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(120);
    expect(mounted[0]!.getAttribute("aria-setsize")).toBe("1200");
  });
});

describe("rule confirmations", () => {
  useRulesFixture();

  const three = [1, 2, 3].map((i) => rule({
    id: `r-${i}`, match: [`sender-${i}`, "example.invalid"].join("@"),
    createdAt: new Date(Date.parse(ISO) - i * 1000).toISOString(),
  }));
  const [first, target, last] = three as [RuleDTO, RuleDTO, RuleDTO];
  const filesInto = (row: HTMLElement) => within(row).getByRole("button", { name: "Files into Ohbox" });
  const dialogs = () => within(document.body);

  it("the destination picker names the rule at the selected row", async () => {
    const { row } = await renderRules(three);
    await click(filesInto(row(target)));
    const picker = within(dialogs().getByRole("dialog", { name: R.change }));
    expect(picker.getByText(target.match)).toBeTruthy();
    expect(picker.queryByText(first.match)).toBeNull();
    expect(picker.queryByText(last.match)).toBeNull();
  });

  it("the revoke confirmation names only the selected rule", async () => {
    const { row } = await renderRules(three);
    await click(within(row(target)).getByRole("button", { name: R.revoke }));
    const confirm = within(dialogs().getByRole("dialog", { name: "Revoke 1 rule" }));
    expect(confirm.getByText(sentence(target))).toBeTruthy();
    expect(confirm.queryByText(sentence(first))).toBeNull();
    expect(confirm.queryByText(sentence(last))).toBeNull();
  });

  it("cancel closes the confirm in place and clears the marker — nothing else moves", async () => {
    const { list, row } = await renderRules(three);
    const trigger = filesInto(row(target));
    await click(trigger);
    const picker = dialogs().getByRole("dialog", { name: R.change });
    await act(async () => { picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await tick(250);
    expect(dialogs().queryByRole("dialog", { name: R.change })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(within(list).getAllByRole("group").map((el) => el.getAttribute("aria-label"))).toEqual(three.map(sentence));
  });

  it("the row's own buttons say whether their confirm is open", async () => {
    const { row } = await renderRules(three);
    const trigger = filesInto(row(target));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(filesInto(row(first)).getAttribute("aria-expanded")).toBe("false");
    expect(filesInto(row(last)).getAttribute("aria-expanded")).toBe("false");
  });

  it("bulk revoke discloses the whole matching set outside the list", async () => {
    const { pane, list } = await renderRules(three);
    await click(pane.getByRole("button", { name: "Revoke all 3 matching" }));
    const confirm = dialogs().getByRole("dialog", { name: "Revoke 3 rules" });
    expect(list.contains(confirm)).toBe(false);
  });
});
