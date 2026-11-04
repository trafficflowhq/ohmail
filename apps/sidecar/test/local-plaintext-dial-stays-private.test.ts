import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";
import {
  HOME_NAME, osAnswers, plainImap, type PlainServer,
} from "../../../test/support/plaintext-wire.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * THE LOCAL DOOR'S PLAINTEXT DIAL, through the real adapter. The seed mailbox was consented for a
 * server on the person's own network; the engine used to dial the name on every launch and
 * re-dial, so a name that now answers a public address got the LOGIN in clear. The engine's own
 * resolver is asked here (`dns.promises.lookup`), apart from the socket's lookup.
 */

const USER = "home@home.example";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function launch(imap: PlainServer): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-plaintext-");
  const s = await createSidecar({
    dataDir,
    imap: { host: HOME_NAME, port: imap.port, secure: false, allowInsecure: true, auth: { user: USER, pass: "incoming-rig-password" } },
    address: USER,
    machineName: "this machine",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: { 1: Buffer.alloc(32, 9) },
    log: () => {},
  });
  cleanups.push(async () => {
    await s.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });
  await s.start().catch(() => undefined);
  return s;
}

async function row(s: Sidecar): Promise<{ status?: string; errorCode?: string | null; errorDetail?: string | null }> {
  const res = await s.handle(new Request("http://local/mailboxes", {
    method: "GET", headers: { authorization: `Bearer ${s.sessionToken}` },
  }));
  const { items } = (await res.json()) as { items: Array<{ address: string; status?: string; errorCode?: string | null; errorDetail?: string | null }> };
  return items.find((m) => m.address === USER) ?? {};
}

describe("the local door's plaintext dial", () => {
  it("a consented name that now answers a public address is refused, with its sentence, and no LOGIN is sent", async () => {
    const imap = await plainImap();
    cleanups.push(() => imap.close());
    const restore = osAnswers("0.0.0.0");
    cleanups.push(async () => restore());

    const s = await launch(imap);
    expect(imap.saw("LOGIN"), "the password went out in clear to a server off the person's network").toBe(false);
    expect(imap.connections()).toBe(0);
    expect(await row(s)).toMatchObject({ status: "error", errorCode: "connect", errorDetail: "MAILBOX_PLAINTEXT_REFUSED" });
    // …and the desktop's own pane reads it off the connections route, not as an outage.
    const res = await s.handle(new Request("http://local/local/mailboxes/connections", {
      method: "GET", headers: { authorization: `Bearer ${s.sessionToken}` },
    }));
    const { items } = (await res.json()) as { items: Array<{ plaintextRefused?: boolean }> };
    expect(items.map((i) => i.plaintextRefused)).toEqual([true]);
  });

  it("a name still on the person's network keeps dialling, pinned to the address that was checked", async () => {
    // The socket's own lookup is dead: only a dial carried to the resolved address arrives.
    const imap = await plainImap();
    cleanups.push(() => imap.close());
    const restore = osAnswers(null, "127.0.0.1");
    cleanups.push(async () => restore());

    await launch(imap);
    expect(imap.saw("LOGIN"), "the consented dial did not reach its server").toBe(true);
  });
});
