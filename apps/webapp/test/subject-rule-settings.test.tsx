/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import type { RuleEntity, SyncResponse } from "@ohmail/wire";
import { subjectTermOf } from "@ohmail/app-logic/press/rule-list";
import messages from "../messages/en.json";
import {
  installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const SENDER = ["info", "sichersatt.example"].join("@");
const TOKEN = "[NinjaFirewall]";
const { rules, settings } = messages;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function rule(id: string, subjectContains: string | null = null): RuleEntity {
  return {
    id,
    kind: "sender",
    match: SENDER,
    destination: id === "narrow" ? "ohmail/News" : "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    subjectContains,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO,
    updatedAt: ISO,
  };
}

describe("the rules surface can tell two rules for one address apart", () => {
  beforeAll(warmCloudShell);
  beforeEach(() => {
    installConfirmEnv();
    rememberOwner();
    scriptRefresh(refresh204);
    scriptSession(sessionFull);
  });
  afterEach(teardownConfirmEnv);

  async function mountRules() {
    const items = [rule("bare"), rule("narrow", TOKEN)];
    scriptSync(() => json({
      changes: {
        creates: items.map((item, index) => ({
          type: "rule", op: "create", id: item.id, seq: index + 1, updatedAt: ISO, entity: item,
        })),
        updates: [], moves: [], deletes: [],
      },
      cursor: "c2", hasMore: false, serverTime: ISO,
    } satisfies SyncResponse));

    const fixture = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/mailboxes") {
        return json({ items: [{
          id: "mb-1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
          organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
          lastSyncAt: ISO, createdAt: ISO,
        }] });
      }
      return fixture(input, init);
    };

    window.location.hash = "#/settings/rules";
    const frame = await mountCloudShell();
    await tick(3000);
    return within(within(frame).getByRole("region", { name: settings.rules }));
  }

  it("reads a blank term as no term", () => {
    expect(subjectTermOf(rule("bare"))).toBe("");
    expect(subjectTermOf(rule("bare", "   "))).toBe("");
    expect(subjectTermOf(rule("bare", "\t\n"))).toBe("");
    expect(subjectTermOf(rule("narrow", ` ${TOKEN} `))).toBe(TOKEN);
  });

  it("finds a rule by its subject term, not only by its address", async () => {
    const pane = await mountRules();
    const search = pane.getByRole("searchbox", { name: rules.searchLabel });
    const rows = () => pane.getAllByRole("listitem")
      .map((row) => within(row).getByRole("group").getAttribute("aria-label") ?? "");
    await act(async () => fireEvent.change(search, { target: { value: "ninjafirewall" } }));
    const narrow = rows();
    expect(narrow).toHaveLength(1);
    expect(narrow[0]).toContain(TOKEN);
    await act(async () => fireEvent.change(search, { target: { value: "sichersatt" } }));
    expect(rows()).toHaveLength(2);
    expect(rows()).toContain(narrow[0]);
  });

  it("RENDERS the two rules differently, and names the term in the revoke confirm", async () => {
    const pane = await mountRules();
    const rows = pane.getAllByRole("listitem").map((row) => within(row).getByRole("group"));
    expect(rows).toHaveLength(2);
    const whats = rows.map((row) => row.getAttribute("aria-label") ?? "");
    expect(whats.every((what) => what.includes(SENDER))).toBe(true);
    expect(whats.filter((what) => what.includes(TOKEN))).toHaveLength(1);
    expect(whats[0]).not.toBe(whats[1]);
    expect(rows.filter((row) => row.textContent?.includes(TOKEN))).toHaveLength(1);

    const narrowRow = pane.getByRole("group", { name: whats.find((what) => what.includes(TOKEN)) });
    await act(async () => within(narrowRow).getByRole("button", { name: rules.revoke }).click());
    const confirm = screen.getByRole("dialog", { name: "Revoke 1 rule" });
    expect(confirm, "revoking did not open the confirm").toBeTruthy();
    expect(confirm.textContent).toContain(TOKEN);
  });
});
