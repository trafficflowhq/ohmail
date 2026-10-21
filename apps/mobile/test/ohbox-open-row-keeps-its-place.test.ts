/**
 * THE ROW BEING READ KEEPS ITS PLACE IN "NEW" ON THE PHONE TOO (owner ruling 2026-09-18, narrowed
 * 2026-10-07). `openMessage` holds the row in the engine before it saves the read, the world
 * derives the Ohbox with that hold, and the reader's leaving lets it go — to the top of Earlier,
 * because the read was an open read; a read of another row with no row named keeps arrival (a
 * row's own Mark read names it: `row-read-is-an-open-read.test.ts`). On a two-pane
 * posture the list stands beside the reader, so a row that moved at the read moved under them.
 * MUTATIONS WATCHED (mutation-control.sh): the hold in `openMessage` removed, and the `openHeld`
 * argument dropped from `liveOhbox`'s `ohboxView` call — the held arms below go red.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveOhbox, presentedOf, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/* @reads: apps/mobile/src/ui/MessageReader.tsx apps/mobile/src/state/world.tsx */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READER = readFileSync(join(APP, "src/ui/MessageReader.tsx"), "utf8");
const WORLD = readFileSync(join(APP, "src/state/world.tsx"), "utf8");

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

async function session(opts: { threaded?: boolean } = {}) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  // `threaded`: m2 answers a read m0 in thread T, the shape a person reported (2026-09-28).
  const t = opts.threaded ? "T" : null;
  fake.addMessage({ ...dto("m1", { subject: "First" }), date: "2026-08-19T10:00:00Z" });
  fake.addMessage({ ...dto("m2", { subject: "Second" }), date: "2026-08-19T09:00:00Z", threadId: t });
  fake.addMessage({ ...dto("m3", { subject: "Third" }), date: "2026-08-19T08:00:00Z" });
  // Read already, and NEWER than m2: at arrival m2 would file below it.
  fake.addMessage({ ...dto("m4", { subject: "Fourth", unread: false }), date: "2026-08-19T09:30:00Z" });
  if (t) fake.addMessage({ ...dto("m0", { subject: "Second", unread: false }), date: "2026-08-18T09:00:00Z", threadId: t });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m) });
  const box = () => liveOhbox(presentedOf(boot.engine.read(), view.now), view, boot.engine.openRowHeld());
  return { fake, boot, actions, box };
}

describe("the phone's Ohbox holds the open row", () => {
  it("opened, it stays in New at its place while read; left, it files at the top of Earlier", async () => {
    const s = await session();
    try {
      expect(s.box().fresh.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(await s.actions.openMessage("m2")).toBe(true);
      const open = s.box();
      expect(open.fresh.map((m) => m.id), "the read moved the row under the reader").toEqual(["m1", "m2", "m3"]);
      expect(open.seen.map((m) => m.id)).not.toContain("m2");
      expect(open.unreadIds, "the count follows the read, the place does not").toEqual(["m1", "m3"]);

      s.actions.leaveMessage("m2");
      const after = s.box();
      expect(after.fresh.map((m) => m.id)).toEqual(["m1", "m3"]);
      // The open read put m2 above m4, which arrived later — and the server's drain kept it there.
      expect(after.seen.map((m) => m.id)).toEqual(["m2", "m4"]);
      expect(s.fake.message("m2")?.openReadAt, "the server stamped the open read").toEqual(expect.any(String));
      await s.boot.engine.syncOnce();
      expect(s.box().seen[0]?.id, "the drain moved the row back to arrival").toBe("m2");
      s.boot.store.close();
    } finally {
      s.fake.server.close();
    }
  });

  it("CONTROL: a row read that nobody opened here moves at once, at arrival", async () => {
    const s = await session();
    try {
      await s.actions.openMessage("m1");
      await s.actions.markSeen("m3", false);
      const v = s.box();
      expect(v.fresh.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(v.seen.map((m) => m.id), "m3 arrived before m4 and files below it").toEqual(["m4", "m3"]);
      s.boot.store.close();
    } finally {
      s.fake.server.close();
    }
  });

  // Owner 2026-10-21: the reader's Mark as read on the open message is a read in ohmail.
  it("opened while read, Mark unread, then the reader's Mark as read: left, it files at the top of Earlier", async () => {
    const s = await session();
    try {
      await s.actions.markSeen("m1", false);
      expect(s.box().seen.map((m) => m.id), "the premise: m1 arrived after m4").toEqual(["m1", "m4"]);
      expect(await s.actions.openMessage("m4")).toBe(true);
      await s.actions.markSeen("m4", true);
      expect(s.box().fresh.map((m) => m.id)).toContain("m4");
      await s.actions.markSeen("m4", false, ["m4"], "m4");
      expect(s.box().fresh.map((m) => m.id), "held while it is open").toContain("m4");
      s.actions.leaveMessage("m4");
      expect(s.box().seen.map((m) => m.id)).toEqual(["m4", "m1"]);
      expect(s.fake.message("m4")?.openReadAt, "the server stamped the open read").toEqual(expect.any(String));
      s.boot.store.close();
    } finally {
      s.fake.server.close();
    }
  });
});

describe("an answer files the open row on the phone (owner defect 2026-09-28)", () => {
  it("open m2, reply to one person: at the confirm m2 leaves New for Earlier", async () => {
    const s = await session({ threaded: true });
    try {
      expect(await s.actions.openMessage("m2")).toBe(true);
      expect(s.box().fresh.map((m) => m.id), "the premise: held in New").toContain("m2");
      const r = await s.actions.sendReply("m2", "TOPPPENS!", false);
      expect(r.outcome).toBe("sent");
      const v = s.box();
      expect(s.boot.engine.openRowHeld(), "the answer did not end the hold").toBeNull();
      expect(v.fresh.map((m) => m.id)).toEqual(["m1", "m3"]);
      // Looked up BY ROW: the conversation is one row now, faced and opened by the reply.
      const onT = [...v.resurfaced, ...v.fresh, ...v.seen].filter((m) => m.memberIds?.includes("m2"));
      expect(onT.map((m) => m.rowKey), "one row for the conversation").toEqual(["T"]);
      expect(v.seen.find((m) => m.rowKey === "T")?.memberIds).toEqual(expect.arrayContaining(["m2", "m0"]));
      s.boot.store.close();
    } finally {
      s.fake.server.close();
    }
  });

  it("CONTROL: a reply to another conversation keeps the open row held", async () => {
    const s = await session({ threaded: true });
    try {
      await s.actions.openMessage("m2");
      expect((await s.actions.sendReply("m1", "Other", false)).outcome).toBe("sent");
      expect(s.boot.engine.openRowHeld()).toBe("m2");
      expect(s.box().fresh.map((m) => m.id)).toContain("m2");
      s.boot.store.close();
    } finally {
      s.fake.server.close();
    }
  });
});

describe("the wiring the list and the reader run", () => {
  it("the world derives the Ohbox with the engine's hold", () => {
    const projection = readFileSync(join(APP, "src/state/world-projection.ts"), "utf8");
    expect(projection).toContain("const openHeld = engine.openRowHeld();");
    expect(projection).toContain("liveOhbox(pres, v, openHeld)");
  });
  it("the reader's leaving releases the row it held", () => {
    expect(READER).toContain("const leaveMessage = w.actions.leaveMessage;");
    expect(READER).toMatch(/useEffect\(\(\) => \(\) => \{\s*if \(id\) leaveMessage\(id\);\s*\}, \[id, leaveMessage\]\);/);
  });
});
