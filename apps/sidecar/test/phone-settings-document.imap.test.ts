/**
 * A PHONE ORGANIZING A MAILBOX THAT CARRIES ANOTHER OHMAIL'S SETTINGS DOCUMENT.
 *
 * `startPhoneEngine` over `node:sqlite`, against a real IMAP server, with a settings document
 * another install saved in `ohmail/_meta` before this phone connected. While that document's
 * import question is open the gate adopts the arrival folder of the senders it lets through, and
 * write-behind holds, so the phone's decisions reach nothing on the server. The verdicts are read on the server by a
 * client this engine knows nothing about. Runs under the sqlite project; the default one states
 * the premise.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { META_FOLDER } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import {
  startPhoneEngine,
  type PhoneEngine,
  type PhoneSqlExecutor,
  type PhoneSqlRows,
} from "../src/mobile.js";
/* THE PHONE'S OWN HALF — the seam its card presses through and the card's choice of question. */
import {
  answerProfileImport, readProfileImport, type ProfileImportSession,
} from "../../mobile/src/net/profile-import.js";
import { cardQuestion, savedRows } from "../../mobile/src/ui/profile-import-card.js";
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
/* GreenMail runs with authentication disabled and makes the user at first login, so this is a
   fixture constant rather than a credential — the sibling rig files' idiom. */
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
interface Phone { engine: PhoneEngine; lines: Line[]; exec: PhoneSqlExecutor; installId: string }

const open: PhoneEngine[] = [];
const dirs: string[] = [];

/** `installId`: the install generation a phone keeps across Stop and remove (a fresh one by default). */
async function bootPhone(o: { user: string; file: string; flushMs: number; installId?: string }): Promise<Phone> {
  const lines: Line[] = [];
  const installId = o.installId ?? `install-${randomUUID()}`;
  const exec = dialectSeam(nodeExecutor(o.file));
  const engine = await startPhoneEngine({
    exec,
    imap: {
      host: HOST, port: PORT, secure: false,
      auth: { user: o.user, pass: PASS },
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
      sentDomain: "trafficflow.test",
    },
    machineName: "the phone with a settings document",
    installId,
    keks: { 1: "b".repeat(64) },
    profileFlushIntervalMs: o.flushMs,
    log: (event, detail) => { lines.push({ event, detail }); },
  });
  open.push(engine);
  return { engine, lines, exec, installId };
}

function seedMailboxId(p: Phone): string {
  const ids = Object.keys(p.engine.runtimes().organizer);
  expect(ids, "the composition seeds exactly one mailbox from its config").toHaveLength(1);
  return ids[0]!;
}

/** One request on the engine's own door, as the app's client makes it. */
async function call(p: Phone, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await p.engine.handle(new Request(`http://sidecar${path}`, {
    method,
    headers: {
      authorization: `Bearer ${p.engine.sessionToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

/** A client this engine knows nothing about, straight to the server. */
async function withServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: PASS }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => undefined); }
}

/** GreenMail's delimiter is `.`, so the canonical `ohmail/_meta` is `ohmail._meta`. */
const META_PATH = META_FOLDER.split("/").join(".");

/**
 * What another ohmail left in this mailbox: one sender screened in, one rule, one tag — or, with
 * `v`, a document from a newer ohmail this build cannot read.
 */
const OTHER_INSTALL = "install-the-desktop-before";
async function plantOtherInstallsDocument(user: string, v?: number): Promise<void> {
  const doc = makeProfileDoc({
    screener: [{ address: "anna@elsewhere.test", name: "Anna" }],
    rules: [{
      kind: "sender", match: "news@elsewhere.test", destination: "ohmail/Screened",
      priority: 0, enabled: true, provenance: "promoted",
    }],
    notifyRules: [],
    awayResponder: null,
    tagNames: ["Invoices"],
    signature: null,
  }, { updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000), producer: { kind: "local", version: "0.25.1" } });
  const written = v === undefined ? doc : { ...doc, v };
  await withServer(user, async (c) => {
    await c.mailboxCreate(["ohmail", "_meta"]).catch(() => undefined);
    await c.append(META_PATH, Buffer.from(formatProfileMessage(written, { installId: OTHER_INSTALL }), "utf8"));
  });
}

interface DocOnServer { installId: string | null; rules: string[]; tagNames: string[] }

/** The settings documents in `ohmail/_meta`, read by an INDEPENDENT client. */
async function documentsOnServer(user: string): Promise<DocOnServer[]> {
  return withServer(user, async (c) => {
    if (!(await c.list()).some((b) => b.path === META_PATH)) return [];
    const lock = await c.getMailboxLock(META_PATH);
    const out: DocOnServer[] = [];
    try {
      for await (const m of c.fetch("1:*", { uid: true, source: true })) {
        const r = m.source ? parseProfileMessage(m.source.toString("utf8")) : null;
        /* A newer-format document parses with no readable body; it is still a document. */
        if (r && !isMalformedProfile(r)) {
          out.push({
            installId: r.installId,
            rules: (r.doc?.rules ?? []).map((x) => `${x.match}>${x.destination}`),
            tagNames: r.doc?.tagNames ?? [],
          });
        }
      }
    } finally { lock.release(); }
    return out;
  });
}

/** A stranger's letter, delivered into INBOX as the server would. */
async function deliver(user: string, from: string, subject: string): Promise<void> {
  const raw = [
    `From: ${from}`, `To: ${user}`, `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@stranger.example>`, `Date: ${new Date().toUTCString()}`,
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
    "select fs.desired_folder, fs.observed_folder, fs.last_set_by "
      + "from messages m join folder_state fs on fs.message_id = m.id where m.subject = ?",
    [subject],
  );
  const first = r.rows[0];
  return first === undefined ? null : Object.fromEntries(r.columns.map((c, i) => [c, first[i]]));
}

/**
 * Wait until the engine has this letter, pressing a pass rather than waiting out the idle
 * backoff (120 s at its ceiling): the pass is the unit every verdict here is counted in.
 */
async function untilIngested(p: Phone, subject: string, deadlineMs = 120_000): Promise<Record<string, unknown> | null> {
  const t0 = Date.now();
  for (;;) {
    await p.engine.resume();
    const row = await rowOf(p, subject);
    if (row !== null || Date.now() - t0 >= deadlineMs) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Where the letter is on the server after ONE more pass than the one that ingested it. */
async function afterOnePass(p: Phone, user: string, subject: string): Promise<string | null> {
  await p.engine.resume();
  return folderOnServer(user, subject);
}

async function untilLine(p: Phone, event: string, match: (d: Record<string, unknown>) => boolean, deadlineMs: number): Promise<Line | null> {
  const t0 = Date.now();
  for (;;) {
    const hit = p.lines.find((l) => l.event === event && match(l.detail));
    if (hit !== undefined || Date.now() - t0 >= deadlineMs) return hit ?? null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function events(p: Phone, from = 0): string {
  return [...new Set(p.lines.slice(from).map((l) => l.event))].join(", ");
}

/**
 * THE APP'S SESSION ON THIS DOOR — `pairing.ts` builds it from `localEngineTransport(door)`: the
 * engine's `handle`, this launch's bearer on every request, the fixed local origin.
 */
function phoneSession(p: Phone): ProfileImportSession {
  return {
    profile: { origin: "http://sidecar", apiBase: null },
    fetch: (url, init) => {
      const given = (init ?? {}) as RequestInit;
      return p.engine.handle(new Request(url, {
        ...given,
        headers: {
          ...Object.fromEntries(new Headers(given.headers).entries()),
          authorization: `Bearer ${p.engine.sessionToken}`,
        },
      }));
    },
  };
}

/** A sender rule made on the phone — a Screener decision's store half, through the phone's door. */
async function decide(p: Phone, sender: string, destination: string): Promise<void> {
  const made = await call(p, "POST", "/rules", { kind: "sender", match: sender, destination });
  expect([201, 202], JSON.stringify(made.json)).toContain(made.status);
}

/** Two ordinary passes — the organizer's write-behind runs at the tail of each. */
async function twoPasses(p: Phone): Promise<void> {
  await p.engine.resume();
  await p.engine.resume();
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-settings-doc-"));
  dirs.push(dir);
  return dir;
}

/**
 * The finding's setup: a mailbox carrying another install's document (or none), organized by this
 * phone, and the question as the phone's own seam reads it.
 */
async function organizingPhone(o: { planted: "doc" | "newer" | "none"; flushMs: number }): Promise<{
  phone: Phone; user: string; mailboxId: string; session: ProfileImportSession;
}> {
  const user = `settings-doc-${randomUUID()}@trafficflow.test`;
  if (o.planted === "doc") await plantOtherInstallsDocument(user);
  if (o.planted === "newer") await plantOtherInstallsDocument(user, 99);
  else if (o.planted === "none") await withServer(user, async () => undefined);
  const phone = await bootPhone({ user, file: join(storeDir(), "engine.db"), flushMs: o.flushMs });
  const mailboxId = seedMailboxId(phone);
  expect((await call(phone, "POST", `/local/mailboxes/${mailboxId}/organize`, { consent: "person" })).status).toBe(200);
  if (o.planted !== "none") {
    const state = o.planted === "doc" ? "found" : "newer";
    const found = await untilLine(phone, "organizer_profile_detected", (d) => d.state === state, 120_000);
    expect(found, `the phone never met the other install's document — events ${events(phone)}`).not.toBeNull();
  } else {
    const promoted = await untilLine(phone, "organizer_row_promoted", () => true, 120_000);
    expect(promoted, `the phone never took the mailbox — events ${events(phone)}`).not.toBeNull();
  }
  return { phone, user, mailboxId, session: phoneSession(phone) };
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

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a phone organizing a mailbox with another ohmail's settings document", () => {
  it("Not now on the phone's card files the next stranger in the Screener; Save puts the phone's decisions in the mailbox", async () => {
    const { phone, user, mailboxId, session } = await organizingPhone({ planted: "doc", flushMs: 0 });

    // THE QUESTION, read by the phone's own seam, and the card takes it.
    const q = await readProfileImport(session, mailboxId);
    expect(q).toMatchObject({ state: "found", counts: { screener: 1, rules: 1, tags: 1 } });
    const card = cardQuestion([{ mailboxId, address: user, question: q! }]);
    expect(card?.mailboxId, "the card offers the question").toBe(mailboxId);
    const fingerprint = (q as { fingerprint: string }).fingerprint;

    // UNANSWERED: a stranger the document does not name is at the gate, and the phone's decision
    // reaches the mailbox in the phone's own document, beside the other install's.
    const s1 = `stranger one ${randomUUID()}`;
    await deliver(user, "first.contact.one@stranger.example", s1);
    expect(await untilIngested(phone, s1), `never ingested — events ${events(phone)}`).not.toBeNull();
    expect(await afterOnePass(phone, user, s1)).toBe("ohmail/Screener");
    await decide(phone, "first.contact.one@stranger.example", "ohmail/Screened");
    await twoPasses(phone);
    expect((await documentsOnServer(user)).map((d) => d.installId).sort()).toEqual([OTHER_INSTALL, phone.installId].sort());

    // NOT NOW, pressed through the phone's seam: the next stranger is filed on the server.
    expect(await answerProfileImport(session, mailboxId, "notNow", { fingerprint })).toMatchObject({ kind: "done" });
    const after = await readProfileImport(session, mailboxId);
    expect(savedRows([{ mailboxId, address: user, question: after! }]).map((r) => r.mailboxId),
      "Settings lists the declined document").toEqual([mailboxId]);
    const s2 = `stranger two ${randomUUID()}`;
    await deliver(user, "first.contact.two@stranger.example", s2);
    expect(await untilIngested(phone, s2), `never ingested — events ${events(phone)}`).not.toBeNull();
    expect(await afterOnePass(phone, user, s2), `row ${JSON.stringify(await rowOf(phone, s2))}`).toBe("ohmail/Screener");
    // The letter filed at the gate while the question was open follows the phone's rule for it once
    // the question closes: the rule asked for its past mail, and this door's pass moves it.
    expect(await folderOnServer(user, s1)).toBe("ohmail/Screened");

    // The mailbox keeps the other install's document after Not now, beside the phone's…
    await twoPasses(phone);
    expect((await documentsOnServer(user)).map((d) => d.installId).sort()).toEqual([OTHER_INSTALL, phone.installId].sort());

    // …until SAVE: the phone's settings stand alone, the phone's decision with them.
    expect(await answerProfileImport(session, mailboxId, "save", { fingerprint })).toMatchObject({ kind: "done" });
    await twoPasses(phone);
    const saved = await documentsOnServer(user);
    expect(saved.map((d) => d.installId), `events ${events(phone)}`).toEqual([phone.installId]);
    expect(saved[0]!.rules).toContain("first.contact.one@stranger.example>ohmail/Screened");
  }, 600_000);

  it("unanswered: an unnamed stranger is at the gate and the named sender stays in INBOX; Import files the screened-out sender's held letter", async () => {
    const { phone, user, mailboxId, session } = await organizingPhone({ planted: "doc", flushMs: 0 });
    const named = `named ${randomUUID()}`;
    const unnamed = `unnamed ${randomUUID()}`;
    const denied = `denied ${randomUUID()}`;
    await deliver(user, "anna@elsewhere.test", named);
    await deliver(user, "first.contact.four@stranger.example", unnamed);
    await deliver(user, "news@elsewhere.test", denied);
    for (const s of [named, unnamed, denied]) {
      expect(await untilIngested(phone, s), `never ingested — events ${events(phone)}`).not.toBeNull();
    }
    expect(await afterOnePass(phone, user, unnamed), "a stranger to the document stayed past the gate").toBe("ohmail/Screener");
    expect((await rowOf(phone, unnamed))?.last_set_by).toBe("us");
    expect(await folderOnServer(user, named), "the document's own sender was screened").toBe("INBOX");
    expect((await rowOf(phone, named))?.last_set_by).toBe("external");
    expect(await folderOnServer(user, denied)).toBe("ohmail/Screener");

    // IMPORT: the document's screen-out reaches the letter this phone held at the gate for it.
    const q = await readProfileImport(session, mailboxId);
    const imported = await answerProfileImport(session, mailboxId, "import", { fingerprint: (q as { fingerprint: string }).fingerprint });
    expect(imported, JSON.stringify(imported)).toMatchObject({ kind: "done" });
    expect(await afterOnePass(phone, user, denied), `row ${JSON.stringify(await rowOf(phone, denied))}`).toBe("ohmail/Screened");
    expect(await folderOnServer(user, named)).toBe("INBOX");
    expect(await folderOnServer(user, unnamed)).toBe("ohmail/Screener");
  }, 600_000);

  it("Import on the phone's card merges the other install's settings and the phone's decision reaches the mailbox", async () => {
    const { phone, user, mailboxId, session } = await organizingPhone({ planted: "doc", flushMs: 0 });
    const q = await readProfileImport(session, mailboxId);
    expect(q?.state).toBe("found");
    await decide(phone, "first.contact.three@stranger.example", "ohmail/Screened");
    const imported = await answerProfileImport(session, mailboxId, "import", { fingerprint: (q as { fingerprint: string }).fingerprint });
    expect(imported, JSON.stringify(imported)).toMatchObject({ kind: "done", imported: { screener: 1, rules: 1, tags: 1 } });
    await twoPasses(phone);
    const docs = await documentsOnServer(user);
    expect(docs.map((d) => d.installId), `events ${events(phone)}`).toEqual([phone.installId]);
    expect(docs[0]!.rules).toEqual(expect.arrayContaining([
      "news@elsewhere.test>ohmail/Screened", "first.contact.three@stranger.example>ohmail/Screened",
    ]));
    expect(docs[0]!.tagNames).toContain("Invoices");
    expect(await readProfileImport(session, mailboxId)).toEqual({ state: "none" });
  }, 600_000);

  it("a settings document from a newer ohmail: Not now still lets the phone file strangers", async () => {
    const { phone, user, mailboxId, session } = await organizingPhone({ planted: "newer", flushMs: 0 });
    const q = await readProfileImport(session, mailboxId);
    expect(q).toEqual({ state: "newer", v: 99 });
    expect(cardQuestion([{ mailboxId, address: user, question: q! }])?.mailboxId).toBe(mailboxId);
    expect(await answerProfileImport(session, mailboxId, "notNow", { v: 99 })).toMatchObject({ kind: "done" });
    const s = `stranger newer ${randomUUID()}`;
    await deliver(user, "first.contact.newer@stranger.example", s);
    expect(await untilIngested(phone, s), `never ingested — events ${events(phone)}`).not.toBeNull();
    expect(await afterOnePass(phone, user, s), `row ${JSON.stringify(await rowOf(phone, s))}`).toBe("ohmail/Screener");
    // Never overwritten: this build cannot represent what that document holds.
    expect((await documentsOnServer(user)).map((d) => d.installId)).toEqual([OTHER_INSTALL]);
  }, 600_000);

  it("stopping on the phone writes the decisions made since the last settings write first", async () => {
    /* The debounce made long, so only the stop can be what writes: a decision made after the last
       write was left on the phone when the claim went. */
    const { phone, user, mailboxId } = await organizingPhone({ planted: "none", flushMs: 30 * 60 * 1000 });
    await twoPasses(phone);
    await decide(phone, "first.contact.four@stranger.example", "ohmail/Screened");
    await twoPasses(phone);
    expect(await phone.engine.stopOrganizing()).toBe("released");
    const docs = await documentsOnServer(user);
    expect(docs.map((d) => d.installId), `events ${events(phone)}`).toEqual([phone.installId]);
    expect(docs[0]!.rules).toContain("first.contact.four@stranger.example>ohmail/Screened");
    expect(phone.engine.runtimes().organizer[mailboxId]?.settingsLeft).toBe("saved");
    /* Saved to the mailbox is the ordinary case, and the route says nothing about it. */
    const reach = await call(phone, "GET", "/local/mailboxes/connections");
    const row = (reach.json?.items ?? []).find((i: { mailboxId?: string }) => i.mailboxId === mailboxId);
    expect(row, "the route answered no row for the mailbox").toBeDefined();
    expect(row?.settingsLeft).toBeUndefined();
  }, 600_000);

  it("handing the mailbox back on leaving the foreground writes them first too", async () => {
    const { phone, user, mailboxId } = await organizingPhone({ planted: "none", flushMs: 30 * 60 * 1000 });
    await twoPasses(phone);
    await decide(phone, "first.contact.six@stranger.example", "ohmail/Screened");
    const handed = await phone.engine.handBack();
    expect(handed.map((h) => h.released !== null && h.released > 0)).toEqual([true]);
    const docs = await documentsOnServer(user);
    expect(docs.map((d) => d.installId), `events ${events(phone)}`).toEqual([phone.installId]);
    expect(docs[0]!.rules).toContain("first.contact.six@stranger.example>ohmail/Screened");
    expect(phone.engine.runtimes().organizer[mailboxId]?.settingsLeft).toBe("saved");
  }, 600_000);

  it("stopping over a declined document keeps the other install's settings and saves the phone's beside them", async () => {
    const { phone, user, mailboxId, session } = await organizingPhone({ planted: "doc", flushMs: 0 });
    const q = await readProfileImport(session, mailboxId);
    await decide(phone, "first.contact.five@stranger.example", "ohmail/Screened");
    expect(await answerProfileImport(session, mailboxId, "notNow", { fingerprint: (q as { fingerprint: string }).fingerprint }))
      .toMatchObject({ kind: "done" });
    await twoPasses(phone);
    expect(await phone.engine.stopOrganizing()).toBe("released");
    const docs = await documentsOnServer(user);
    expect(docs.map((d) => d.installId).sort()).toEqual([OTHER_INSTALL, phone.installId].sort());
    expect(docs.find((d) => d.installId === phone.installId)?.rules ?? [])
      .toContain("first.contact.five@stranger.example>ohmail/Screened");
    expect(phone.engine.runtimes().organizer[mailboxId]?.settingsLeft).toBe("saved");
    /* Saved to the mailbox is the ordinary case, and the local door's route says nothing about it. */
    const reach = await call(phone, "GET", "/local/mailboxes/connections");
    const row = (reach.json?.items ?? []).find((i: { mailboxId?: string }) => i.mailboxId === mailboxId);
    expect(row?.settingsLeft).toBeUndefined();
  }, 600_000);

  /* STOP AND REMOVE, THEN CONNECT AGAIN: the store goes and the install generation stays, so the
     mailbox's settings carry this phone's own install id and predate its new store. A decision made
     before the card is answered stays on the phone, so a third connect still finds the first settings. */
  it("removed and connected again on a fresh store, twice, the phone keeps the first store's settings and asks", async () => {
    const user = `settings-doc-${randomUUID()}@trafficflow.test`;
    await withServer(user, async () => undefined);
    const installId = `install-${randomUUID()}`;
    const first = await bootPhone({ user, file: join(storeDir(), "engine.db"), flushMs: 0, installId });
    const firstId = seedMailboxId(first);
    expect((await call(first, "POST", `/local/mailboxes/${firstId}/organize`, { consent: "person" })).status).toBe(200);
    expect(await untilLine(first, "organizer_row_promoted", () => true, 120_000), `events ${events(first)}`).not.toBeNull();
    await decide(first, "anna@elsewhere.test", "INBOX");
    await decide(first, "news@elsewhere.test", "ohmail/Screened");
    await twoPasses(first);
    expect(await first.engine.stopOrganizing()).toBe("released");
    const left = ["anna@elsewhere.test>INBOX", "news@elsewhere.test>ohmail/Screened"];
    expect((await documentsOnServer(user)).map((d) => d.rules.sort()), "premise: the first store's settings are in the mailbox")
      .toEqual([left]);
    await first.engine.stop();
    open.splice(open.indexOf(first.engine), 1);

    const phone = await bootPhone({ user, file: join(storeDir(), "engine.db"), flushMs: 0, installId });
    const mailboxId = seedMailboxId(phone);
    expect((await call(phone, "POST", `/local/mailboxes/${mailboxId}/organize`, { consent: "person" })).status).toBe(200);
    await untilLine(phone, "organizer_profile_detected", () => true, 120_000);
    for (let i = 0; i < 3; i++) await twoPasses(phone);
    expect((await documentsOnServer(user)).map((d) => d.rules.sort()), `events ${events(phone)}`).toEqual([left]);
    expect((await readProfileImport(phoneSession(phone), mailboxId))?.state).toBe("found");
    // A sender the first store let in keeps the folder the mailbox has it in while the question is open.
    const named = `named ${randomUUID()}`;
    await deliver(user, "anna@elsewhere.test", named);
    expect(await untilIngested(phone, named), `never ingested — events ${events(phone)}`).not.toBeNull();
    expect(await afterOnePass(phone, user, named)).toBe("INBOX");

    await decide(phone, "carol@elsewhere.test", "INBOX");
    await twoPasses(phone);
    await phone.engine.stopOrganizing();
    const second = { docs: (await documentsOnServer(user)).map((d) => d.rules.sort()), left: phone.engine.runtimes().organizer[mailboxId]?.settingsLeft };
    await phone.engine.stop();
    open.splice(open.indexOf(phone.engine), 1);
    const third = await bootPhone({ user, file: join(storeDir(), "engine.db"), flushMs: 0, installId });
    const thirdId = seedMailboxId(third);
    expect((await call(third, "POST", `/local/mailboxes/${thirdId}/organize`, { consent: "person" })).status).toBe(200);
    await untilLine(third, "organizer_profile_detected", () => true, 120_000);
    for (let i = 0; i < 3; i++) await twoPasses(third);
    const again = `named again ${randomUUID()}`;
    await deliver(user, "anna@elsewhere.test", again);
    expect(await untilIngested(third, again), `never ingested — events ${events(third)}`).not.toBeNull();
    const asked = await readProfileImport(phoneSession(third), thirdId);
    expect({
      second, asked: asked?.state === "found" ? asked.counts.rules : asked?.state, anna: await afterOnePass(third, user, again),
    }, `events ${events(third)}`).toEqual({ second: { docs: [left], left: "not_saved" }, asked: 2, anna: "INBOX" });
  }, 600_000);
});
