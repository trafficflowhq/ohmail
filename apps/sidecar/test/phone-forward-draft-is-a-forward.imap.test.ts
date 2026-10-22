/**
 * A FORWARD KEPT AS A DRAFT ON THE PHONE IS SENT AS A FORWARD — the real phone engine
 * (`_phone-offline-rig.ts`) with the app's own client over its door. An original carrying an
 * attachment arrives; the reader opens it and keeps a forward as a draft; the app is closed and
 * relaunched, the draft is reopened by the composer's own reading of it, and sent. The verdict is
 * the recipient's mailbox on the lane GreenMail: one copy, the original quoted, its attachment
 * with it, and one draft row on the phone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDraft, SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";
import type { MessageStructureObject } from "imapflow";
import {
  Cable, EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, PORT, SMTP_PORT,
  bootPhone, cables, dirs, eventsSince, open, post, seedMailboxId, untilIngested, withServer, type Phone,
} from "./_phone-offline-rig.js";
import { serviceUp } from "@trafficflow/db/testing";
import { bootEngine, LOCAL_ENGINE_ORIGIN } from "../../mobile/src/engine/boot.js";
import { installNetworkReader, networkNow } from "../../mobile/src/net/network-door.js";
import { draftEditOf, flushQueued, liveActions } from "../../mobile/src/state/live.js";
import { sayArg } from "../../mobile/src/refusal.js";

/** The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const NOTE = "the attached note";

function mirrorExecutor(file: string): SqlExecutor & { close(): void } {
  const db = new sqlite.DatabaseSync(file);
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    },
    close: () => { try { db.close(); } catch { /* already closed */ } },
  };
}

afterEach(async () => {
  installNetworkReader(null);
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (cables.length > 0) await cables.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A stranger's letter with one attachment, delivered into INBOX as the server would. */
async function deliverWithAttachment(user: string, subject: string): Promise<void> {
  const raw = [
    "From: Stranger <stranger@stranger.example>", `To: ${user}`, `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@stranger.example>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b-fwd"', "",
    "--b-fwd", "Content-Type: text/plain; charset=utf-8", "", `The body of ${subject}.`, "",
    "--b-fwd", 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"',
    "Content-Transfer-Encoding: base64", "", Buffer.from(NOTE, "utf8").toString("base64"), "",
    "--b-fwd--", "",
  ].join("\r\n");
  await withServer(user, (c) => c.append("INBOX", Buffer.from(raw, "utf8")));
}

/** Every part of a structure, nested ones included — a reader taking the root's children misses them. */
function partsOf(node: MessageStructureObject): MessageStructureObject[] {
  return [node, ...(node.childNodes ?? []).flatMap(partsOf)];
}

/** A part's bytes by the encoding BODYSTRUCTURE declares, which GreenMail gives where a nested part's MIME header is absent. */
function decoded(raw: Buffer, encoding: string | undefined): string {
  const e = (encoding ?? "").toLowerCase();
  if (e === "base64") return Buffer.from(raw.toString("latin1").replace(/\s+/g, ""), "base64").toString("utf8");
  if (e === "quoted-printable") {
    const bytes = raw.toString("latin1").replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return raw.toString("utf8");
}

/** What reached the recipient under this subject: its count, the attachment names, the plain text. */
async function received(recipient: string, subject: string): Promise<{ n: number; files: string[]; text: string }> {
  return withServer(recipient, async (c) => {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const hits = await c.search({ header: { subject } }, { uid: true });
      const uids = Array.isArray(hits) ? hits : [];
      if (uids.length !== 1) return { n: uids.length, files: [], text: "" };
      const uid = String(uids[0]);
      const msg = await c.fetchOne(uid, { bodyStructure: true }, { uid: true });
      if (!msg || !msg.bodyStructure) return { n: 1, files: [], text: "" };
      const parts = partsOf(msg.bodyStructure);
      const isFile = (p: MessageStructureObject): boolean =>
        p.disposition === "attachment" || p.dispositionParameters?.filename !== undefined;
      const files = parts.filter(isFile).map((p) => p.dispositionParameters?.filename ?? p.parameters?.name ?? "");
      let text = "";
      for (const p of parts.filter((q) => q.type === "text/plain" && !isFile(q))) {
        const key = p.part ?? "1";
        const got = await c.fetchOne(uid, { bodyParts: [key] }, { uid: true });
        const raw = got ? got.bodyParts?.get(key) : undefined;
        if (raw) text += decoded(raw, p.encoding);
      }
      return { n: 1, files, text };
    } finally { lock.release(); }
  });
}

async function draftsIn(p: Phone, subject: string): Promise<Array<{ id: string; forwardOf: unknown }>> {
  const r = await p.exec.all("select id, forward_of_message_id from drafts where subject = ?", [subject]);
  return r.rows.map((row) => ({ id: String(row[0]), forwardOf: row[1] }));
}

async function appOver(phone: Phone, mirrorFile: string) {
  const uuid = (): string => randomUUID();
  const mirrors: Array<{ close(): void }> = [];
  const boot = await bootEngine(
    { openExecutor: () => { const m = mirrorExecutor(mirrorFile); mirrors.push(m); return m; }, deleteDatabase: async () => undefined, uuid },
    { origin: LOCAL_ENGINE_ORIGIN, accountId: phone.engine.accountId, localEngine: phone.engine, network: networkNow },
  );
  if (boot.kind !== "ready") throw new Error("the app's client did not boot over the engine's door");
  await boot.engine.start();
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  const close = (): void => { boot.store.close(); for (const m of mirrors) m.close(); };
  return { boot, actions, toasts, close };
}

/** Sync until the app's read model holds this entity, or the bound passes. */
async function untilRead(app: Awaited<ReturnType<typeof appOver>>, type: "message" | "draft", id: string, deadlineMs: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    await app.boot.engine.syncOnce().catch(() => undefined);
    if (app.boot.engine.read().get(type, id)) return true;
    if (Date.now() - t0 >= deadlineMs) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE && !SERVER_UP)("the mail server this file measures against", () => {
  it(`is NOT answering on ${HOST}:${PORT} — the cases below measured nothing in this run`, () => {
    expect(SERVER_UP, "the probe says the server answers, so the cases should have RUN").toBe(false);
  });
});

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a forward kept on the phone is sent as a forward", () => {
  it("kept, closed, reopened and sent: one copy with the original and its attachment, one row", async () => {
    const user = `forwarder-${randomUUID()}@trafficflow.test`;
    const imap = new Cable("reset");
    await imap.open();
    cables.push(imap);
    const smtp = new Cable("reset", { host: HOST, port: SMTP_PORT });
    await smtp.open();
    cables.push(smtp);
    const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-forward-draft-"));
    dirs.push(dir);
    const phone = await bootPhone({ user, file: join(dir, "engine.db"), cable: imap, smtp });
    expect(await post(phone, `/local/mailboxes/${seedMailboxId(phone)}/organize`)).toBe(200);

    const subject = `forwarded ${randomUUID()}`;
    await deliverWithAttachment(user, subject);
    expect(await untilIngested(phone, subject, 90_000), `the original never reached the phone — events ${eventsSince(phone, 0)}`).not.toBeNull();
    const [orig] = (await phone.exec.all("select id from messages where subject = ?", [subject])).rows;
    const originalId = String(orig![0]);

    // The reader opens the original and keeps a forward of it as a draft.
    const mirrorFile = join(dir, "mirror.db");
    const first = await appOver(phone, mirrorFile);
    expect(await untilRead(first, "message", originalId, 60_000), "the app never read the original").toBe(true);
    await first.boot.engine.hydrateBody(originalId);
    const recipient = `recipient-${randomUUID()}@trafficflow.test`;
    const to = [{ name: "R", address: recipient }];
    const kept = await first.actions.draftKeep({
      mode: "forward", messageId: originalId, mailboxId: null, to, subject: "", body: "For your records.", files: 0, quiet: true,
    });
    expect(kept, `the keep was refused — toasts ${first.toasts.join(" | ")}`).toBe("kept");
    const fwdSubject = `Fwd: ${subject}`;
    let rows: Array<{ id: string; forwardOf: unknown }> = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await first.boot.engine.syncOnce().catch(() => undefined);
      rows = await draftsIn(phone, fwdSubject);
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 250));
    }
    expect(rows, "the kept forward is not one row on the phone").toHaveLength(1);
    expect(rows[0]!.forwardOf, "the kept forward names no original").toBe(originalId);

    // Closed and relaunched: the composer opens the draft by its own reading of the row.
    first.close();
    const second = await appOver(phone, mirrorFile);
    expect(await untilRead(second, "draft", rows[0]!.id, 60_000), "the relaunched app never read the draft").toBe(true);
    const edit = draftEditOf(second.boot.engine.read().get<EngineDraft>("draft", rows[0]!.id)!);
    expect(edit?.forwardOf, "the reopened draft opens as a new mail, not as a forward").toBe(originalId);
    expect(await untilRead(second, "message", originalId, 60_000), "the relaunched app lost the original").toBe(true);

    const res = await second.actions.sendForward(edit!.forwardOf!, to, "For your records.", null, [], false, false, rows[0]!.id);
    if (res.outcome === "queued") {
      const settled = await flushQueued(second.boot.engine, second.actions.releaseConfirmed);
      expect(settled.get(res.key!)?.status, `the forward did not go — events ${eventsSince(phone, 0)}`).toBe("confirmed");
    } else {
      expect(res.outcome, `the forward did not go — toasts ${second.toasts.join(" | ")}`).toBe("sent");
    }

    let got = await received(recipient, fwdSubject);
    for (let i = 0; i < 40 && got.n === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      got = await received(recipient, fwdSubject);
    }
    expect(got.n, "not exactly one copy reached the recipient").toBe(1);
    expect(got.files, "the original's attachment did not go with the forward").toEqual(["note.txt"]);
    expect(got.text, "the forward does not quote the original").toContain(`The body of ${subject}.`);
    expect((await draftsIn(phone, fwdSubject)).length, "the send wrote a second row beside the kept one").toBe(1);
    second.close();
  }, 300_000);
});
