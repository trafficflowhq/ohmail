/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { screen, within } from "@testing-library/react";
import type { RuleEntity, SyncResponse } from "@ohmail/wire";
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core/folder-name";
import messages from "../messages/en.json";
import {
  installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const R = messages.rules;
const settings = messages.settings;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function rule(id: string, destination: RuleEntity["destination"] = "INBOX"): RuleEntity {
  return {
    id,
    kind: "sender",
    match: [id, "example.invalid"].join("@"),
    destination,
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO,
    updatedAt: ISO,
  };
}

let online: PropertyDescriptor | undefined;
beforeAll(warmCloudShell);
beforeEach(() => {
  online = Object.getOwnPropertyDescriptor(navigator, "onLine");
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
});

afterEach(async () => {
  await teardownConfirmEnv();
  if (online === undefined) Reflect.deleteProperty(navigator, "onLine");
  else Object.defineProperty(navigator, "onLine", online);
});

const click = async (button: HTMLElement): Promise<void> => {
  await act(async () => { button.click(); });
  await tick(0);
};

const reports = (): Array<string | null> =>
  screen.queryAllByRole("status").map((region) => region.textContent);

// The pane reads its rule and the deletion echo from sync. The DELETE reply
// stays bodiless, as it does on the service.
async function mountedRules({
  items = [rule("r-1")],
  refusals = {},
  confirmLater,
}: {
  items?: RuleEntity[];
  refusals?: Readonly<Record<string, 403 | 500>>;
  confirmLater?: Promise<void>;
} = {}) {
  const mutations: Array<{ method: string; path: string }> = [];
  const byPath = new Map(items.map((item) => [`/api/rules/${item.id}`, item]));
  const removed = new Map<string, number>();
  let syncedDeletion = false;
  scriptSync(() => {
    if (removed.size > 0) syncedDeletion = true;
    const page: SyncResponse = {
      changes: {
        creates: items.map((item, index) => ({
          type: "rule", op: "create", id: item.id, seq: index + 1, updatedAt: ISO, entity: item,
        })),
        updates: [], moves: [],
        deletes: [...removed].map(([id, seq]) => ({
          type: "rule", op: "delete", id, seq, updatedAt: ISO, entity: null,
        })),
      },
      cursor: `c${items.length + removed.size}`, hasMore: false, serverTime: ISO,
    };
    return json(page);
  });

  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/mailboxes") {
      return json({ items: [{
        id: "mb-1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    const method = init?.method ?? "GET";
    if (method !== "GET" && /^\/api\/(rules|messages)(\/|$)/.test(path)) mutations.push({ method, path });
    const item = byPath.get(path);
    if (item && method === "DELETE") {
      if (!navigator.onLine) throw new TypeError("Failed to fetch");
      const refused = refusals[item.id];
      if (refused) {
        const code = refused === 403 ? "forbidden" : "internal";
        return json({ error: { code, message: "The server refused this rule.", retryable: refused === 500 } }, refused);
      }
      await confirmLater;
      const seq = removed.get(item.id) ?? items.length + removed.size + 1;
      removed.set(item.id, seq);
      return new Response(null, { status: 204, headers: { "x-sync-seq": String(seq) } });
    }
    return fixture(input, init);
  };

  window.location.hash = "#/settings";
  const frame = await mountCloudShell();
  await tick(3000);
  const nav = within(frame).getByRole("navigation", { name: settings.navAria });
  await click(within(nav).getByRole("button", { name: settings.rules }));
  await tick(250);
  expect(window.location.hash).toBe("#/settings/rules");
  const pane = within(within(frame).getByRole("region", { name: settings.rules }));
  const revoke = () => pane.getByRole<HTMLButtonElement>("button", { name: R.revoke });
  expect(pane.getAllByRole<HTMLButtonElement>("button", { name: R.revoke }).every((button) => !button.disabled)).toBe(true);
  const confirm = () => within(screen.getByRole("dialog", { name: R.revokeConfirm }));
  return { mutations, pane, revoke, confirm, syncedDeletion: () => syncedDeletion };
}

describe("revoking", () => {
  it("does NOT dispatch on the first click; it shows the disclosure first", async () => {
    const { mutations, revoke, confirm } = await mountedRules();
    await click(revoke());
    expect(mutations).toEqual([]);
    expect(confirm().getByText("This stops the rule deciding new mail. Mail it already filed stays where it is.")).toBeTruthy();
  });

  it("dispatches the revoke only on the confirm under that sentence", async () => {
    const { mutations, revoke, confirm } = await mountedRules({ items: [rule("r-9")] });
    await click(revoke());
    expect(mutations).toEqual([]);
    expect(confirm().getByText(R.revokeExplain)).toBeTruthy();
    await click(confirm().getByRole("button", { name: R.revokeConfirm }));
    expect(mutations).toEqual([{ method: "DELETE", path: "/api/rules/r-9" }]);
  });

  it("cancel dispatches nothing and closes the disclosure", async () => {
    const { mutations, revoke, confirm } = await mountedRules();
    await click(revoke());
    expect(confirm().getByText(R.revokeExplain)).toBeTruthy();
    await click(confirm().getByRole("button", { name: R.cancel }));
    expect(mutations).toEqual([]);
    expect(screen.queryByText(/Mail it already filed stays where it is\./)).toBeNull();
    expect(revoke()).toBeTruthy();
  });
});

describe("the toast reports the outcome, not the intent", () => {
  it("confirmed says the rule is gone and the mail has not moved", async () => {
    let accepted!: () => void;
    const confirmLater = new Promise<void>((resolve) => { accepted = resolve; });
    const { mutations, pane, revoke, confirm, syncedDeletion } = await mountedRules({ confirmLater });
    await click(revoke());
    await click(confirm().getByRole("button", { name: R.revokeConfirm }));
    expect(mutations).toEqual([{ method: "DELETE", path: "/api/rules/r-1" }]);
    expect(reports()).not.toEqual(expect.arrayContaining([expect.stringContaining("Rule revoked.")]));
    accepted();
    await tick(1500);
    expect(syncedDeletion()).toBe(true);
    expect(pane.getByText(/^No rules yet\./)).toBeTruthy();
    expect(pane.queryByRole("button", { name: R.revoke })).toBeNull();
    expect(reports()).toContain("Rule revoked. Your mail hasn't moved.");
  });

  it("ROLLED BACK never claims the rule was revoked", async () => {
    const { mutations, revoke, confirm } = await mountedRules({ refusals: { "r-1": 403 } });
    await click(revoke());
    await click(confirm().getByRole("button", { name: R.revokeConfirm }));
    expect(mutations).toEqual([{ method: "DELETE", path: "/api/rules/r-1" }]);
    expect(screen.getByText("Couldn't revoke that rule. It's still in place.")).toBeTruthy();
    expect(reports()).not.toEqual(expect.arrayContaining([expect.stringContaining("Rule revoked.")]));
    expect((revoke() as HTMLButtonElement).disabled).toBe(false);
  });

  it("queued says queued, and does not claim the rule is revoked", async () => {
    const { pane, revoke, confirm } = await mountedRules();
    await click(revoke());
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    await click(confirm().getByRole("button", { name: R.revokeConfirm }));
    expect(reports()).toContain("Revoke queued — it'll go through when you're back online.");
    expect(reports()).not.toContain("Rule revoked. Your mail hasn't moved.");
    expect(pane.getByText("Revoke not sent yet. Still filing mail until it is.")).toBeTruthy();
    expect((revoke() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("bulk revoke acts over the FILTERED set, through the per-rule path", () => {
  const items = [
    rule("i1"), rule("i2"), rule("r1", "ohmail/News"), rule("r2", "ohmail/News"),
  ];

  it("revokes exactly the filtered rules — not all of them — after the two-click disclosure", async () => {
    const { mutations, pane } = await mountedRules({ items });
    const filter = within(pane.getByRole("group", { name: R.facetLabel }));
    await click(filter.getByRole("button", { name: "News" }));
    const list = pane.getByRole("list", { name: settings.rules });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    await click(pane.getByRole("button", { name: "Revoke all 2 matching" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke 2 rules" });
    expect(list.contains(dialog)).toBe(false);
    expect(within(dialog).getByText(/Mail it already filed stays where it is\./)).toBeTruthy();
    expect(mutations).toEqual([]);
    await click(within(dialog).getByRole("button", { name: "Revoke 2 rules" }));
    await tick(1500);
    expect(mutations.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { method: "DELETE", path: "/api/rules/r1" },
      { method: "DELETE", path: "/api/rules/r2" },
    ]);
    expect(reports()).toContain("2 rules revoked. Your mail hasn't moved.");
    expect(pane.getAllByRole("listitem")).toHaveLength(2);
    expect(pane.getAllByRole("listitem").map((row) => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("i1"), expect.stringContaining("i2"),
    ]));
  });

  it("leaves a refused rule in place and reports only the applied part", async () => {
    const { mutations, pane } = await mountedRules({ items, refusals: { r2: 403 } });
    await click(pane.getByRole("button", { name: "News" }));
    await click(pane.getByRole("button", { name: "Revoke all 2 matching" }));
    const dialog = within(screen.getByRole("dialog", { name: "Revoke 2 rules" }));
    await click(dialog.getByRole("button", { name: "Revoke 2 rules" }));
    await tick(1500);

    expect(mutations.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { method: "DELETE", path: "/api/rules/r1" },
      { method: "DELETE", path: "/api/rules/r2" },
    ]);
    expect(pane.getByText("Revoked 1 of 2. The rest are still in place.")).toBeTruthy();
    expect(reports()).not.toContain("2 rules revoked. Your mail hasn't moved.");
    const remaining = pane.getByRole("listitem");
    expect(remaining.textContent).toContain("r2");
    expect(within(remaining).getByRole<HTMLButtonElement>("button", { name: R.revoke }).disabled).toBe(false);
  });

  it("excludes a queued revoke from the count and does not send it again", async () => {
    const { mutations, pane } = await mountedRules({
      items: [rule("a"), rule("b"), rule("c")],
      refusals: { a: 500 },
    });
    const a = () => within(pane.getByRole("group", { name: /^Mail from a@/ }));
    await click(a().getByRole("button", { name: R.revoke }));
    const single = within(screen.getByRole("dialog", { name: R.revokeConfirm }));
    await click(single.getByRole("button", { name: R.revokeConfirm }));
    await tick(250);
    expect(a().getByText(R.queuedRevokeFailing)).toBeTruthy();
    expect(mutations).toEqual([{ method: "DELETE", path: "/api/rules/a" }]);

    await click(pane.getByRole("button", { name: "Revoke all 2 matching" }));
    const bulk = within(screen.getByRole("dialog", { name: "Revoke 2 rules" }));
    await click(bulk.getByRole("button", { name: "Revoke 2 rules" }));
    await tick(1500);
    expect(mutations.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
      "DELETE /api/rules/a", "DELETE /api/rules/b", "DELETE /api/rules/c",
    ]);
    expect(reports()).toContain("2 rules revoked. Your mail hasn't moved.");
    expect(pane.getByRole("listitem").textContent).toContain(R.queuedRevokeFailing);
  });

  it("does not dispatch a disclosed batch after another tab signs in to a different account", async () => {
    const { mutations, pane } = await mountedRules({ items });
    await click(pane.getByRole("button", { name: "News" }));
    await click(pane.getByRole("button", { name: "Revoke all 2 matching" }));
    const dialog = within(screen.getByRole("dialog", { name: "Revoke 2 rules" }));
    const confirm = dialog.getByRole("button", { name: "Revoke 2 rules" });

    rememberOwner("acct_other_rules");
    await click(confirm);
    await tick(1500);
    expect(mutations).toEqual([]);
    expect(reports()).toContain(R.bulkToastUnsent);
    expect(reports()).not.toContain("2 rules revoked. Your mail hasn't moved.");
    expect(pane.getAllByRole("listitem").map((row) => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("r1"), expect.stringContaining("r2"),
    ]));
  });
});

describe("both spellings of the News pile are ONE chip", () => {
  it("one News chip holds all ten, and Revoke all covers all ten", async () => {
    const legacyFolder = LEGACY_NEWS_FOLDER as RuleEntity["destination"];
    const legacy = Array.from({ length: 9 }, (_, i) => rule(`l${i}`, legacyFolder));
    const { mutations, pane } = await mountedRules({ items: [rule("n0", "ohmail/News"), ...legacy, rule("i0")] });
    const filter = within(pane.getByRole("group", { name: R.facetLabel }));
    expect(filter.getAllByRole("button").map((button) => button.textContent)).toEqual(["All", "Ohbox", "News"]);
    await click(filter.getByRole("button", { name: "News" }));
    await click(pane.getByRole("button", { name: "Revoke all 10 matching" }));
    const dialog = within(screen.getByRole("dialog", { name: "Revoke 10 rules" }));
    expect(mutations).toEqual([]);
    await click(dialog.getByRole("button", { name: "Revoke 10 rules" }));
    await tick(1500);

    expect(mutations).toHaveLength(10);
    expect(mutations.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(
      [...legacy.map((item) => `DELETE /api/rules/${item.id}`), "DELETE /api/rules/n0"],
    );
    expect(reports()).toContain("10 rules revoked. Your mail hasn't moved.");
  });
});
