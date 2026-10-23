import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_NEWS_FOLDER, NEWS_FOLDER } from "@trafficflow/core/folder-name";
import { greenmailEndpoint, readLaneGreenmail } from "../../../scripts/lib/lane-greenmail-env.mjs";
import { selfCheckMailbox } from "../src/mailbox-self-check.js";
import { listed, mirrorFolder, seedServer, serverState, storeCounts, world, type Shape } from "./_self-check-world.js";

/**
 * THE SELF-CHECK OVER THE NEWS RENAME (GreenMail, delimiter `.`). A pre-0.22 store keeps a row
 * labelled `ohmail/Reads`; asked through the pile resolver it read News' count against the old
 * rows, a gap no view could close. A physical `ohmail/Reads` beside News is asked by its own name
 * and said to be News' folder before the rename. The read changes nothing on either side.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const shape = (): Shape => {
  const gm = greenmailEndpoint(process.env, readLaneGreenmail(REPO_ROOT));
  return { name: "GreenMail", host: gm.imapHost, port: gm.imapPort, user: () => `rc-${randomUUID()}@trafficflow.test`, pass: "test" };
};

describe("the mailbox self-check over the News rename (GreenMail)", { timeout: 30_000 }, () => {
  const readOnly = async (s: Shape, user: string, folders: string[], w: Parameters<typeof storeCounts>[0]) => {
    const before = [await serverState(s, user, folders), await listed(s, user), await storeCounts(w)];
    const out = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId);
    expect([await serverState(s, user, folders), await listed(s, user), await storeCounts(w)]).toEqual(before);
    return out;
  };

  it("renamed: the stale old row beside a News row is not compared, News reads in step", async () => {
    const s = shape(); const user = s.user();
    await seedServer(s, user, { INBOX: 1, "ohmail.News": 5 });
    const st = await serverState(s, user, ["INBOX", "ohmail.News"]);
    const w = await world(s, user);
    await mirrorFolder(w, "INBOX", st.INBOX!.epoch, st.INBOX!.uids);
    await mirrorFolder(w, NEWS_FOLDER, st["ohmail.News"]!.epoch, st["ohmail.News"]!.uids);
    await mirrorFolder(w, LEGACY_NEWS_FOLDER, st["ohmail.News"]!.epoch, st["ohmail.News"]!.uids.slice(0, 3));
    const r = await readOnly(s, user, ["INBOX", "ohmail.News"], w);
    expect(r.verdict).toBe("in_step");
    expect(r.folders.map((f) => f.folder)).toEqual(["INBOX", NEWS_FOLDER]);
  });

  it("both on the server: the old folder is asked by its own name and named News' predecessor", async () => {
    const s = shape(); const user = s.user();
    await seedServer(s, user, { INBOX: 1, "ohmail.News": 5, "ohmail.Reads": 4 });
    const st = await serverState(s, user, ["INBOX", "ohmail.News", "ohmail.Reads"]);
    const w = await world(s, user);
    await mirrorFolder(w, "INBOX", st.INBOX!.epoch, st.INBOX!.uids);
    await mirrorFolder(w, NEWS_FOLDER, st["ohmail.News"]!.epoch, st["ohmail.News"]!.uids);
    const r = await readOnly(s, user, ["INBOX", "ohmail.News", "ohmail.Reads"], w);
    expect(r.verdict).toBe("server_more");
    expect(r.folders).toEqual([
      { folder: "INBOX", k: "in_step", server: 1, mirror: 1 },
      { folder: NEWS_FOLDER, k: "in_step", server: 5, mirror: 5 },
      { folder: LEGACY_NEWS_FOLDER, k: "server_more", server: 4, mirror: 0, predecessorOf: NEWS_FOLDER },
    ]);
  });

  it("not renamed yet (the old folder alone): its row reads in step, nothing is named a predecessor", async () => {
    const s = shape(); const user = s.user();
    await seedServer(s, user, { INBOX: 1, "ohmail.Reads": 3 });
    const st = await serverState(s, user, ["INBOX", "ohmail.Reads"]);
    const w = await world(s, user);
    await mirrorFolder(w, "INBOX", st.INBOX!.epoch, st.INBOX!.uids);
    await mirrorFolder(w, LEGACY_NEWS_FOLDER, st["ohmail.Reads"]!.epoch, st["ohmail.Reads"]!.uids);
    const r = await readOnly(s, user, ["INBOX", "ohmail.Reads"], w);
    expect(r.verdict).toBe("in_step");
    expect(r.folders).toEqual([
      { folder: "INBOX", k: "in_step", server: 1, mirror: 1 },
      { folder: LEGACY_NEWS_FOLDER, k: "in_step", server: 3, mirror: 3 },
    ]);
  });
});
