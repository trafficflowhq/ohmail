import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import { createLogger, ALLOWED_FIELDS } from "../../src/log.js";
import {
  PROFILE_TIDY_MAX_PER_PASS,
  formatProfileMessage,
  makeProfileDoc,
  makeProfileIo,
  readOrganizerProfile,
  tidyOrganizerProfile,
  writeOrganizerProfile,
  type OrganizerProfilePayload,
} from "../../src/adapters/organizer-profile.js";
import { bracketSpan, withoutCommentsAndLiterals } from "../../../../scripts/lib/source-scan.mjs";

/**
 * THE TIDY'S SELECTOR, measured on the folder it exists for (FIX-026). A settings
 * message goes only when it is ohmail-shaped, superseded by a readable current document, and one
 * of: unreadable, this install's, identical to the current one, or another install's copy ten
 * minutes older whose writer holds no fresh claim. Everything else in `ohmail/_meta` stays.
 */

const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const SELF = "install-self";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const C_AT = new Date("2026-09-28T11:00:00.900Z");

beforeEach(() => { resetMetaMemos(); });

function payload(tag: string): OrganizerProfilePayload {
  return { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [tag], signature: null };
}
function settings(tag: string, at: Date, installId: string, p: OrganizerProfilePayload = payload(tag)): string {
  return formatProfileMessage(makeProfileDoc(p, { updatedAt: at, producer: { kind: "cloud", version: "test" } }), { installId });
}
const minutesBefore = (m: number, from: Date = C_AT): Date => new Date(from.getTime() - m * 60_000);
const claim = (installId: string, heartbeat: Date): string => [
  "X-Ohmail-Lease: 1", `X-Ohmail-Install-Id: ${installId}`, "X-Ohmail-Protocol: 1",
  `X-Ohmail-Heartbeat: ${heartbeat.toISOString()}`, "Subject: ohmail organizer claim", "", "claim",
].join("\r\n");

/** The measured folder, and which uids the test itself says may go. */
function census(server: MemoryImapServer): { removable: Set<number>; current: number; kept: Set<number> } {
  const removable = new Set<number>();
  const kept = new Set<number>();
  const add = (set: Set<number>, raw: string): void => { set.add(server.seed(META, raw)); };
  for (let i = 0; i < 300; i++) add(removable, settings(`own-${i}`, new Date(Date.UTC(2026, 8, 27, 0, 0, i)), SELF));
  for (let i = 1; i <= 8; i++) add(removable, settings(`stale-${i}`, minutesBefore(20 + i), `stale-${i}`));
  for (let i = 1; i <= 2; i++) add(kept, settings(`fresh-${i}`, minutesBefore(5), `fresh-${i}`));
  for (let i = 1; i <= 2; i++) add(kept, settings(`claimed-${i}`, minutesBefore(30), `claimed-${i}`));
  add(removable, settings("current", new Date(C_AT.getTime() - 800), "install-dup", payload("current")));
  add(removable, [
    "X-Ohmail-Profile: 1", "X-Ohmail-Install-Id: torn-install", "X-Ohmail-Profile-Version: 2",
    "Subject: ohmail settings for this mailbox", `Date: ${C_AT.toUTCString()}`, "", "{ torn",
  ].join("\r\n"));
  add(kept, settings("own-other-subject", minutesBefore(60), SELF).replace(
    "Subject: ohmail settings for this mailbox", "Subject: hello"));
  add(kept, settings("near-miss", minutesBefore(60), SELF).replace("X-Ohmail-Profile: 1", "X-Forwarded-X-Ohmail-Profile: 1"));
  add(kept, "Subject: a note\r\n\r\nit mentions X-Ohmail-Profile: 1 in its body");
  add(kept, claim("claimed-1", new Date(NOW.getTime() - 60_000)));
  add(kept, claim("claimed-2", new Date(NOW.getTime() - 60_000)));
  add(kept, claim("stale-1", new Date(NOW.getTime() - 2 * 3_600_000)));
  add(kept, "X-Ohmail-Ack: 1\r\nX-Ohmail-Install-Id: claimed-1\r\nSubject: ack\r\n\r\nack");
  add(kept, "X-Ohmail-Request: 1\r\nX-Ohmail-Install-Id: claimed-1\r\nSubject: request\r\n\r\nrequest");
  for (let i = 0; i < 3; i++) add(kept, `Subject: stranger ${i}\r\n\r\nnot ohmail's`);
  const current = server.seed(META, settings("current", C_AT, SELF));
  return { removable, current, kept };
}

const uidsIn = (server: MemoryImapServer): Set<number> => new Set(server.tree.get(META)!.messages.map((m) => m.uid));
const tidy = (server: MemoryImapServer, mode: "remove" | "count", log?: (e: string, d: Record<string, unknown>) => void) =>
  tidyOrganizerProfile({
    io: makeProfileIo(server, toServerPath, { installId: SELF, mailboxId: "tidy" }),
    installId: SELF, mode, now: NOW, ...(log === undefined ? {} : { log }),
  });

describe("the selector census", () => {
  it("count mode removes nothing and logs the exact plan first", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    census(server);
    const before = uidsIn(server);
    const lines: Array<[string, Record<string, unknown>]> = [];

    const r = await tidy(server, "count", (e, d) => { lines.push([e, d]); });

    expect(uidsIn(server)).toEqual(before);
    expect(lines[0]?.[0], "the plan is the first line").toBe("profile_tidy_planned");
    expect(r.planned).toEqual({
      records: 316, current: 1, removable: 310, own: 300, foreignStale: 8, duplicate: 1, released: 0, malformed: 1,
      keptForeignFresh: 4, keptUnrecognised: 1, keptNewerDated: 0, keptHeld: 0, keptOwnBesideUnseen: 0, keptFound: 0,
      foundStale: 0, keptUnread: 0, unseenCurrent: 0,
    });
    expect(r).toMatchObject({ removed: 0, remaining: 310 });
  });

  it("remove mode converges in four passes to the current document and everything that is not removable", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const { removable, current, kept } = census(server);
    const gone: number[] = [];
    const perPass: number[] = [];
    for (let pass = 0; pass < 5; pass++) {
      const before = uidsIn(server);
      const r = await tidy(server, "remove");
      const after = uidsIn(server);
      const removed = [...before].filter((u) => !after.has(u));
      expect(removed.length, `pass ${pass + 1} removed more than one pass may`).toBeLessThanOrEqual(PROFILE_TIDY_MAX_PER_PASS);
      expect(r.removed).toBe(removed.length);
      perPass.push(removed.length);
      gone.push(...removed);
    }

    expect(perPass).toEqual([100, 100, 100, 10, 0]);
    expect(gone.filter((u) => !removable.has(u)), "a uid the selector may not name was removed").toEqual([]);
    expect(new Set(gone)).toEqual(removable);
    expect(uidsIn(server)).toEqual(new Set([current, ...kept]));
    const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, { installId: "reader", mailboxId: "tidy" }), { now: NOW });
    expect(read.state === "found" && read.residue).toBe(0);
  });
});

describe("the fresh-claim test reads the server's clock, as the election does", () => {
  it("a writer whose own heartbeat reads stale and whose server stamp is fresh keeps its copy", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const theirs = server.seed(META, settings("theirs", minutesBefore(30), "skewed-writer"));
    // The writer's clock says two hours ago; the server stamped the claim a minute ago.
    server.seed(META, claim("skewed-writer", new Date(NOW.getTime() - 2 * 3_600_000)), new Date(NOW.getTime() - 60_000));
    server.seed(META, settings("current", C_AT, SELF));

    const r = await tidy(server, "remove");

    expect(r.planned).toMatchObject({ keptForeignFresh: 1, foreignStale: 0 });
    expect(uidsIn(server).has(theirs), "a copy whose writer the server shows live was removed").toBe(true);
  });
});

describe("the plan's counts partition the records it read", () => {
  it("an unreadable copy dated after the current document is kept, and counted as such", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const { removable } = census(server);
    server.seed(META, [
      "X-Ohmail-Profile: 1", "X-Ohmail-Install-Id: torn-later", "X-Ohmail-Profile-Version: 2",
      "Subject: ohmail settings for this mailbox", `Date: ${new Date(C_AT.getTime() + 60_000).toUTCString()}`, "", "{ torn",
    ].join("\r\n"));

    const r = await tidy(server, "count");

    const c = r.planned!;
    expect(c.keptNewerDated).toBe(1);
    expect(c.removable).toBe(removable.size);
    expect(c.current + c.removable + c.keptForeignFresh + c.keptUnrecognised + c.keptNewerDated + c.keptHeld + c.keptOwnBesideUnseen,
      "a record the plan read is in no bucket").toBe(c.records);
  });
});

describe("a newer format anywhere stops every removal", () => {
  const newerBelow = (withHeader: boolean): string => {
    const raw = settings("from-a-later-build", minutesBefore(60), SELF);
    return withHeader ? raw.replace("X-Ohmail-Profile-Version: 2", "X-Ohmail-Profile-Version: 3") : raw.replace("X-Ohmail-Profile-Version: 2\r\n", "");
  };

  it("a version-3 header on an older copy: the read says newer, the write refuses, the tidy removes nothing", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, newerBelow(true));
    server.seed(META, settings("current", C_AT, SELF));
    const before = server.tree.get(META)!.messages.map((m) => m.raw);
    const io = makeProfileIo(server, toServerPath, { installId: SELF, mailboxId: "t8" });

    expect(await readOrganizerProfile(io)).toEqual({ state: "newer", v: 3 });
    expect(await writeOrganizerProfile({
      io, installId: SELF,
      doc: makeProfileDoc(payload("next"), { updatedAt: NOW, producer: { kind: "cloud", version: "test" } }),
    })).toEqual({ written: false, reason: "newer", v: 3 });
    expect(await tidy(server, "remove")).toMatchObject({ removed: 0, refused: "newer" });
    expect(server.tree.get(META)!.messages.map((m) => m.raw)).toEqual(before);
  });

  it("control: the same older copy without the version header is removed as superseded", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const older = server.seed(META, newerBelow(false));
    server.seed(META, settings("current", C_AT, SELF));

    expect(await tidy(server, "remove")).toMatchObject({ removed: 1, remaining: 0 });
    expect(uidsIn(server).has(older)).toBe(false);
  });
});

describe("only the live organizer's pass calls the tidy", () => {
  const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
  const srcFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "build") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...srcFiles(p));
      else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
    }
    return out;
  };
  const roots = (): string[] => ["apps", "packages"].flatMap((top) => readdirSync(join(ROOT, top))
    .map((pkg) => join(ROOT, top, pkg, "src")).filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } }));

  it("one CALL expression across apps/*/src and packages/*/src, inside OrganizerProfileSync.onOrganize", () => {
    const calls: string[] = [];
    let scanned = 0;
    for (const file of roots().flatMap(srcFiles)) {
      const src = readFileSync(file, "utf8");
      const code = withoutCommentsAndLiterals(src);
      scanned += 1;
      for (const m of code.matchAll(/(?<![\w$])tidyOrganizerProfile\s*\(/g)) {
        if (/function\s+$/.test(code.slice(Math.max(0, m.index! - 20), m.index!))) continue;
        const method = /async\s+onOrganize\s*\(/g;
        let inside = false;
        for (const o of code.matchAll(method)) {
          const open = code.indexOf("{", code.indexOf(")", o.index!));
          const body = bracketSpan(code, open, "{", "}");
          if (m.index! > open && m.index! < body.end) inside = true;
        }
        calls.push(`${relative(ROOT, file)}${inside ? " onOrganize" : ""}`);
      }
    }
    expect(scanned, "the census scanned nothing").toBeGreaterThan(200);
    expect(calls).toEqual(["apps/worker/src/profile.ts onOrganize"]);
  });
});

describe("every field the tidy logs survives the real logger", () => {
  const FIELDS = ["records", "current", "removable", "own", "foreignStale", "duplicate", "malformed",
    "keptForeignFresh", "keptUnrecognised", "keptNewerDated", "keptHeld", "keptOwnBesideUnseen", "keptFound", "foundStale", "keptUnread",
    "released", "unseenCurrent", "remaining", "owed", "removed", "tidyMode"];

  it("each field is admitted and reaches the emitted line", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    census(server);
    expect(FIELDS, "a count the plan logs is not checked here").toEqual(expect.arrayContaining(Object.keys((await tidy(server, "count")).planned!)));
    const lines: string[] = [];
    const log = createLogger({ service: "worker", sink: (l) => { lines.push(l); } });
    const detail = Object.fromEntries(FIELDS.map((f, i) => [f, f === "tidyMode" ? "count" : f === "owed" ? true : i]));
    log.info("profile_tidy_planned", detail);
    const emitted = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    for (const f of FIELDS) {
      expect(ALLOWED_FIELDS, `${f} is off the census`).toContain(f);
      expect(emitted[f], `${f} was dropped by the logger`).toEqual(detail[f]);
    }
  });
});
