/**
 * A PHONE ORGANIZING ITS OWN MAILBOX NEVER HOLDS THE ACCOUNT'S OWN MAIL AT THE GATE.
 *
 * `startPhoneEngine` over `node:sqlite`, against a real IMAP server, no adapter double. The verdict
 * is the folder a client this engine knows nothing about finds the letter in. A stranger's letter
 * delivered beside it is the control: it reaches `ohmail/Screener`, so a green here is the gate
 * running and passing own mail, not a gate that files nothing. Runs under the sqlite project; the
 * default one states the premise.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import type { PhoneEngine, PhoneSqlExecutor, PhoneSqlRows } from "../src/mobile.js";
import { serviceUp } from "@trafficflow/db/testing";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

/** The repo's own variables, which a lane GreenMail sets (`test/setup/lane-greenmail.ts`). */
const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.OHMAIL_PHONE_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);
/* GreenMail runs with authentication disabled and makes the user at first login: a fixture
   constant, the sibling rig files' idiom. */
const PASS = "test";

const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

/** `node:sqlite` behind the phone's statement-runner contract, with a real yield in every call. */
function nodeExecutor(file: string): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(file);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...params) as Record<string, unknown>[];
        const rows = columns.length > 0
          ? objects.map((o) => columns.map((c) => o[c]))
          : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => { await yielded(); raw.prepare(sql).run(...params); });
    },
    async batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...params);
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
  };
}

/** The sibling rig files' dialect seam, for their reason: the ingest path still carries raw pg. */
function dialectSeam(exec: PhoneSqlExecutor): PhoneSqlExecutor {
  const rules: [RegExp, (...a: string[]) => string][] = [
    [/(^|[^A-Za-z0-9_.])now\(\)/gi, (_m, pre) => `${pre}CAST(unixepoch('subsec')*1000 AS INTEGER)`],
    [/::\s*(timestamptz|timestamp|uuid|text|jsonb|json|int|integer|bigint|numeric|boolean|date)\b/gi, () => ""],
    [/\bgreatest\s*\(/gi, () => "max("],
    [/\bleast\s*\(/gi, () => "min("],
    [/\s+for\s+update(\s+skip\s+locked)?/gi, () => ""],
  ];
  const rewrite = (sql: string): string => {
    let out = String(sql);
    for (const [re, to] of rules) {
      re.lastIndex = 0;
      out = out.replace(re, to as (substring: string, ...args: unknown[]) => string);
    }
    return out;
  };
  return {
    all: (sql, params) => exec.all(rewrite(sql), params),
    run: (sql, params) => exec.run(rewrite(sql), params),
    batch: (st) => exec.batch(st.map((q) => ({ sql: rewrite(q.sql), params: q.params }))),
    close: () => exec.close(),
  };
}

interface Line { event: string; detail: Record<string, unknown> }
interface Phone { engine: PhoneEngine; lines: Line[]; exec: PhoneSqlExecutor }

const open: PhoneEngine[] = [];
const dirs: string[] = [];

/**
 * The phone's `main()`, from a FRESH module graph when asked: the worker's visit remembers per
 * process which mailboxes its one-time repairs are done for, and an app restart is a new process.
 */
async function bootPhone(o: { user: string; file: string; installId: string; freshProcess?: boolean }): Promise<Phone> {
  if (o.freshProcess === true) vi.resetModules();
  const { startPhoneEngine } = await import("../src/mobile.js");
  const lines: Line[] = [];
  const exec = dialectSeam(nodeExecutor(o.file));
  const engine = await startPhoneEngine({
    exec,
    imap: {
      host: HOST, port: PORT, secure: false,
      auth: { user: o.user, pass: PASS },
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
    },
    // What the app's standalone door passes: the address IS the login (`standalone-door.ts`).
    address: o.user,
    machineName: "the phone reading its own mail",
    installId: o.installId,
    keks: { 1: "c".repeat(64) },
    log: (event, detail) => { lines.push({ event, detail }); },
  });
  open.push(engine);
  return { engine, lines, exec };
}

function seedMailboxId(p: Phone): string {
  const ids = Object.keys(p.engine.runtimes().organizer);
  expect(ids, "the composition seeds exactly one mailbox from its config").toHaveLength(1);
  return ids[0]!;
}

async function organize(p: Phone, mailboxId: string): Promise<void> {
  /* The person's Connect, with their marker as the app sends it. */
  const res = await p.engine.handle(new Request(`http://sidecar/local/mailboxes/${mailboxId}/organize`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.engine.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ consent: "person" }),
  }));
  expect(res.status).toBe(200);
}

/** A client this engine knows nothing about, straight to the server. */
async function withServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: PASS }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => undefined); }
}

/** A letter delivered into INBOX as the server would, from `from`. */
async function deliver(user: string, from: string, subject: string): Promise<void> {
  const raw = [
    `From: ${from}`, `To: ${user}`, `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@own-mail.example>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", `The body of ${subject}.`, "",
  ].join("\r\n");
  await withServer(user, (c) => c.append("INBOX", Buffer.from(raw, "utf8")));
}

/** Which server folder holds the letter with this subject, or `null` when none does. */
async function folderOnServer(user: string, subject: string): Promise<string | null> {
  return withServer(user, async (c) => {
    for (const box of await c.list()) {
      if (box.flags.has("\\Noselect")) continue;
      const lock = await c.getMailboxLock(box.path);
      try {
        const hits = await c.search({ header: { subject } }, { uid: true });
        if (Array.isArray(hits) && hits.length > 0) return box.path.replace(/\./g, "/");
      } finally { lock.release(); }
    }
    return null;
  });
}

/** The organizer's own record of the letter. */
async function rowOf(p: Phone, subject: string): Promise<Record<string, unknown> | null> {
  const r = await p.exec.all(
    "select m.id, fs.desired_folder, fs.observed_folder, fs.last_set_by "
      + "from messages m join folder_state fs on fs.message_id = m.id where m.subject = ?",
    [subject],
  );
  const first = r.rows[0];
  return first === undefined ? null : Object.fromEntries(r.columns.map((c, i) => [c, first[i]]));
}

/** Wait until the engine has this letter, pressing a pass rather than waiting out the backoff. */
async function untilIngested(p: Phone, subject: string, deadlineMs = 120_000): Promise<Record<string, unknown> | null> {
  const t0 = Date.now();
  for (;;) {
    await p.engine.resume();
    const row = await rowOf(p, subject);
    if (row !== null || Date.now() - t0 >= deadlineMs) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Passes until the letter is in `folder` on the server, or the deadline; the folder it is in. */
async function untilOnServer(p: Phone, user: string, subject: string, folder: string, deadlineMs = 120_000): Promise<string | null> {
  const t0 = Date.now();
  for (;;) {
    await p.engine.resume();
    const at = await folderOnServer(user, subject);
    if (at === folder || Date.now() - t0 >= deadlineMs) return at;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function untilLine(p: Phone, event: string, deadlineMs: number): Promise<Line | null> {
  const t0 = Date.now();
  for (;;) {
    const hit = p.lines.find((l) => l.event === event);
    if (hit !== undefined || Date.now() - t0 >= deadlineMs) return hit ?? null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function events(p: Phone): string {
  return [...new Set(p.lines.map((l) => l.event))].join(", ");
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-own-mail-"));
  dirs.push(dir);
  return join(dir, "engine.db");
}

/** A synthetic mailbox this phone organizes, and the phone, holding the lease. */
async function organizingPhone(): Promise<{ phone: Phone; user: string; mailboxId: string; file: string; installId: string }> {
  const user = `own-mail-${randomUUID()}@trafficflow.test`;
  await withServer(user, async () => undefined);
  const file = storeFile();
  const installId = `install-${randomUUID()}`;
  const phone = await bootPhone({ user, file, installId });
  const mailboxId = seedMailboxId(phone);
  await organize(phone, mailboxId);
  const promoted = await untilLine(phone, "organizer_row_promoted", 120_000);
  expect(promoted, `the phone never took the mailbox — events ${events(phone)}`).not.toBeNull();
  return { phone, user, mailboxId, file, installId };
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE && !SERVER_UP)("the mail server this file measures against", () => {
  it(`is NOT answering on ${HOST}:${PORT} — the cases below measured nothing in this run`, () => {
    expect(SERVER_UP, "the probe says the server answers, so these cases should have RUN").toBe(false);
  });
});

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a phone organizing its own mailbox, with mail from its own address", () => {
  it("keeps a letter from the mailbox's own address in INBOX while a stranger's goes to the Screener", async () => {
    const { phone, user } = await organizingPhone();
    const own = `from myself ${randomUUID()}`;
    const stranger = `from a stranger ${randomUUID()}`;
    // The own address as another mail program writes it: a display name, and not in lower case.
    await deliver(user, `Me <${user.toUpperCase()}>`, own);
    await deliver(user, "first.contact@stranger.example", stranger);
    for (const s of [own, stranger]) {
      expect(await untilIngested(phone, s), `never ingested — events ${events(phone)}`).not.toBeNull();
    }
    // THE CONTROL first: the gate is live on this phone.
    expect(await untilOnServer(phone, user, stranger, "ohmail/Screener"), `row ${JSON.stringify(await rowOf(phone, stranger))}`)
      .toBe("ohmail/Screener");
    await phone.engine.resume();
    expect(await folderOnServer(user, own), `row ${JSON.stringify(await rowOf(phone, own))}`).toBe("INBOX");
    expect((await rowOf(phone, own))?.desired_folder, "the organizer never desired it at the gate").toBe("INBOX");
  }, 600_000);

  it("own mail an earlier phone filed at the gate goes back to INBOX when the app starts again", async () => {
    const { phone, user, file, installId } = await organizingPhone();
    const own = `filed at the gate earlier ${randomUUID()}`;
    await deliver(user, user, own);
    const row = await untilIngested(phone, own);
    expect(row, `never ingested — events ${events(phone)}`).not.toBeNull();
    /* THE STATE A PHONE BEFORE THE ROUTER'S OWN-ADDRESS ARM LEFT: the organizer desired the letter
       into the Screener and its reconcile moved it there. Written as that router wrote it; the move
       is this engine's own reconcile, read back on the server. */
    await phone.exec.run(
      "update folder_state set desired_folder = 'ohmail/Screener', last_set_by = 'us', "
        + "reconcile_status = 'pending', next_attempt_at = null where message_id = ?",
      [row!.id],
    );
    expect(await untilOnServer(phone, user, own, "ohmail/Screener"), `row ${JSON.stringify(await rowOf(phone, own))}`)
      .toBe("ohmail/Screener");
    expect(await rowOf(phone, own)).toMatchObject({
      desired_folder: "ohmail/Screener", observed_folder: "ohmail/Screener", last_set_by: "us",
    });
    await open.pop()!.stop();

    // THE APP STARTS AGAIN over the same store: a new process, the same install and mailbox.
    const again = await bootPhone({ user, file, installId, freshProcess: true });
    expect(await untilOnServer(again, user, own, "INBOX"), `row ${JSON.stringify(await rowOf(again, own))} — events ${events(again)}`)
      .toBe("INBOX");
    expect(again.lines.find((l) => l.event === "own_mail_released")?.detail.released, "the release said what it did").toBe(1);
    expect((await rowOf(again, own))?.desired_folder).toBe("INBOX");
  }, 600_000);

  it("own mail ANOTHER organizer left in the Screener before this phone took the mailbox", async () => {
    const user = `own-mail-${randomUUID()}@trafficflow.test`;
    const own = `left at the gate by another organizer ${randomUUID()}`;
    await deliver(user, user, own);
    await withServer(user, async (c) => {
      await c.mailboxCreate(["ohmail", "Screener"]).catch(() => undefined);
      const lock = await c.getMailboxLock("INBOX");
      try { await c.messageMove({ header: { subject: own } }, "ohmail.Screener", { uid: false }); } finally { lock.release(); }
    });
    expect(await folderOnServer(user, own)).toBe("ohmail/Screener");
    const phone = await bootPhone({ user, file: storeFile(), installId: `install-${randomUUID()}` });
    await organize(phone, seedMailboxId(phone));
    expect(await untilIngested(phone, own), `never ingested — events ${events(phone)}`).not.toBeNull();
    const at = await untilOnServer(phone, user, own, "INBOX", 60_000);
    expect(at, `row ${JSON.stringify(await rowOf(phone, own))} — events ${events(phone)}`).toBe("INBOX");
  }, 600_000);
});
