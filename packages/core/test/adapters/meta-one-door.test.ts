import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withoutCommentsAndLiterals } from "../../../../scripts/lib/source-scan.mjs";
import { memoryImapServer } from "./_metaworld.js";
import {
  META_ENUM_RECORDS_MAX, META_RECORDS_MAX_PER_FETCH, REQUEST_PAYLOAD_MAX_BYTES, REQUEST_RECORD_MAX_BYTES,
  formatRequest, makeLeasePeekIo, makeRequestOrganizerIo, metaFolderFullSentence, readLeasePeek,
  requestAppendHeadroom,
} from "../../src/adapters/organizer-lease.js";
import { IMAP_META_BYTES_MAX, META_ENUM_BYTES_MAX } from "../../src/adapters/imap-bounds.js";
import { META_HOLDER_RESERVE_RECORDS } from "../../src/adapters/organizer-lease.js";

/**
 * ONE DOOR FOR EVERY READER OF `ohmail/_meta` (FIX-026, ARCH-META-FOLDER-ONE-DOOR § 4 controls 4
 * and 6). The window read has one caller, nothing pages by uid, the removed page walk's names are
 * gone, a folder past the enumeration's ceiling refuses by name with the person's sentence at the
 * shipping constant, and the reader's append headroom keeps its ceilings.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SOURCE_ROOTS = ["packages/core/src", "packages/services/src", "packages/api/src", "apps/worker/src", "packages/organizer/src", "apps/sidecar/src", "apps/mobile/src"];

const META_MODULES = new Set([
  "packages/core/src/adapters/organizer-lease.ts", "packages/core/src/adapters/organizer-profile.ts",
  "packages/organizer/src/request-drain.ts",
]);

function sources(): Array<{ path: string; code: string }> {
  const out: Array<{ path: string; code: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (name === "node_modules" || name === "dist") continue;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
        out.push({ path: rel, code: withoutCommentsAndLiterals(readFileSync(join(ROOT, rel), "utf8")) });
      }
    }
  };
  for (const r of SOURCE_ROOTS) walk(r);
  return out;
}

describe("the census: one door", () => {
  const all = sources();
  it("reads source at all (the positive control)", () => {
    expect(all.length).toBeGreaterThan(200);
    expect(all.some((f) => f.code.includes("enumerateMetaFolder("))).toBe(true);
  });

  it("readMetaFolderWindow has exactly one caller, the door", () => {
    const calls = all.flatMap((f) => [...f.code.matchAll(/\breadMetaFolderWindow\(/g)].map(() => f.path));
    // The definition and the one call, both in the lease module.
    expect(calls).toEqual(["packages/core/src/adapters/organizer-lease.ts", "packages/core/src/adapters/organizer-lease.ts"]);
    const lease = all.find((f) => f.path === "packages/core/src/adapters/organizer-lease.ts")!.code;
    const door = lease.slice(lease.indexOf("export async function readMetaRecords("));
    expect(door.indexOf("readMetaFolderWindow(")).toBeGreaterThan(0);
    expect(door.indexOf("readMetaFolderWindow(")).toBeLessThan(door.indexOf("\n}\n"));
  });

  it("no listMetaRecords takes a cursor, and the page walk's names are gone", () => {
    const offenders = all.flatMap((f) => [
      ...(/listMetaRecords\(\s*[A-Za-z_]/.test(f.code) ? [`${f.path}: listMetaRecords(arg)`] : []),
      ...(/\bmetaPageBounds\b/.test(f.code) ? [`${f.path}: metaPageBounds`] : []),
      ...(/\bdrainCursor\b/.test(f.code) ? [`${f.path}: drainCursor`] : []),
      ...(/\bMetaFolderTruncatedError\b/.test(f.code) ? [`${f.path}: MetaFolderTruncatedError`] : []),
      // The `_meta` readers only: a uid cursor elsewhere is another folder's business.
      ...(META_MODULES.has(f.path) && /\bbeforeUid\b/.test(f.code) ? [`${f.path}: beforeUid`] : []),
    ]);
    expect(offenders).toEqual([]);
  });
});

describe("the enumeration's ceiling, at the shipping constant", () => {
  const META = "INBOX.ohmail._meta";
  const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
  const past = (): ReturnType<typeof memoryImapServer> => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < META_ENUM_RECORDS_MAX + 1; i++) server.seed(META, `Subject: s${i}\r\n\r\nb`);
    return server;
  };

  it("the peek answers unreadable as meta_folder_full, carrying the sentence with both counts", async () => {
    const server = past();
    const err = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: new Date() })
      .then(() => null, (e: unknown) => e as { op?: string; message: string });
    expect(err?.op).toBe("meta_folder_full");
    expect(err?.message).toBe(metaFolderFullSentence(META_ENUM_RECORDS_MAX + 1, META_ENUM_RECORDS_MAX));
    expect(err?.message).toContain("20001");
    expect(err?.message).toContain("20000");
    // Refused BEFORE any FETCH: the count alone decides it.
    expect(server.log.filter((l) => l.startsWith(`fetch ${META}`))).toEqual([]);
  });

  it("the request listing refuses by name, over_ceiling", async () => {
    const io = makeRequestOrganizerIo(past(), toServerPath, { installId: "us", mailboxId: "m" });
    await expect(io.listMetaRecords()).rejects.toMatchObject({ name: "RequestUnavailableError", code: "over_ceiling" });
  });
});

describe("the reader's append headroom", () => {
  it("inside the window: never past 500 records less the holder's reserve", () => {
    expect(requestAppendHeadroom({ count: 480, bytes: 0 })).toMatchObject({ headroom: 4, boundBy: "records", recordCeiling: 484 });
    expect(requestAppendHeadroom({ count: 484, bytes: 0 }).headroom).toBe(0);
    expect(requestAppendHeadroom({ count: 500, bytes: 0 }).headroom).toBe(0);
    expect(requestAppendHeadroom({ count: 0, bytes: 0 })).toMatchObject({ headroom: 484, boundBy: "records" });
  });

  it("leaves the holder room for its own renewal at every count inside the window (META-WINDOW-HOLDS-NOTHING-BACK)", () => {
    expect(META_HOLDER_RESERVE_RECORDS).toBeGreaterThan(0);
    for (let count = 0; count <= META_RECORDS_MAX_PER_FETCH; count++) {
      const { headroom } = requestAppendHeadroom({ count, bytes: 0 });
      expect(count + headroom + 1, `at ${count} a reader's appends leave the holder's renewal past the window`)
        .toBeLessThanOrEqual(Math.max(count + 1, META_RECORDS_MAX_PER_FETCH - META_HOLDER_RESERVE_RECORDS + 1));
    }
  });

  it("charges the reserve once in bytes: a 6 MiB folder under the window still takes appends (META-WINDOW-BYTE-RESERVE-CHARGED-TWICE)", () => {
    const sixMiB = 6 * 1024 * 1024;
    const room = requestAppendHeadroom({ count: 10, bytes: sixMiB });
    expect(room.headroom, "the whole window's reserve was charged again on top of each append").toBeGreaterThan(0);
    expect(sixMiB + room.headroom * REQUEST_RECORD_MAX_BYTES, "the appends cross the holder's byte reserve")
      .toBeLessThanOrEqual(IMAP_META_BYTES_MAX - META_HOLDER_RESERVE_RECORDS * REQUEST_RECORD_MAX_BYTES);
  });

  it("past the window: the enumeration's bound less one window, a window at a time", () => {
    expect(requestAppendHeadroom({ count: 520, bytes: 0 })).toMatchObject({ headroom: 500, recordCeiling: META_ENUM_RECORDS_MAX - 500 });
    expect(requestAppendHeadroom({ count: META_ENUM_RECORDS_MAX - 510, bytes: 0 })).toMatchObject({ headroom: 10, boundBy: "records" });
    expect(requestAppendHeadroom({ count: META_ENUM_RECORDS_MAX, bytes: 0 }).headroom).toBe(0);
  });

  it("the bytes half binds on its own, and names itself", () => {
    const past = requestAppendHeadroom({ count: 600, bytes: META_ENUM_BYTES_MAX });
    expect(past).toMatchObject({ headroom: 0, boundBy: "bytes" });
    const room = requestAppendHeadroom({ count: 10, bytes: 0 });
    const tight = requestAppendHeadroom({ count: 10, bytes: room.byteCeiling - 3 * REQUEST_RECORD_MAX_BYTES });
    expect(tight).toMatchObject({ headroom: 3, boundBy: "bytes" });
  });

  it("one formatted request at the payload ceiling fits REQUEST_RECORD_MAX_BYTES", () => {
    const payload = { blob: "x".repeat(Math.floor(REQUEST_PAYLOAD_MAX_BYTES * 3 / 4) - 32) };
    const raw = formatRequest({
      requestId: "11111111-1111-4111-8111-111111111111", kind: "profile.update",
      mailboxId: "22222222-2222-4222-8222-222222222222", installId: `install-${"i".repeat(64)}`,
      organizerKind: "cloud", decidedAt: new Date("2026-10-02T09:00:00Z"), payload: payload as never,
      key: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    });
    const header = raw.slice(0, raw.indexOf("\r\n\r\n") + 4);
    expect(Buffer.byteLength(header, "utf8")).toBeGreaterThan(REQUEST_PAYLOAD_MAX_BYTES - 64);
    expect(Buffer.byteLength(header, "utf8")).toBeLessThanOrEqual(REQUEST_RECORD_MAX_BYTES);
  });

  it("a byte ceiling configured at or below the reserve refuses at load, by name", () => {
    const dist = fileURLToPath(new URL("../../dist/adapters/organizer-lease.js", import.meta.url));
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ["-e", `import(${JSON.stringify(dist)}).then(() => console.log("LOADED"), (e) => console.log("REFUSED " + e.name + " " + e.message))`], {
      env: { ...process.env, ...env }, encoding: "utf8",
    });
    const refused = run({ TF_IMAP_META_MAX_BYTES: String(500 * REQUEST_RECORD_MAX_BYTES) });
    expect(refused.stdout).toContain("REFUSED ImapBoundConfigError");
    expect(refused.stdout).toContain("TF_IMAP_META_MAX_BYTES");
    expect(run({}).stdout.trim()).toBe("LOADED");
  });
});
