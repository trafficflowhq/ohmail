/** @vitest-environment jsdom */
import type { RuleEntity, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { bodyTermOf } from "@ohmail/app-logic/press/rule-list";
import messages from "../messages/en.json";
import { SENDER, TOKEN, ruleRow } from "./_ohbox-1-body-rule.js";
import {
  ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const { rules, settings } = messages;

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
});
afterEach(teardownConfirmEnv);

async function mountRules(items: RuleEntity[]) {
  scriptSync(() => Response.json({
    changes: {
      creates: items.map((entity, i) => ({
        type: "rule", op: "create", id: entity.id, seq: i + 1, updatedAt: ISO, entity,
      })),
      updates: [], moves: [], deletes: [],
    },
    cursor: String(items.length), hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));

  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb_1", address: "mailbox@example.invalid", status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO, providerConfirms: true,
      }] });
    }
    return fixture(input, init);
  };
  window.location.hash = "#/settings/rules";
  const frame = within(await mountCloudShell());
  await tick(3000);
  return within(frame.getByRole("region", { name: settings.rules }));
}

describe("the rules surface tells a body rule apart", () => {
  const bare = () => ruleRow({ id: "bare", destination: "INBOX" });
  const narrow = () => ruleRow({ id: "narrow", destination: "ohmail/News", bodyContains: TOKEN });

  it("reads a blank term as no term", () => {
    expect(bodyTermOf(ruleRow({ bodyContains: null }))).toBe("");
    expect(bodyTermOf(ruleRow({ bodyContains: "   " }))).toBe("");
    expect(bodyTermOf(ruleRow({ bodyContains: ` ${TOKEN} ` }))).toBe(TOKEN);
    const { bodyContains: _dropped, ...older } = ruleRow();
    expect(bodyTermOf(older as RuleEntity)).toBe("");
  });

  it("finds a rule by its body term, not only by its address", async () => {
    const pane = await mountRules([bare(), narrow()]);
    const search = pane.getByRole("searchbox", { name: rules.searchLabel });
    const rows = () => pane.getAllByRole("listitem").map((row) => within(row).getByRole("group"));
    await act(async () => { fireEvent.change(search, { target: { value: "ninjafirewall" } }); });
    const matches = rows();
    expect(matches).toHaveLength(1);
    expect(matches[0]?.textContent).toContain(TOKEN);
    await act(async () => { fireEvent.change(search, { target: { value: "sichersatt" } }); });
    expect(rows()).toHaveLength(2);
    expect(rows()).toContain(matches[0]);
  });

  it("RENDERS the body term on the row, and both terms when a rule carries both", async () => {
    const pane = await mountRules([bare(), narrow(), ruleRow({
      id: "both", destination: "ohmail/News", subjectContains: "Alert", bodyContains: TOKEN,
    })]);
    const rows = pane.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const bareRow = pane.getByRole("group", { name: (name) => name.includes(SENDER) && !name.includes(TOKEN) });
    expect(bareRow.textContent).not.toContain(TOKEN);
    const narrowRow = pane.getByRole("group", { name: (name) => name.includes(TOKEN) && !name.includes("Alert") });
    expect(narrowRow.textContent).toContain(TOKEN);
    expect(narrowRow.textContent).toContain("text");
    const both = pane.getByRole("group", { name: (name) => name.includes(TOKEN) && name.includes("Alert") });
    expect(both.textContent).toContain("Alert");
    expect(both.textContent).toContain(TOKEN);
    await act(async () => within(narrowRow).getByRole("button", { name: rules.revoke }).click());
    const confirm = screen.getByRole("dialog", { name: "Revoke 1 rule" });
    expect(confirm.textContent).toContain(TOKEN);
  });
});
