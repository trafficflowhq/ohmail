/** @vitest-environment jsdom */
import { act, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RuleEntity, SyncResponse } from "@ohmail/wire";
import messages from "../messages/en.json";
import { expectHeard, walk } from "./_windowed-list-hearing.js";
import {
  ISO, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const N = 600;
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

describe("a windowed list announces its true size and every row's true position", () => {
  it("the Rules list, six hundred rules", async () => {
    const rows = Array.from({ length: N }, (_, i): RuleEntity => ({
      id: `rule-${i}`,
      kind: "sender",
      match: `sender${String(i).padStart(3, "0")}@example.test`,
      destination: "INBOX",
      priority: 0,
      provenance: "manual",
      enabled: true,
      stats: { hits: 0, lastHitAt: null, demotions: 0 },
      createdAt: ISO,
      updatedAt: ISO,
    }));
    scriptSync(() => json({
      changes: {
        creates: rows.map((rule, i) => ({
          type: "rule", op: "create", id: rule.id, seq: i + 1, updatedAt: ISO, entity: rule,
        })),
        updates: [], moves: [], deletes: [],
      },
      cursor: "c600", hasMore: false, serverTime: ISO,
    } satisfies SyncResponse));
    const fixture = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/mailboxes") {
        return Promise.resolve(json({
          items: [{
            id: "mb-1", address: "mailbox@example.test", status: "connected", organizerRole: "organizer",
            initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
          }],
        }));
      }
      return fixture(input, init);
    };
    window.location.hash = "#/settings";
    const el = await mountCloudShell();
    await tick(3000);
    const rail = within(el).getByRole("navigation", { name: messages.settings.navAria });
    await act(async () => { within(rail).getByRole("button", { name: messages.settings.rules }).click(); });
    await tick(250);

    const pane = within(el).getByRole("region", { name: messages.settings.rules });
    const list = within(pane).getByRole("list", { name: messages.settings.rules });
    const scroller = list.closest<HTMLElement>(".oh-sheet-scroll")!;
    expect(scroller, "the rules have their own settings scrollport").not.toBeNull();
    const heard = await walk(pane, scroller, N, { advance: tick, fallbackKey: (row) => row.textContent ?? "" });
    expectHeard(heard, { [messages.settings.rules]: N });
  }, 20_000);
});
