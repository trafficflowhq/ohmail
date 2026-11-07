import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 3 });

/**
 * A PAIRED LAUNCH NAMES THE MAILBOX IT SERVES BEFORE THE PAIRING ANSWERS.
 *
 * A paired install has no address, so its world has no row and its `ready` frame names no mailbox;
 * the window mounts mail only under a named one and sat on "Opening your mailbox…" until a
 * relaunch. The first mailbox list names it, by the rule a relaunch applies, and the shell hears
 * the name before the pairing's answer, so the window's next status read carries it.
 */

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEWER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

/** The other computer: the redeem, its mailbox list (two rows, the older one first by creation), a quiet feed. */
function pairingHost(boxes: "two" | "none" = "two"): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/pair/redeem") {
      return json({ grant: "device-pair", tokens: { accessToken: "access-1", refreshToken: "refresh-1" } }, 200,
        { "x-ohmail-account": ACCOUNT });
    }
    if (url.pathname === "/mailboxes") {
      return json(mailboxList(boxes === "none" ? [] : [
        hostedMailbox(NEWER, "second@ohmail.test", { createdAt: "2026-01-02T00:00:00.000Z" }),
        hostedMailbox(OLDER, "first@ohmail.test", { createdAt: "2026-01-01T00:00:00.000Z" }),
      ]));
    }
    if (url.pathname === "/sync") {
      return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c1", hasMore: false, serverTime: new Date().toISOString() });
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as unknown as typeof fetch;
}

const keks = { 1: Buffer.alloc(32, 9) };

async function boot(dataDir: string, told: string[], over: { boxes?: "two" | "none"; waitMs?: number; address?: string; events?: string[] } = {}): Promise<CloudSidecar> {
  const s = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://desk.test",
    address: over.address ?? null,
    keks,
    fetchImpl: pairingHost(over.boxes),
    pollIntervalMs: 3_600_000,
    ...(over.waitMs !== undefined ? { pairServedWaitMs: over.waitMs } : {}),
    onServedMailbox: async (id) => { told.push(`named ${id}`); },
    ...(over.events ? { log: (event: string) => { over.events!.push(event); } } : {}),
  });
  sidecars.push(s);
  return s;
}

const pair = (s: CloudSidecar): Promise<Response> =>
  s.handle(new Request("http://sidecar/cloud/pair-redeem", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.sessionToken}` },
    body: JSON.stringify({ token: "tok-abc" }),
  }));

describe("the mailbox a paired launch serves", () => {
  it("is named from the first mailbox list, and the shell hears it BEFORE the pairing answers", async () => {
    const dir = await freshDataDir("ohmail-pair-served-");
    dirs.push(dir);
    const told: string[] = [];
    const s = await boot(dir, told);
    expect(s.servedMailboxId(), "a paired launch's ready names a mailbox it has no row for").toBe("");

    const res = await pair(s);
    told.push("answered");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(told).toEqual([`named ${OLDER}`, "answered"]);
    expect((await res.json()).mailboxId).toBe(OLDER);
    expect(s.servedMailboxId()).toBe(OLDER);
  });

  it("is the mailbox a relaunch over the same directory names at ready", async () => {
    const dir = await freshDataDir("ohmail-pair-served-relaunch-");
    dirs.push(dir);
    const first = await boot(dir, []);
    expect((await pair(first)).status).toBe(200);
    const named = first.servedMailboxId();
    await first.stop();
    sidecars.splice(sidecars.indexOf(first), 1);

    const told: string[] = [];
    const again = await boot(dir, told);
    expect(again.signedIn(), "the relaunch did not resume from the seal").toBe(true);
    expect(again.world.mailboxId).toBe(named);
    expect(again.servedMailboxId()).toBe(named);
    await again.start();
    expect(told, "a launch whose ready named its mailbox named another").toEqual([]);
  });

  it("a launch whose ready named its mailbox is never told another", async () => {
    const dir = await freshDataDir("ohmail-pair-served-addressed-");
    dirs.push(dir);
    const told: string[] = [];
    const s = await boot(dir, told, { address: "first@ohmail.test" });
    const seeded = s.servedMailboxId();
    expect(seeded).not.toBe("");
    expect((await pair(s)).status).toBe(200);
    expect(told).toEqual([]);
    expect(s.servedMailboxId()).toBe(seeded);
  });

  it("a door whose address is none of the account's mailboxes serves one mailbox across relaunches", async () => {
    // A self-host operator login: the window's journal is keyed by this id, so a fresh one per
    // launch lost a Screener decision pressed just before a quit.
    const dir = await freshDataDir("ohmail-pair-served-operator-");
    dirs.push(dir);
    const first = await boot(dir, [], { address: "operator@ohmail.test" });
    expect((await pair(first)).status).toBe(200);
    await first.start();
    await first.stop();
    sidecars.splice(sidecars.indexOf(first), 1);

    const served: string[] = [];
    for (let i = 0; i < 2; i++) {
      const events: string[] = [];
      const s = await boot(dir, [], { address: "operator@ohmail.test", events });
      expect(s.signedIn(), "the relaunch did not resume from the seal").toBe(true);
      served.push(s.servedMailboxId());
      await s.start();
      expect(events, "a relaunch minted a mailbox the refresh then retired").not.toContain("cloud_mailboxes_refreshed");
      await s.stop();
      sidecars.splice(sidecars.indexOf(s), 1);
    }
    expect(served).toEqual([OLDER, OLDER]);
  });

  it("a list with no mailbox leaves it unnamed, and the answer still goes at the bound", async () => {
    const dir = await freshDataDir("ohmail-pair-served-none-");
    dirs.push(dir);
    const told: string[] = [];
    const events: string[] = [];
    const s = await boot(dir, told, { boxes: "none", waitMs: 300, events });
    // The bound on a FAKE clock, the pairing on real turns: `cloud_paired` is logged in the same
    // run that arms the bound, so from there only the clock moves the answer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const asked = Date.now();
      let answered = false;
      const pending = pair(s).finally(() => { answered = true; });
      while (!events.includes("cloud_paired")) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(299);
      expect(answered, "the answer went before its bound").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;
      const took = Date.now() - asked;
      expect(res.status).toBe(200);
      expect((await res.json()).mailboxId).toBe("");
      expect(told).toEqual([]);
      expect(took, "the answer waited past its bound").toBeLessThan(5_000);
      expect(took, "the answer did not wait for the list at all").toBeGreaterThanOrEqual(250);
    } finally {
      vi.useRealTimers();
    }
  });
});
