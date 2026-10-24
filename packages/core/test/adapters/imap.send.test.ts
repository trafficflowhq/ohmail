import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import { greenmailConfig, waitFor } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

describe("ImapAdapter.send (GreenMail SMTP + \\Sent append)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("sends over SMTP and appends the message to the Sent folder", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const res = await adapter.send({
      from: cfg.auth.user, to: cfg.auth.user, subject: "hello sent",
      text: "body", messageId: "<sent1@trafficflow.test>",
    });
    expect(res.providerMessageId).toBe("<sent1@trafficflow.test>");
    // GreenMail files no submission itself, so the send appended and names where.
    expect(res.sentLocator).not.toBeNull();
    const locator = res.sentLocator!;
    expect(parseRef(locator.ref)).toBeTruthy();

    // the appended copy is searchable in the resolved Sent folder
    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await c.connect();
    const sentPath = locator.folder === "INBOX" ? "INBOX" : locator.folder;
    let hits: number[] | boolean = [];
    await waitFor(async () => {
      const l = await c.getMailboxLock(sentPath.replace("/", "."));
      try { hits = await c.search({ header: { "message-id": "sent1@trafficflow.test" } }, { uid: true }); }
      finally { l.release(); }
      return Array.isArray(hits) && hits.length > 0;
    }, 8000);
    await c.logout();
    expect(Array.isArray(hits) && hits.length).toBeTruthy();
  });

  /** Every Sent copy carrying this Message-ID, counted by a second, independent client. */
  async function copiesInSent(cfg: ReturnType<typeof greenmailConfig>, id: string, folder: string): Promise<number> {
    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await c.connect();
    try {
      const l = await c.getMailboxLock(folder.replace("/", ".")).catch(() => null);
      if (l === null) return 0;   // no Sent folder yet: nothing was filed
      try {
        const hits = await c.search({ header: { "message-id": id.replace(/[<>]/g, "") } }, { uid: true });
        return Array.isArray(hits) ? hits.length : 0;
      } finally { l.release(); }
    } finally { await c.logout(); }
  }

  it("`copy: \"caller\"` appends nothing; fileSentCopy files one copy; a second look adds none", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const id = "<caller-copy@trafficflow.test>";
    let released = 0;
    const res = await adapter.send(
      { from: cfg.auth.user, to: cfg.auth.user, subject: "the copy is ours", text: "body", messageId: id },
      { copy: "caller", beforeRelease: async () => { released += 1; } },
    );
    expect({ released, locator: res.sentLocator }).toEqual({ released: 1, locator: null });
    const raw = (res as { unfiledCopy?: Buffer }).unfiledCopy!;
    expect(raw.toString()).toContain("the copy is ours");
    expect(await copiesInSent(cfg, id, "Sent"), "the send itself filed nothing").toBe(0);

    const first = await adapter.fileSentCopy(raw, id);
    const sent = first!.locator.folder;
    expect(parseRef(first!.locator.ref)).toBeTruthy();
    expect(await copiesInSent(cfg, id, sent)).toBe(1);

    const again = await adapter.fileSentCopy(raw, id, { look: true });
    expect(again?.locator.ref, "the retry found the copy that is there").toBe(first!.locator.ref);
    expect(await copiesInSent(cfg, id, sent), "a retry never adds a second copy").toBe(1);
  });
});
