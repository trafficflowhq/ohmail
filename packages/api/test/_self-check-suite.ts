import { describe, expect, it } from "vitest";
import { selfCheckMailbox } from "../src/mailbox-self-check.js";
import {
  expungeOne, listed, mirrorFolder, recreateFolder, seedServer, serverState, storeCounts,
  swallowStatusOf, world, type Shape,
} from "./_self-check-world.js";

/**
 * The self-check's acceptance on one real server shape, shared by the GreenMail and Dovecot twins:
 * a clean mirror reads in step, a planted missing letter and a letter the server lost read their
 * direction, a folder the server no longer has reads the mirror's copy, a recreated folder reads
 * `uidvalidity_changed`, and a STATUS the server never answers reads `timeout` inside the budget
 * with the folders after it `dropped`. Every case asserts the server and the store are unchanged.
 */
export function serverShapeSuite(shape: () => Shape): void {
  const readOnly = async (s: Shape, user: string, folders: string[], w: Parameters<typeof storeCounts>[0], run: () => Promise<unknown>) => {
    const before = [await serverState(s, user, folders), await listed(s, user), await storeCounts(w)];
    const out = await run();
    expect([await serverState(s, user, folders), await listed(s, user), await storeCounts(w)]).toEqual(before);
    return out;
  };

  /* 30 s per case: each is real work (about nine logins, a PGlite store, the self-check with its
     default 5 s folder deadline, and a 1.1 s sleep for a new UIDVALIDITY), 2-4.2 s on an idle
     runner. About 7x the slowest; covers one folder deadline plus setup on a loaded host. */
  describe(`the mailbox self-check against ${shape().name}`, { timeout: 30_000 }, () => {
    it("a clean mirror reads in step, and the read changes nothing on either side", async () => {
      const s = shape(); const user = s.user();
      await seedServer(s, user, { INBOX: 3, Archive: 2 });
      const st = await serverState(s, user, ["INBOX", "Archive"]);
      const w = await world(s, user);
      await mirrorFolder(w, "INBOX", st.INBOX!.epoch, st.INBOX!.uids);
      await mirrorFolder(w, "Archive", st.Archive!.epoch, st.Archive!.uids);
      const r = await readOnly(s, user, ["INBOX", "Archive"], w, () => selfCheckMailbox(w.deps, w.accountId, w.mailboxId));
      expect(r).toMatchObject({
        verdict: "in_step",
        folders: [
          { folder: "INBOX", k: "in_step", server: 3, mirror: 3 },
          { folder: "Archive", k: "in_step", server: 2, mirror: 2 },
        ],
      });
      expect((await listed(s, user)).some((p) => /ohmail/i.test(p))).toBe(false);
    });

    it("a planted missing letter reads `server_more` for that folder and nowhere else", async () => {
      const s = shape(); const user = s.user();
      await seedServer(s, user, { INBOX: 2, Archive: 3 });
      const st = await serverState(s, user, ["INBOX", "Archive"]);
      const w = await world(s, user);
      await mirrorFolder(w, "INBOX", st.INBOX!.epoch, st.INBOX!.uids);
      await mirrorFolder(w, "Archive", st.Archive!.epoch, st.Archive!.uids.slice(1));
      const r = await readOnly(s, user, ["INBOX", "Archive"], w, () => selfCheckMailbox(w.deps, w.accountId, w.mailboxId));
      expect(r).toMatchObject({
        verdict: "server_more",
        folders: [
          { folder: "INBOX", k: "in_step", server: 2, mirror: 2 },
          { folder: "Archive", k: "server_more", server: 3, mirror: 2 },
        ],
      });
    });

    it("a letter the server lost reads `mirror_more`, and a folder it no longer has reads the mirror's copy", async () => {
      const s = shape(); const user = s.user();
      await seedServer(s, user, { INBOX: 1, Archive: 2 });
      const st = await serverState(s, user, ["INBOX", "Archive"]);
      const w = await world(s, user);
      await mirrorFolder(w, "INBOX", st.INBOX!.epoch, st.INBOX!.uids);
      await mirrorFolder(w, "Archive", st.Archive!.epoch, st.Archive!.uids);
      await mirrorFolder(w, "Gone", st.INBOX!.epoch, [1]);
      await expungeOne(s, user, "Archive", st.Archive!.uids[0]!);
      const r = await readOnly(s, user, ["INBOX", "Archive"], w, () => selfCheckMailbox(w.deps, w.accountId, w.mailboxId));
      expect(r).toMatchObject({
        verdict: "mirror_more",
        folders: [
          { folder: "INBOX", k: "in_step" },
          { folder: "Archive", k: "mirror_more", server: 1, mirror: 2 },
          { folder: "Gone", k: "mirror_more", server: 0, mirror: 1 },
        ],
      });
    });

    it("a folder recreated on the server reads `uidvalidity_changed`, its own class", async () => {
      const s = shape(); const user = s.user();
      await seedServer(s, user, { INBOX: 1, Archive: 2 });
      const st = await serverState(s, user, ["INBOX", "Archive"]);
      const w = await world(s, user);
      await mirrorFolder(w, "INBOX", st.INBOX!.epoch, st.INBOX!.uids);
      await mirrorFolder(w, "Archive", st.Archive!.epoch, st.Archive!.uids);
      await recreateFolder(s, user, "Archive", 2);
      const now = await serverState(s, user, ["Archive"]);
      // The precondition, measured rather than assumed: the server really stated a new epoch.
      expect(now.Archive!.epoch).not.toBe(st.Archive!.epoch);
      const r = await readOnly(s, user, ["INBOX", "Archive"], w, () => selfCheckMailbox(w.deps, w.accountId, w.mailboxId));
      expect(r).toMatchObject({
        verdict: "uidvalidity_changed",
        folders: [{ folder: "INBOX", k: "in_step" }, { folder: "Archive", k: "uidvalidity_changed", server: 2, mirror: 2 }],
      });
    });

    it("a STATUS the server never answers reads `timeout` inside the budget; the folders after it `dropped`", async () => {
      const s = shape(); const user = s.user();
      await seedServer(s, user, { INBOX: 1, Hang: 1, Zed: 1 });
      const st = await serverState(s, user, ["INBOX", "Hang", "Zed"]);
      const proxy = await swallowStatusOf(s, "Hang");
      try {
        const w = await world(s, user, { host: "127.0.0.1", port: proxy.port });
        for (const f of ["INBOX", "Hang", "Zed"]) await mirrorFolder(w, f, st[f]!.epoch, st[f]!.uids);
        const started = Date.now();
        const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId, { budgetMs: 4_000, folderMs: 700 });
        const elapsed = Date.now() - started;
        expect(proxy.swallowed()).toBe(1);
        expect(r).toMatchObject({
          verdict: "unreadable",
          folders: [
            { folder: "INBOX", k: "in_step" },
            { folder: "Hang", k: "unreadable", error: "timeout" },
            { folder: "Zed", k: "unreadable", error: "dropped" },
          ],
        });
        expect(elapsed).toBeLessThan(4_000);
      } finally {
        await proxy.close();
      }
    });
  });
}
