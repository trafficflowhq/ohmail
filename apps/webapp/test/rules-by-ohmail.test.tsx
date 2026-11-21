/** @vitest-environment jsdom */
import type { RuleEntity as RuleDTO, SyncResponse } from "@ohmail/wire";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { splitByDecider } from "@ohmail/app-logic/press/rule-list";
import messages from "../messages/en.json";
import {
  ACCOUNT,
  act,
  installConfirmEnv,
  ISO,
  mountCloudShell,
  refresh204,
  rememberOwner,
  scriptRefresh,
  scriptSession,
  scriptSync,
  sessionFull,
  teardownConfirmEnv,
  tick,
  warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const R = messages.rules;
const rule = (id: string, match: string, over: Partial<RuleDTO> = {}): RuleDTO => ({
  id, kind: "sender", match, destination: "ohmail/Screened", priority: 0, provenance: "promoted",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", ...over,
});

let host: HTMLElement;
let revoked: string[];

beforeAll(warmCloudShell);
beforeEach(() => {
  revoked = [];
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
});
afterEach(teardownConfirmEnv);

async function open(rules: RuleDTO[]): Promise<void> {
  scriptSync(() => Response.json({
    changes: {
      creates: rules.map((rule, index) => ({
        type: "rule", op: "create", id: rule.id, seq: index + 1, updatedAt: ISO, entity: rule,
      })),
      updates: [],
      moves: [],
      deletes: revoked.map((id, index) => ({
        type: "rule", op: "delete", id, seq: rules.length + index + 1, updatedAt: ISO, entity: null,
      })),
    },
    cursor: `c${rules.length + revoked.length}`,
    hasMore: false,
    serverTime: ISO,
  } satisfies SyncResponse));
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/mailboxes") return Response.json({
      items: [{
        id: "mb-1", address: ["reader", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO,
        organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      }],
    }, { headers: { "X-Ohmail-Account": ACCOUNT } });
    const rule = rules.find((rule) => path === `/api/rules/${rule.id}`);
    if (init?.method === "DELETE" && rule) {
      revoked.push(rule.id);
      return new Response(null, { status: 204, headers: { "x-sync-seq": String(rules.length + revoked.length), "X-Ohmail-Account": ACCOUNT } });
    }
    return fetch(input, init);
  };
  window.location.hash = "#/settings/rules";
  const frame = await mountCloudShell();
  await tick(3000);
  host = within(frame).getByRole("region", { name: messages.settings.rules });
}

const lists = (): HTMLElement[] => within(host).getAllByRole("list");
const rowsIn = (list: HTMLElement): HTMLElement[] => within(list).getAllByRole("listitem");
const namesIn = (list: HTMLElement): Array<string | null | undefined> =>
  rowsIn(list).map((row) => row.querySelector(".oh-ruleline-name")?.textContent);

describe("the act's rules in their own group", () => {
  it("draws them under their own label, each saying where it came from", async () => {
    const rules = [
      rule("p1", "friend@press.example", { destination: "INBOX" }),
      rule("a1", "news@act.example", { byOhmail: true }),
      rule("p2", "shop@press.example"),
      rule("a2", "promo@act.example", { byOhmail: true }),
    ].map((row, index) => ({
      ...row,
      createdAt: new Date(Date.parse(ISO) - index * 1000).toISOString(),
    }));
    await open(rules);
    const [yours, ohmail] = lists();
    expect(lists()).toHaveLength(2);
    expect(host.textContent).toContain(R.groupByOhmail);
    expect(ohmail!.getAttribute("aria-label")).toBe(R.groupByOhmail);
    expect(namesIn(yours!)).toEqual([rules[0]!.match, rules[2]!.match]);
    expect(namesIn(ohmail!), "the act's rules are listed as a person's").toEqual([rules[1]!.match, rules[3]!.match]);
    for (const r of rowsIn(ohmail!)) {
      expect(r.textContent).toContain(R.origin.byOhmail);
      expect(r.textContent).not.toContain(R.origin.promoted);
      expect(r.getAttribute("aria-setsize")).toBe("2");
    }
    for (const r of rowsIn(yours!)) expect(r.textContent).toContain(R.origin.promoted);
    expect(rowsIn(ohmail!).map((r) => r.getAttribute("aria-posinset"))).toEqual(["1", "2"]);
  });

  it("with the same undo", async () => {
    await open([rule("p1", "friend@press.example"), rule("a1", "news@act.example", { byOhmail: true })]);
    const row = within(host).getAllByRole("listitem")
      .find((candidate) => candidate.textContent?.includes(R.origin.byOhmail))!;
    const revoke = within(row).getByRole("button", { name: R.revoke });
    await act(async () => { revoke.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: R.revokeConfirm });
    await act(async () => { confirm.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick(500);
    expect(revoked).toEqual(["a1"]);
  });

  it("CONTROL: with no rule of ohmail's there is one list and no label", async () => {
    await open([rule("p1", "friend@press.example"), rule("p2", "shop@press.example", { byOhmail: false })]);
    expect(lists()).toHaveLength(1);
    expect(host.textContent).not.toContain(R.groupByOhmail);
  });

  it("a rule from a server that sends no mark is a person's", () => {
    const { yours, ohmail } = splitByDecider([rule("x", "a@b.example"), rule("y", "c@d.example", { byOhmail: true })]);
    expect(yours.map((r) => r.id)).toEqual(["x"]);
    expect(ohmail.map((r) => r.id)).toEqual(["y"]);
  });
});
