import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxes } from "@trafficflow/db";
import type { ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type AdapterDialContext } from "../src/engine.js";

/**
 * THE LOCAL ENGINE'S DIAL CARRIES THE ROLES ITS LAST ATTACH RECORDED. `mailboxes.sent_folder`,
 * `junk_folder` and `trash_folder` are the second step of the role precedence; a launch that
 * dialled without them would let a name guess move Sent or Trash and then write the move down.
 * Mutation watched red (2026-10-02): dropping `storedFolders` from the engine's `imapConfig`.
 */
const HOUR = 60 * 60 * 1000;

describe("the local engine hands its dial the stored Sent, Junk and Trash", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function launch(dir: string): Promise<{ cfg: ImapConfig; sidecar: Awaited<ReturnType<typeof createSidecar>> }> {
    let captured: ImapConfig | null = null;
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      machineName: "the stored-folders machine",
      pollIntervalMs: 60 * HOUR,
      adapterFactory: (cfg: ImapConfig, _ctx: AdapterDialContext): MailboxAdapter => {
        captured ??= cfg;
        return new Proxy({} as MailboxAdapter, { get: () => (): never => { throw new Error("this test never dials"); } });
      },
      log: () => {},
    });
    expect(captured, "the engine built no dial at all").not.toBeNull();
    return { cfg: captured!, sidecar };
  }

  it("a first launch has nothing stored; the next launch dials with what the attach wrote", async () => {
    const dir = await freshDataDir("ohmail-dial-stored-folders-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const first = await launch(dir);
    expect(first.cfg.storedFolders).toEqual({ sent: null, junk: null, trash: null });
    const [mb] = await first.sidecar.db.select({ id: mailboxes.id }).from(mailboxes);
    await first.sidecar.repo.setMailboxSpecialFolders!(mb!.id, {
      sentFolder: "Gesendete Elemente", junkFolder: "Spam", trashFolder: "Papierkorb",
    });
    await first.sidecar.stop();

    const second = await launch(dir);
    cleanups.push(() => second.sidecar.stop().catch(() => undefined));
    expect(second.cfg.storedFolders).toEqual({ sent: "Gesendete Elemente", junk: "Spam", trash: "Papierkorb" });
  }, 60_000);
});
