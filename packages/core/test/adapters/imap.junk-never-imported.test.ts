import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";

/**
 * JUNK IS NEVER IMPORTED. A mailbox's own folders are read as passive presence, and the spam
 * folder is not one of them: whether the server flags it `\Junk` (SPECIAL-USE) or names it only
 * (`Spam`, no SPECIAL-USE), a first scan reads the person's own folder and nothing from the spam
 * folder, and the folder report says why it was left out.
 */

interface FakeFolder { uidValidity: bigint; uids: number[]; flags?: string[] }

/** A CONDSTORE server holding `folders`; `specialUse` is whether it advertises SPECIAL-USE. */
function fakeServer(folders: Record<string, FakeFolder>, specialUse: boolean) {
  const caps = new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]);
  if (specialUse) caps.set("SPECIAL-USE", true);
  const uidNext = (f: FakeFolder) => Math.max(0, ...f.uids) + 1;
  const client = {
    capabilities: caps,
    mailbox: {} as Record<string, unknown>,
    _path: "INBOX",
    async list() {
      return Object.entries(folders).map(([path, f]) => ({
        path, name: path.split("/").pop()!, delimiter: "/", flags: new Set(f.flags ?? []),
      }));
    },
    async getMailboxLock(path: string) {
      const f = folders[path];
      if (!f) throw new Error(`no such mailbox ${path}`);
      this._path = path;
      this.mailbox = { path, uidValidity: f.uidValidity, uidNext: uidNext(f), highestModseq: 60n, exists: f.uids.length };
      return { path, release() { /* no lock in the fake */ } };
    },
    async *fetch(range: any, query: any, options: any) {
      const f = folders[this._path]!;
      const asked: number[] = Array.isArray(range) ? range : f.uids;
      if (options?.changedSince !== undefined) return;
      if (query?.source) {
        for (const uid of asked) {
          yield {
            uid, flags: new Set<string>(), envelope: { messageId: `<${this._path}-${uid}@x>` },
            source: Buffer.from([
              `Message-ID: <${this._path}-${uid}@x>`, "From: sender@example.com", "To: owner@example.com",
              `Subject: in ${this._path}`, "", "body",
            ].join("\r\n")),
            internalDate: new Date("2019-04-01T10:00:00Z"), size: 200,
          };
        }
        return;
      }
      if (query?.size) { for (const uid of asked) yield { uid, size: 200 }; return; }
      if (query?.internalDate || query?.envelope) {
        for (const uid of asked) {
          yield { uid, internalDate: new Date("2019-04-01T10:00:00Z"), envelope: { date: new Date("2019-04-01T10:00:00Z") } };
        }
        return;
      }
      for (const uid of f.uids) yield { uid };
    },
  };
  return client;
}

async function firstScan(folders: Record<string, FakeFolder>, specialUse: boolean) {
  const adapter = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client: fakeServer(folders, specialUse) });
  await adapter.connect();
  const batch = await adapter.changesSince({ folders: {} });
  return { batch, report: adapter.passiveFolderReport() };
}

describe("a mailbox's spam folder is never imported", () => {
  it("a folder the server flags \\Junk is left out; the person's own folder is read", async () => {
    const { batch, report } = await firstScan({
      INBOX: { uidValidity: 1n, uids: [] },
      Junk: { uidValidity: 2n, uids: [1], flags: ["\\Junk"] },
      Projects: { uidValidity: 3n, uids: [1] },
    }, true);
    const fromProjects = batch.creates.filter((c) => c.locator.folder === "Projects");
    expect(fromProjects).toHaveLength(1);
    expect(fromProjects[0]!.passive).toBe(true);
    expect(batch.creates.filter((c) => c.locator.folder === "Junk")).toEqual([]);
    expect(report.excluded.has("Junk")).toBe(true);
  });

  it("a flagged spam folder under a name that says nothing is left out by its flag", async () => {
    const { batch, report } = await firstScan({
      INBOX: { uidValidity: 1n, uids: [] },
      Filtered: { uidValidity: 2n, uids: [1], flags: ["\\Junk"] },
      Projects: { uidValidity: 3n, uids: [1] },
    }, true);
    const fromProjects = batch.creates.filter((c) => c.locator.folder === "Projects");
    expect(fromProjects).toHaveLength(1);
    expect(fromProjects[0]!.passive).toBe(true);
    expect(batch.creates.filter((c) => c.locator.folder === "Filtered")).toEqual([]);
    expect(report.excluded.has("Filtered")).toBe(true);
  });

  it("on a server with no SPECIAL-USE, a folder named Spam is left out by its name", async () => {
    const { batch, report } = await firstScan({
      INBOX: { uidValidity: 1n, uids: [] },
      Spam: { uidValidity: 2n, uids: [1] },
      Projects: { uidValidity: 3n, uids: [1] },
    }, false);
    const fromProjects = batch.creates.filter((c) => c.locator.folder === "Projects");
    expect(fromProjects).toHaveLength(1);
    expect(fromProjects[0]!.passive).toBe(true);
    expect(batch.creates.filter((c) => c.locator.folder === "Spam")).toEqual([]);
    expect(report.excluded.has("Spam")).toBe(true);
  });
});
