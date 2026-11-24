import { beforeEach, describe, expect, it } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  LeaseUnavailableError, makeLeaseIo, makeRequestOrganizerIo, type MetaIdentity,
} from "@trafficflow/core/adapters/organizer-lease";
import { memoryImapServer, type MemoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { claimRaw } from "../../../packages/core/test/adapters/_lease-fixtures.js";
import { applyMetaRequests, shrinkMetaOnRefusal } from "@ohmail/organizer/request-drain";

/**
 * WHAT AN IDLE KEYLESS PASS COSTS (REVIEW-02514 LOW 1): the reviewer's probe — the real
 * `makeRequestOrganizerIo` over the in-memory server, which logs every command — driven through
 * `applyMetaRequests` with no request key, a fresh io per pass as the hosts build it. 0.25.13 sent
 * nothing here. A keyless pass shrinks when the gate's read saw the folder near its ceiling, or once
 * a day; a full folder still shrinks on the refused arm.
 */
const META = "INBOX.ohmail._meta";
const NOW = new Date("2026-10-04T10:00:00.000Z");
const DAY = 24 * 3_600_000;
let ID: MetaIdentity = { installId: "us", mailboxId: "mb" };
const toServerPath = (c: string): string => c.replace(/\//g, ".");
const NO_DB = {} as never;
/* A fresh mailbox id per case: the meta memory is in-process and keyed by (install, mailbox). */
let cases = 0;
beforeEach(() => { ID = { installId: "us", mailboxId: `mb-idle-${++cases}` }; });

/** An idle folder: our live claim and another install's, at the top of a spent uid space. */
function idleServer(top: number): MemoryImapServer {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  server.tree.get(META)!.nextUid = Math.max(1, top - 1);
  server.seed(META, claimRaw({ installId: "us", heartbeat: new Date(NOW.getTime() - 30_000), nonce: "us-live" }),
    new Date(NOW.getTime() - 30_000));
  server.seed(META, claimRaw({ installId: "them", heartbeat: new Date(NOW.getTime() - 9_000), nonce: "t" }),
    new Date(NOW.getTime() - 9_000));
  return server;
}

/** The adapter's half: a fresh io per pass, the path kept across passes on one login. */
function adapterOver(server: MemoryImapServer): MailboxAdapter {
  let path: string | null = null;
  return {
    requestOrganizerIo: (id: MetaIdentity) => makeRequestOrganizerIo(server, toServerPath, id, {
      known: path, learned: (p: string) => { path = p; },
    }),
  } as unknown as MailboxAdapter;
}

const rt = (adapter: MailboxAdapter) => ({
  mailboxId: ID.mailboxId, accountId: "acct", installId: ID.installId, adapter, requestKey: null,
});

async function pass(server: MemoryImapServer, adapter: MailboxAdapter, at: Date): Promise<string[]> {
  const before = server.log.length;
  await applyMetaRequests(NO_DB, rt(adapter), at, () => {});
  return server.log.slice(before);
}

describe("an idle keyless organizer sends nothing to ohmail/_meta", () => {
  for (const top of [50, 3_000, 20_000]) {
    it(`top uid ${top}: once on the first pass, then 0 commands per pass inside the day`, async () => {
      const server = idleServer(top);
      const adapter = adapterOver(server);
      const first = await pass(server, adapter, NOW);
      expect(first.length, "the first pass in a process owes its daily shrink").toBeGreaterThan(0);
      const counts: number[] = [];
      for (let p = 1; p <= 3; p++) counts.push((await pass(server, adapter, new Date(NOW.getTime() + p * 60_000))).length);
      expect(counts, `0.25.13 sent nothing on an idle keyless pass; this sent ${counts.join(", ")}`).toEqual([0, 0, 0]);
    });
  }

  it("shrinks again a day later, and the kept path costs that pass no LIST", async () => {
    const server = idleServer(50);
    const adapter = adapterOver(server);
    expect(await pass(server, adapter, NOW)).toContain("list");
    const later = await pass(server, adapter, new Date(NOW.getTime() + DAY));
    expect(later.length, "the daily shrink did not run").toBeGreaterThan(0);
    expect(later, "a resolved path was resolved again").not.toContain("list");
  });
});

describe("a folder near its ceiling still shrinks", () => {
  it("the gate's read past the window makes the next keyless pass sweep our day-old claims", async () => {
    const server = idleServer(50);
    const adapter = adapterOver(server);
    await pass(server, adapter, NOW); // the day's shrink, on an idle folder
    for (let i = 0; i < 600; i++) {
      server.seed(META, claimRaw({ installId: "us", heartbeat: new Date(NOW.getTime() - 2 * DAY), nonce: `old-${i}` }),
        new Date(NOW.getTime() - 2 * DAY));
    }
    // The newest record dates the server's clock: our renewal from this cycle.
    server.seed(META, claimRaw({ installId: "us", heartbeat: NOW, nonce: "us-now" }), NOW);
    await makeLeaseIo(server, toServerPath, ID).listClaims();
    const shrank = await pass(server, adapter, new Date(NOW.getTime() + 60_000));
    expect(shrank.some((l) => l.startsWith("delete")), "a folder past the window was not swept").toBe(true);
    expect(server.tree.get(META)!.messages.length).toBeLessThan(600);
  });

  it("CONTROL: a gate read well inside the window leaves the next pass idle", async () => {
    const server = idleServer(50);
    const adapter = adapterOver(server);
    await pass(server, adapter, NOW);
    await makeLeaseIo(server, toServerPath, ID).listClaims();
    expect(await pass(server, adapter, new Date(NOW.getTime() + 60_000))).toEqual([]);
  });

  it("the refused arm shrinks a full folder whatever the clock says", async () => {
    const server = idleServer(50);
    const adapter = adapterOver(server);
    await pass(server, adapter, NOW);
    for (let i = 0; i < 300; i++) {
      server.seed(META, claimRaw({ installId: "us", heartbeat: new Date(NOW.getTime() - 3 * DAY), nonce: `old-${i}` }),
        new Date(NOW.getTime() - 3 * DAY));
    }
    server.seed(META, claimRaw({ installId: "us", heartbeat: NOW, nonce: "us-now" }), NOW);
    const ran = await shrinkMetaOnRefusal(
      new LeaseUnavailableError("full", { op: "meta_folder_full" }),
      { ...rt(adapter) }, new Date(NOW.getTime() + 60_000), () => {},
    );
    expect(ran).toBe(true);
    expect(server.tree.get(META)!.messages.length).toBeLessThan(300);
  });
});
