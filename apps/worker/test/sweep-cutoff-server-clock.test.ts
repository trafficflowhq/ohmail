import { beforeEach, describe, expect, it } from "vitest";
import {
  formatClaim, makeLeaseIo, makeRequestOrganizerIo, META_ENUM_RECORDS_MAX, peekMemo, writeMemo,
} from "@trafficflow/core/adapters/organizer-lease";
import { memoryImapServer, type MemoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { shrinkMeta } from "@ohmail/organizer/request-drain";

/**
 * THE SWEEP'S CUTOFF IS THE SERVER'S CLOCK (SWEEP-CUTOFF-READS-THE-HOST-CLOCK): the folder's newest
 * INTERNALDATE less the stale window, never this host's. A host a day or more ahead of its server
 * used to take its own claims whatever their age; here it takes only what the server dates past it.
 */
const META = "INBOX.ohmail._meta";
let ID = { installId: "us", mailboxId: "mb-clock" };
const SERVER_NOW = new Date("2026-10-04T10:00:00.000Z");
const DAY = 86_400_000;
const toServerPath = (c: string): string => c.replace(/\//g, ".");
/* A fresh mailbox id per case: the meta memory is in-process and keyed by (install, mailbox). */
let cases = 0;
beforeEach(() => { ID = { installId: "us", mailboxId: `mb-clock-${++cases}` }; });

function claim(nonce: string, at: Date, installId = ID.installId): string {
  return formatClaim({ installId, kind: "cloud", displayName: "Cloud", heartbeat: at, claimedAt: at, nonce,
    authorizedAt: null, capabilities: [] });
}

/** Our claims three days and six hours old by the server, and the server's newest record now. */
function world(): { server: MemoryImapServer; threeDays: number; sixHours: number } {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  const old = new Date(SERVER_NOW.getTime() - 3 * DAY);
  const recent = new Date(SERVER_NOW.getTime() - 6 * 3_600_000);
  const threeDays = server.seed(META, claim("three-days", old), old);
  const sixHours = server.seed(META, claim("six-hours", recent), recent);
  server.seed(META, claim("now", SERVER_NOW, "them"), SERVER_NOW);
  return { server, threeDays, sixHours };
}

const uids = (s: MemoryImapServer): number[] => s.tree.get(META)!.messages.map((m) => m.uid);

describe("the sweep dates by the server's clock", () => {
  it("a host two days ahead keeps a claim the server dates six hours old", async () => {
    const { server, threeDays, sixHours } = world();
    const hostNow = new Date(SERVER_NOW.getTime() + 2 * DAY);
    const done = await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), hostNow, () => {});
    expect(done.swept, "the sweep took more than the server dates stale").toBe(1);
    expect(uids(server), "a six-hour-old claim was swept on the host's clock").toContain(sixHours);
    expect(uids(server)).not.toContain(threeDays);
  });

  it("CONTROL: a host on time takes the same one claim", async () => {
    const { server, threeDays, sixHours } = world();
    const done = await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), SERVER_NOW, () => {});
    expect(done.swept).toBe(1);
    expect(uids(server)).toContain(sixHours);
    expect(uids(server)).not.toContain(threeDays);
  });

  it("an empty folder sweeps nothing and asks for no date", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const done = await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), SERVER_NOW, () => {});
    expect(done.swept).toBe(0);
  });
});

/* LOW-1/2, one seam, two invariants. SAFETY: a claim of ours younger than
   the stale window is never swept, whatever a record's date says. PROGRESS: a folder refused as full
   still sheds our own claims older than the window in one pass, with its newest date frozen. */
describe("the cutoff's two invariants", () => {
  it("SAFETY: a 2037-dated record appended last sweeps nothing live", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const ours = server.seed(META, claim("us-live", new Date(SERVER_NOW.getTime() - 20_000)), new Date(SERVER_NOW.getTime() - 20_000));
    const theirs = server.seed(META, claim("them-live", new Date(SERVER_NOW.getTime() - 10_000), "them"),
      new Date(SERVER_NOW.getTime() - 10_000));
    server.seed(META, "Subject: imported\r\n\r\nb", new Date("2037-01-01T00:00:00Z"));
    for (const refused of [false, true]) {
      await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), SERVER_NOW, () => {}, { refused });
      expect(uids(server), `our live claim was swept (refused=${refused})`).toContain(ours);
      expect(uids(server)).toContain(theirs);
    }
  });

  it("SAFETY: with our newest claim out of reach, the ordinary arm takes no claim of ours", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const ours = server.seed(META, claim("us-live", new Date(SERVER_NOW.getTime() - 20_000)), new Date(SERVER_NOW.getTime() - 20_000));
    for (let i = 0; i < 600; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`, SERVER_NOW);
    server.seed(META, "Subject: imported\r\n\r\nb", new Date("2037-01-01T00:00:00Z"));
    await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), SERVER_NOW, () => {});
    expect(uids(server), "a claim of ours below the top window was swept on a future-dated cutoff").toContain(ours);
  });

  it("PROGRESS: a full folder whose newest record is 30 days old still sheds our two-day-old claims", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const t0 = Date.now() - 2 * DAY;
    for (let i = 0; i < META_ENUM_RECORDS_MAX - 1_200; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`, new Date(t0 - 5 * DAY));
    for (let i = 0; i < 1_200; i++) server.seed(META, claim(`o-${i}`, new Date(t0 - i * 1_000)), new Date(t0 - i * 1_000));
    server.seed(META, "Subject: moved in by the person\r\n\r\nb", new Date(t0 - 30 * DAY));
    const before = server.tree.get(META)!.messages.length;
    const done = await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), new Date(), () => {}, { refused: true });
    expect(done.swept, "a frozen full folder made no progress").toBe(1_000);
    expect(server.tree.get(META)!.messages.length).toBe(before - 1_000);
  });

  it("CONTROL: the ordinary arm over the same frozen folder takes nothing of ours", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const t0 = Date.now() - 2 * DAY;
    for (let i = 0; i < 50; i++) server.seed(META, claim(`o-${i}`, new Date(t0 - i * 1_000)), new Date(t0 - i * 1_000));
    server.seed(META, "Subject: moved in\r\n\r\nb", new Date(t0 - 30 * DAY));
    expect((await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), new Date(), () => {})).swept).toBe(0);
  });

  it("BOUND: on the refused arm a host clock a day ahead takes no claim younger than the window", async () => {
    for (const written of ["by-that-clock", "before-the-jump"] as const) {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
      const real = Date.now();
      const hostNow = new Date(real + DAY);
      const skew = written === "by-that-clock" ? DAY : 0;
      const at = (ageMs: number): { hb: Date; server: Date } => ({ hb: new Date(real - ageMs + skew), server: new Date(real - ageMs) });
      const old = at(3 * DAY);
      const young = at(3_600_000);
      const oldUid = server.seed(META, claim("old", old.hb), old.server);
      const youngUid = server.seed(META, claim("young", young.hb), young.server);
      await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), hostNow, () => {}, { refused: true });
      expect(uids(server), `an hour-old claim of ours was swept (${written})`).toContain(youngUid);
      expect(uids(server), `the three-day-old claim stayed (${written})`).not.toContain(oldUid);
    }
  });

  it("PROGRESS, exactly: a claim this process wrote dates the folder by the monotonic clock, not the wall", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const real = Date.now();
    const hb = new Date(real - 2 * 3_600_000);
    const io = makeLeaseIo(server, toServerPath, ID);
    await io.ensureMetaFolder();
    await io.appendClaim(claim("written-here", hb));
    const own = server.tree.get(META)!.messages.at(-1)!;
    own.internalDate = hb;
    // This process wrote it two hours ago by its own monotonic clock.
    const held = peekMemo(ID)!;
    writeMemo(ID, held.generation, { claimWrittenMonoMs: performance.now() - 2 * 3_600_000 });
    // And an older claim of ours, 26 hours old: past one window, inside two — the wall-clock floor's gap.
    const older = server.seed(META, claim("older", new Date(real - 26 * 3_600_000)), new Date(real - 26 * 3_600_000));
    const done = await shrinkMeta(makeRequestOrganizerIo(server, toServerPath, ID), new Date(real), () => {}, { refused: true });
    expect(done.swept, "a claim past one window waited for two").toBeGreaterThanOrEqual(1);
    expect(uids(server)).not.toContain(older);
    expect(uids(server), "the claim this process wrote is the newest and stays").toContain(own.uid);
  });
});
