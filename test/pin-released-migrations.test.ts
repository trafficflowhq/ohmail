import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LOCK_PATH, diffLocks, journalSqlOf, lockFor } from "../scripts/pin-released-migrations.mjs";

/**
 * THE LOCK IS WRITTEN FROM A COMMIT, NEVER FROM A CHECKOUT (scripts/pin-released-migrations.mjs).
 *
 * The pins are what a release shipped, so they are read from the release commit's objects: a
 * half-edited working tree pins nothing, and `--check` says what a commit would change without
 * writing. Each rule is held on a planted repository; the last case holds this tree's own lock to
 * the version it ships, which is what turns a release that forgot to write its pins red.
 */
const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/pin-released-migrations.mjs");
const MAIL = "packages/db-mail/drizzle";
const CLOUD = "packages/db/drizzle-cloud";
const DEVICE = "packages/db-mail/drizzle-sqlite";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const scratch = mkdtempSync(join(tmpdir(), "ohmail-pin-released-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** A repository with one commit holding `files`, tagged `v1` with an annotated tag. */
function plant(files: Record<string, string>) {
  const dir = join(scratch, `r${n++}`);
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const put = (set: Record<string, string>) => {
    for (const [rel, text] of Object.entries(set)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  };
  const commit = (set: Record<string, string>, subject: string) => {
    put(set);
    git("add", "-A");
    git("commit", "-q", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const first = commit(files, "release");
  git("tag", "-a", "v1", "-m", "v1");
  const pin = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, "--root", dir, ...args], { encoding: "utf8" });
  const lock = () => readFileSync(join(dir, LOCK_PATH), "utf8");
  return { dir, first, git, put, commit, pin, lock };
}

const RELEASED = {
  [`${MAIL}/0000_first.sql`]: "CREATE TABLE a (id int);\n",
  [`${MAIL}/0001_second.sql`]: "ALTER TABLE a ADD COLUMN b text;\n",
  [`${MAIL}/meta/_journal.json`]: "{}\n",
  [`${MAIL}/README.md`]: "the mail journal\n",
  [`${CLOUD}/0000_cloud.sql`]: "CREATE TABLE c (id int);\n",
  [`${DEVICE}/0000_device.sql`]: "CREATE TABLE a (id integer);\n",
  [`${DEVICE}/0001.noop`]: "",
  "packages/db/drizzle/0000_before_the_split.sql": "CREATE TABLE old (id int);\n",
  "packages/db/README.md": "x\n",
};
const PINNED = [`${DEVICE}/0000_device.sql`, `${MAIL}/0000_first.sql`, `${MAIL}/0001_second.sql`, `${CLOUD}/0000_cloud.sql`];

describe("the released-migrations lock is written from a release commit", () => {
  it("pins the three journals' .sql files as the commit holds them, whatever the checkout holds", () => {
    const r = plant(RELEASED);
    // The checkout moves on after the release: an edit, and a migration nothing has released.
    r.put({ [`${MAIL}/0000_first.sql`]: "CREATE TABLE a (id bigint);\n", [`${MAIL}/0002_unreleased.sql`]: "SELECT 1;\n" });

    const run = r.pin("--write", "--release", "1.2.3", "--tag", "v1");
    expect(run.status, run.stderr).toBe(0);
    const lock = JSON.parse(r.lock());
    expect(lock.release).toBe("1.2.3");
    expect(lock.tag, "an annotated tag is stored as the commit it names").toBe(r.first);
    expect(Object.keys(lock.files)).toEqual(PINNED);
    for (const path of PINNED) expect(lock.files[path], path).toBe(sha(RELEASED[path as keyof typeof RELEASED]));
    expect(run.stdout).toBe(`LOCK 1.2.3 ${r.first} mail=2 cloud=1 device=1\n`);
    expect(r.lock().endsWith("}\n")).toBe(true);
  });

  it("checks without writing: equal reads 0, and a later commit's changes are named and read 1", () => {
    const r = plant(RELEASED);
    expect(r.pin("--write", "--release", "1.2.3", "--tag", "v1").status).toBe(0);
    expect(r.pin("--check", "--release", "1.2.3", "--tag", "v1").status).toBe(0);

    r.commit({ [`${CLOUD}/0000_cloud.sql`]: "CREATE TABLE c (id bigint);\n", [`${DEVICE}/0002_new.sql`]: "SELECT 1;\n" }, "edit a released file");
    execFileSync("git", ["rm", "-q", `${MAIL}/0001_second.sql`], { cwd: r.dir });
    const head = r.commit({}, "remove a released file");
    const before = r.lock();
    const run = r.pin("--check", "--release", "1.2.4", "--tag", head);
    const changes = [
      `LOCK 1.2.4 ${head} mail=1 cloud=1 device=2`,
      "~ release 1.2.3 -> 1.2.4",
      `~ tag ${r.first} -> ${head}`,
      `+ ${DEVICE}/0002_new.sql`,
      `- ${MAIL}/0001_second.sql`,
      `~ ${CLOUD}/0000_cloud.sql`,
    ];
    expect(run.status).toBe(1);
    expect(run.stdout.split("\n").filter(Boolean)).toEqual(changes);
    expect(r.lock(), "a check wrote the lock").toBe(before);

    // A write over the older lock says the same, so a re-pinned file is never silent.
    const rewrite = r.pin("--write", "--release", "1.2.4", "--tag", head);
    expect(rewrite.status).toBe(0);
    expect(rewrite.stdout.split("\n").filter(Boolean)).toEqual(changes);
    expect(r.pin("--check", "--release", "1.2.4", "--tag", head).stdout).toBe(`${changes[0]}\n`);
  });

  it("reads a lock written from an ancestor of the commit as equal: the bump pins at the commit it is cut from, the tag is the merge", () => {
    const r = plant(RELEASED);
    expect(r.pin("--write", "--release", "1.2.3", "--tag", "v1").status).toBe(0);
    const before = r.lock();
    // The bump: the lock and the version, no journal file. Its commit is what the release tags.
    const tagged = r.commit({ "package.json": '{ "version": "1.2.3" }\n' }, "release 1.2.3");
    const run = r.pin("--check", "--release", "1.2.3", "--tag", tagged);
    expect(run.stdout).toBe(`LOCK 1.2.3 ${tagged} mail=2 cloud=1 device=1\n= tag ${r.first}, an ancestor of ${tagged}\n`);
    expect(run.status).toBe(0);
    expect(r.lock(), "a check wrote the lock").toBe(before);

    // A commit beside the lock's, with the same files: the lock was not written on this line.
    r.git("checkout", "-q", "-b", "beside", r.first);
    const beside = r.commit({ "notes.txt": "x\n" }, "beside the release");
    writeFileSync(join(r.dir, LOCK_PATH), before.replace(r.first, beside));
    const other = r.pin("--check", "--release", "1.2.3", "--tag", tagged);
    expect(other.status).toBe(1);
    expect(other.stdout.split("\n").filter(Boolean)).toEqual([`LOCK 1.2.3 ${tagged} mail=2 cloud=1 device=1`, `~ tag ${beside} -> ${tagged}`]);

    // A lock whose commit is no object here at all (the 0.25.24 lock named one) differs too.
    writeFileSync(join(r.dir, LOCK_PATH), before.replace(r.first, "0".repeat(40)));
    expect(r.pin("--check", "--release", "1.2.3", "--tag", tagged).status).toBe(1);
  });

  it("runs when it is called through a linked folder", () => {
    const link = join(scratch, `scripts-link-${n++}`);
    symlinkSync(join(ROOT, "scripts"), link, "dir");
    const run = spawnSync(process.execPath, [join(link, "pin-released-migrations.mjs"), "--bogus"], { encoding: "utf8" });
    expect(run.stderr).toContain("usage: node scripts/pin-released-migrations.mjs");
    expect(run.status).toBe(2);
  });

  it("refuses a call that names no release, no commit, both verbs or none, and writes nothing", () => {
    const r = plant(RELEASED);
    const calls = [
      ["--write", "--tag", "v1"],
      ["--write", "--release", "1.2.3"],
      ["--release", "1.2.3", "--tag", "v1"],
      ["--write", "--check", "--release", "1.2.3", "--tag", "v1"],
      ["--write", "--release", "next", "--tag", "v1"],
      ["--write", "--release", "1.2.3", "--tag", "no-such-commit"],
    ];
    for (const args of calls) {
      const run = r.pin(...args);
      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stdout, args.join(" ")).toBe("");
    }
    expect(() => r.lock()).toThrow(/ENOENT/);
  });

  it("keeps a journal's own .sql entries and nothing beside or beneath them", () => {
    expect(journalSqlOf([
      `${MAIL}/0000_a.sql`, `${MAIL}/meta/_journal.json`, `${MAIL}/meta/0000_snapshot.sql`, `${MAIL}/README.md`,
      `${DEVICE}/0185.noop`, `${DEVICE}/0000_a.sql`, "packages/db/drizzle/0000_old.sql", `${CLOUD}/0000_c.sql`,
    ])).toEqual([
      { journal: "device", path: `${DEVICE}/0000_a.sql` },
      { journal: "mail", path: `${MAIL}/0000_a.sql` },
      { journal: "cloud", path: `${CLOUD}/0000_c.sql` },
    ]);
  });

  it("writes the files sorted by path, and reads two equal locks as no difference", () => {
    const a = lockFor("1.0.0", "a".repeat(40), [{ path: "z.sql", sha: "2" }, { path: "a.sql", sha: "1" }]);
    expect(Object.keys(a.files)).toEqual(["a.sql", "z.sql"]);
    expect(diffLocks(a, lockFor("1.0.0", "a".repeat(40), [{ path: "a.sql", sha: "1" }, { path: "z.sql", sha: "2" }]))).toEqual([]);
    expect(diffLocks(null, a)).toEqual(["~ release none -> 1.0.0", `~ tag none -> ${"a".repeat(40)}`, "+ a.sql", "+ z.sql"]);
  });
});

describe("this tree's lock", () => {
  it("names the release this tree ships: a version bump writes its pins in the same change", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, LOCK_PATH), "utf8")) as { release: string };
    const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(
      lock.release,
      "the lock is behind the version: run node scripts/pin-released-migrations.mjs --write --release <version> --tag <the commit on main the release is cut from>",
    ).toBe(version);
  });
});
