import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxFolders, messages } from "@trafficflow/db";
import { LOCK_FILE, openLocalDb, type OpenLocalDb } from "../../src/db.js";
import { freshDataDir } from "../_datadir.js";

/**
 * WHAT A HARD KILL COSTS, BY KILLING ONE. This kills a child running `openLocalDb`,
 * reopens it and counts. The drain writes inside `inStoreLane("ingest", …)` where
 * `synchronous_commit` is `off`, so a kill takes what the store's own flush has not written out —
 * at most INGEST_LOG_FLUSH_MS of it. A write that belongs to NO drain commits under `on` and is
 * not lost at all. The last two cases are the flush's: a relaxed write kept once the flush has
 * run, and the same write gone with the flush a minute away.
 */

const SIDECAR_DIR = fileURLToPath(new URL("../..", import.meta.url));
/* The child runs the source through tsx, in its own process, so a stale `dist` cannot measure old code. */
const SIDECAR_DB_ENTRY = fileURLToPath(new URL("../../src/db.ts", import.meta.url));
const SIDECAR_LANES_ENTRY = fileURLToPath(new URL("../../src/store-lanes.ts", import.meta.url));
const KILL_ACCOUNT = "00000000-0000-4000-8000-0000000c7a55";
/** The drain folds this many batches, then holds the last write of the next one open for the kill. */
const FOLDS_BEFORE_KILL = 4;

/**
 * The child. Nothing here may be clever — a `finally`, a flush on exit or a clean close would
 * defeat the whole cell. The periodic checkpointer is left at PRODUCTION's five minutes, so every
 * fold a run takes is the per-cycle one and the bound below is attributable to it.
 * It transcribes the drain's three deciding lines rather than running it: the lane (`engine.ts`),
 * one transaction carrying a message AND the folder cursor that names it (`apps/worker/src/sync.ts`)
 * and a fold per cycle that has more backlog.
 */
const CHILD = `
import { openLocalDb } from "__DB__";
import { inStoreLane } from "__LANES__";

const h = await openLocalDb("__DIR__", { checkpointIntervalMs: 5 * 60 * 1000, __FLUSH__ });
const acct = "${KILL_ACCOUNT}";
await h.db.execute("insert into accounts (id, name) values ('" + acct + "', 'kill')");
const mb = await h.db.execute(
  "insert into mailboxes (account_id, provider, address) values ('" + acct + "', 'imap', 'me@ohmail.test') returning id");
const mailboxId = String(Object.values((mb.rows ?? mb)[0])[0]);
const fd = await h.db.execute(
  "insert into mailbox_folders (mailbox_id, folder, uidnext) values ('" + mailboxId + "', 'INBOX', 1) returning id");
const folderId = String(Object.values((fd.rows ?? fd)[0])[0]);
// The fixture is made durable BEFORE anything else: what is behind this fold must survive the kill.
await h.checkpoint();
process.stdout.write("checkpointed\\n");

const mode = "__MODE__";
if (mode === "drain") {
  const BATCH = __BATCH__;
  const HELD = (__FOLDS__ + 1) * BATCH;
  await inStoreLane("ingest", async () => {
    for (let cycle = 0; ; cycle += 1) {
      for (let i = 1; i <= BATCH; i += 1) {
        const uid = cycle * BATCH + i;
        // ONE TRANSACTION CARRYING THE ROW AND THE CURSOR THAT NAMES IT. Recovery replays a PREFIX
        // of the log, so a cursor that commits with its row can be lost with it and can never
        // outlive it. That is the whole reason a lost tail is safe.
        await h.db.transaction(async (tx) => {
          await tx.execute(
            "insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, native_locator) values ('"
            + acct + "', '" + mailboxId + "', 'h" + uid + "', 'kill:" + uid + "', 's" + uid
            + "', 'a@mail.example', '{\\"folder\\":\\"INBOX\\",\\"ref\\":\\"1:" + uid + "\\"}'::jsonb)");
          await tx.execute("update mailbox_folders set uidnext = " + (uid + 1) + " where id = '" + folderId + "'");
          // THE KILL'S SIGNAL: the last write of the batch after the last fold is held OPEN, so
          // that batch is written and not folded and this message is in flight. The parent kills
          // on this line, never after a delay — a delay raced the next fold at load.
          if (uid === HELD) {
            setInterval(() => {}, 1000);
            process.stdout.write("in-flight " + uid + "\\n");
            await new Promise(() => {});
          }
        });
        process.stdout.write("wrote " + uid + "\\n");
      }
      // THE DRAIN'S OWN LINE, reached because there is more backlog behind this cycle.
      await h.checkpoint();
      process.stdout.write("folded " + ((cycle + 1) * BATCH) + "\\n");
      // A turn of the event loop, which the real cycle takes between batches.
      await new Promise((r) => setTimeout(r, 0));
    }
  });
} else {
  // A PERSON'S OWN EDIT, with no drain in flight. A TRANSACTION in both modes, because the
  // relaxation is applied to transactions and to nothing else: a bare statement inside the lane
  // keeps the session default and the control would pass for the wrong reason. The lane is then
  // the only difference between this case and its control.
  const write = () => h.db.transaction(async (tx) => {
    await tx.execute(
      "insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, native_locator) values ('"
      + acct + "', '" + mailboxId + "', 'edit', 'the-edit', 'THE EDIT', 'a@mail.example', '{\\"folder\\":\\"INBOX\\",\\"ref\\":\\"1:1\\"}'::jsonb)");
    const g = await tx.execute("show synchronous_commit");
    process.stdout.write("synchronous_commit " + String(Object.values((g.rows ?? g)[0])[0]) + "\\n");
  });
  if (mode.startsWith("edit-in-lane")) await inStoreLane("ingest", write); else await write();
  process.stdout.write("edited\\n");
}
setInterval(() => {}, 1000);
`;

const dirs: string[] = [];
const open: OpenLocalDb[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close().catch(() => { /* a killed handle is fine */ });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Killed { out: string; err: string; dir: string }

/** Run the child in `mode`, wait for `until` in its output, idle, `SIGKILL`, hand back the dir. */
async function killChild(
  mode: "drain" | "edit" | "edit-in-lane" | "edit-in-lane-unflushed",
  until: RegExp,
  idleMs: number,
  batch = 100,
): Promise<Killed> {
  const dir = await freshDataDir(`ohmail-kill-${mode}-`);
  dirs.push(dir);
  const file = join(dir, "kill-child.mjs");
  writeFileSync(file, CHILD
    .replace("__DB__", pathToFileURL(SIDECAR_DB_ENTRY).href)
    .replace("__LANES__", pathToFileURL(SIDECAR_LANES_ENTRY).href)
    .replace("__DIR__", dir)
    .replace("__MODE__", mode)
    .replace("__BATCH__", String(batch))
    .replace("__FOLDS__", String(FOLDS_BEFORE_KILL))
    // The unflushed control moves the flush a minute out; every other case runs production's.
    .replace("__FLUSH__", mode === "edit-in-lane-unflushed" ? "logFlushIntervalMs: 60_000" : ""));

  const proc = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx", file], {
    cwd: SIDECAR_DIR, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (c: string) => { out += c; });
  proc.stderr.on("data", (c: string) => { err += c; });
  const end = Date.now() + 90_000;
  while (!until.test(out) && Date.now() < end && proc.exitCode === null) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, idleMs));
  proc.kill("SIGKILL");
  await new Promise((r) => proc.on("exit", r));
  rmSync(join(dir, LOCK_FILE), { force: true });   // the killed process never released it
  return { out, err, dir };
}

/** The reopen. A corrupt directory refuses HERE, which is the difference `fsync` on buys. */
async function reopen(dir: string): Promise<OpenLocalDb> {
  const h = await openLocalDb(dir, { checkpointIntervalMs: 5 * 60 * 1000 });
  open.push(h);
  return h;
}

describe("a hard kill, and what the store still holds after it", () => {
  /**
   * ── THE DRAIN'S LOSS WINDOW IS ONE BATCH ────────────────────────────────────────────────────
   *
   * What the child announces is what it has FOLDED — the line is written after the checkpoint — so
   * the count it reports is a promise about the disk and the assertion is read against it. The kill
   * lands on the child's `in-flight` line: the next batch written but for its last message, which
   * is inside an open transaction, and none of it folded.
   */
  it("mid-drain: it loses at most the batch it was on, and its cursor claims none of it", async () => {
    const BATCH = 100;
    const { out, err, dir } = await killChild("drain", /^in-flight \d+$/m, 0, BATCH);
    const why = `; stderr: ${err.slice(0, 400)}`;
    expect(out, `the child never reached its first fold${why}`).toMatch(/^checkpointed$/m);
    expect(out, `the kill did not land on the child's in-flight write${why}`)
      .toMatch(new RegExp(`^in-flight ${(FOLDS_BEFORE_KILL + 1) * BATCH}$`, "m"));
    const last = (re: RegExp, from: number): number =>
      Math.max(0, ...(out.match(re) ?? []).map((l) => Number(l.slice(from))));
    const folded = last(/^folded (\d+)$/gm, 7);
    const wrote = last(/^wrote (\d+)$/gm, 6);
    // Anti-vacuity: a kill that landed before the drain was under way measures nothing.
    expect(folded, `the child folded ${folded} messages in before the kill${why}`)
      .toBeGreaterThanOrEqual(FOLDS_BEFORE_KILL * BATCH);
    expect(wrote, `the child wrote ${wrote} and folded ${folded} — nothing was in flight${why}`)
      .toBeGreaterThan(folded);

    const after = await reopen(dir);
    const rows = await after.db.select({ id: messages.id }).from(messages);
    const [folder] = await after.db.select().from(mailboxFolders);
    expect(folder, `the checkpointed fixture did not survive the kill${why}`).toBeDefined();

    /* WHAT WAS FOLDED IN IS STILL THERE. A fold per cycle is worth nothing if the cycles behind it
       can go too, and that is the half a control-file reading cannot see. */
    expect(
      rows.length,
      `the child folded ${folded} messages in and only ${rows.length} came back${why}`,
    ).toBeGreaterThanOrEqual(folded);

    /* …AND WHAT IT LOST IS ONE BATCH AT MOST. The child announces every message it commits, so
       `wrote` is what the drain had taken in when the kill landed; everything past the last fold is
       what a kill can take, and the drain folds per cycle. */
    const lost = wrote - rows.length;
    expect(
      lost,
      `the drain had taken ${wrote} messages in, ${rows.length} came back, so ${lost} were lost — `
        + `a fold per cycle bounds that at one batch of ${BATCH}${why}`,
    ).toBeLessThanOrEqual(BATCH);

    /* AND THE CURSOR NEVER OUTRUNS THE ROWS. A folder's cursor commits WITH the message it names,
       so a crash that kept the cursor kept the row. Ahead by one is mail nobody would fetch again. */
    const claims = Number(folder!.uidnext ?? 1n) - 1;
    expect(claims, `the cursor claims ${claims} messages and the store holds ${rows.length}${why}`)
      .toBeLessThanOrEqual(rows.length);
    expect(claims, `the cursor never advanced at all${why}`).toBeGreaterThan(0);
  }, 300_000);

  /**
   * ── AND A WRITE THAT BELONGS TO NO DRAIN IS NOT LOST AT ALL ──────────────────────────────────
   *
   * The row this closes says such a write waits on the five-minute timer. It waits on nothing: it
   * commits under `synchronous_commit = on`, so its log record is written and flushed before the
   * call returns. Six seconds of idle and a `SIGKILL` — well inside an interval that is five
   * minutes long, with no fold of any kind behind the write — and the edit is there.
   */
  it("a write that belongs to no drain survives the kill, with the five-minute timer untouched", async () => {
    const { out, err, dir } = await killChild("edit", /^edited$/m, 6_000);
    const why = `; stderr: ${err.slice(0, 400)}`;
    expect(out, `the child never reached its edit${why}`).toMatch(/^edited$/m);
    // The child reports the setting IT observed, so a stale build fails by name rather than passing
    // for the wrong reason.
    expect(out, `the edit did not commit synchronously, so this measures something else${why}`)
      .toMatch(/^synchronous_commit on$/m);
    const after = await reopen(dir);
    const kept = await after.db.select({ id: messages.id }).from(messages);
    expect(kept.length, `the edit was lost with no drain in flight and the fold five minutes away${why}`)
      .toBe(1);
  }, 300_000);

  /**
   * ── A RELAXED WRITE IS ON THE DISK WITHIN THE FLUSH'S DEADLINE ───────────────────────────────
   *
   * The same write inside `inStoreLane("ingest", …)`, where the commit does not wait for the log,
   * and a kill three seconds later: the store's own flush has written it out, so it is there. The
   * case after it is the control: the same write with the flush a minute away is gone after the
   * same kill, so this one measures the flush and not a kill too gentle to lose anything.
   */
  it("a relaxed write inside the ingest's lane survives a kill once the store's flush has run", async () => {
    const { out, err, dir } = await killChild("edit-in-lane", /^edited$/m, 3_000);
    const why = `; stderr: ${err.slice(0, 400)}`;
    expect(out, `the child never reached its edit${why}`).toMatch(/^edited$/m);
    expect(out, `the write inside the lane was not relaxed, so this measures no flush${why}`)
      .toMatch(/^synchronous_commit off$/m);
    const after = await reopen(dir);
    const kept = await after.db.select({ id: messages.id }).from(messages);
    expect(kept.length, `the relaxed write was lost three seconds after it committed — the store's `
      + `flush did not write it out${why}`).toBe(1);
  }, 300_000);

  it("…and the same write is gone after the same kill with the flush a minute away", async () => {
    const { out, err, dir } = await killChild("edit-in-lane-unflushed", /^edited$/m, 3_000);
    const why = `; stderr: ${err.slice(0, 400)}`;
    expect(out, `the child never reached its edit${why}`).toMatch(/^edited$/m);
    expect(out, `the write inside the lane was not relaxed, so it is not a control${why}`)
      .toMatch(/^synchronous_commit off$/m);
    const after = await reopen(dir);
    const kept = await after.db.select({ id: messages.id }).from(messages);
    expect(
      kept.length,
      `the relaxed write survived with no flush behind it, so the case above proves nothing${why}`,
    ).toBe(0);
  }, 300_000);
});
