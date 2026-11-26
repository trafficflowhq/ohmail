import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { buildEnvironment } from "./surfaces-build.mjs";

const [runtimeArg, outputArg, quietFile, pgBin, pgLib, ...sizes] = process.argv.slice(2);
assert(runtimeArg && outputArg && quietFile && pgBin && pgLib && sizes.length > 0);
assert(sizes.every((size) => ["10000", "200000", "400000", "1000000"].includes(size)));
const runtime = resolve(runtimeArg);
const output = resolve(outputArg);
const guard = new AbortController();
let peakLoad = 0;
let stage = "admission";

function sampleLoad() {
  const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
  peakLoad = Math.max(peakLoad, load);
  if (!Number.isFinite(load) || load >= 18 || existsSync(quietFile)) guard.abort();
}

function admitted() {
  sampleLoad();
  guard.signal.throwIfAborted();
}

async function fixtureAt(file, child, done) {
  const deadline = Date.now() + 120_000;
  while (!existsSync(file)) {
    admitted();
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error("Fixture startup failed");
    }
    await Promise.race([done, delay(100, undefined, { signal: guard.signal })]);
  }
  const fixture = JSON.parse(await readFile(file, "utf8"));
  const base = new URL(fixture.baseUrl);
  assert(base.origin === fixture.baseUrl && base.protocol === "http:" && base.hostname === "127.0.0.1");
  return fixture;
}

async function request(fixture, path, body) {
  admitted();
  const started = performance.now();
  const response = await fetch(new URL(path, fixture.baseUrl), {
    redirect: "error",
    signal: AbortSignal.any([guard.signal, AbortSignal.timeout(20_000)]),
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${fixture.sessionToken}`,
      "accept-encoding": "identity",
      ...(body && { "content-type": "application/json", "idempotency-key": randomUUID() }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = Buffer.from(await response.arrayBuffer());
  const elapsedMs = Math.round(performance.now() - started);
  assert(response.ok, `HTTP ${response.status}`);
  const wire = {
    status: response.status,
    decodedBytes: data.length,
    gzipBytes: gzipSync(data).length,
    elapsedMs,
    sql: Number(response.headers.get("x-perf-sql-queries")),
  };
  admitted();
  return { value: JSON.parse(data), wire };
}

function draftCount(changes, seeded, seen) {
  for (const change of changes.filter((change) => change.type === "draft")) {
    assert(seeded.has(change.id) && change.entity?.body && change.entity?.html);
    assert(!change.entity.bodyOmitted && !seen.has(change.id));
    seen.add(change.id);
  }
  return seen.size;
}

async function measure(fixture, size) {
  assert.equal(fixture.rowCount, Number(size));
  assert(fixture.attachmentCount > 0);
  const seeded = new Set();
  stage = "seed rich drafts";
  for (let index = 0; index < 20; index++) {
    const text = randomBytes(144 * 1024).toString("base64");
    const { value } = await request(fixture, "/drafts", {
      mailboxId: fixture.mailboxId,
      subject: `Synthetic draft ${index + 1}`,
      html: `<p>${text}</p>`,
    });
    assert(value.id && value.body.length === text.length && value.html.length >= text.length);
    seeded.add(value.id);
  }
  assert.equal(seeded.size, 20);

  stage = "ordinary sync page";
  const since = `since=${encodeURIComponent(fixture.initialCursor)}`;
  const full = await request(fixture, `/sync?${since}&limit=500`);
  assert.equal(draftCount(full.value.changes.creates, seeded, new Set()), 20);
  assert.equal(full.value.hasMore, false);

  stage = "paged sync control";
  const paged = [];
  const seen = new Set();
  let cursor = fixture.initialCursor;
  for (let page = 0; page < 5; page++) {
    const next = await request(fixture, `/sync?since=${encodeURIComponent(cursor)}&limit=8`);
    const before = seen.size;
    const count = draftCount(next.value.changes.creates, seeded, seen) - before;
    paged.push({ ...next.wire, drafts: count });
    assert.notEqual(next.value.cursor, cursor);
    cursor = next.value.cursor;
    if (!next.value.hasMore) break;
  }
  assert.equal(cursor, full.value.cursor);
  assert.equal(seen.size, seeded.size);

  stage = "initial snapshot";
  const snapshot = await request(fixture, "/sync/snapshot?limit=500");
  assert.equal(draftCount(snapshot.value.changes, seeded, new Set()), 20);
  assert(snapshot.value.nextCursor);
  return {
    mailboxMessages: Number(size),
    attachmentRecords: fixture.attachmentCount,
    drafts: seeded.size,
    fullDelta: full.wire,
    firstSnapshotPage: snapshot.wire,
    smallerDeltaPages: paged,
    deltaControlSameHorizon: true,
  };
}

const timer = setInterval(sampleLoad, 100);
try {
  const measurements = [];
  for (const size of sizes) {
    stage = "fixture startup";
    admitted();
    const trial = await mkdtemp(join(output, "a5-"));
    const state = join(trial, "db");
    const child = spawn(
      process.execPath,
      [
        "--conditions=ohmail-source",
        "--import",
        "tsx",
        "tools/perf/mailbox-host.ts",
        "--output",
        output,
        "--state",
        state,
        "--rows",
        size,
        "--pg-bin",
        resolve(pgBin),
        "--template",
        join(output, "templates-with-files", size),
      ],
      {
        cwd: runtime,
        env: { ...(await buildEnvironment(trial)), LD_LIBRARY_PATH: resolve(pgLib) },
        stdio: "ignore",
      },
    );
    const done = new Promise((settled, reject) => {
      child.once("error", reject);
      child.once("close", settled);
    });
    try {
      measurements.push(await measure(await fixtureAt(join(state, "mailbox-ready.json"), child, done), size));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await done;
    }
  }
  admitted();
  console.log(JSON.stringify({ peakLoad, measurements }, null, 2));
} catch (error) {
  const status = /^HTTP [1-5]\d\d$/.test(error.message) ? ` (${error.message})` : "";
  console.error(
    guard.signal.aborted
      ? "Workstation guard withheld the run."
      : `Fixture probe failed during ${stage}${status}.`,
  );
  process.exitCode = guard.signal.aborted ? 75 : 1;
} finally {
  clearInterval(timer);
}
