import { readFileSync, readdirSync, statSync } from "node:fs";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * Every write that makes a mailbox the worker does not serve yet rings the doorbell
 * (`sync_requested_at`), so the worker's kick scan asks for a roster pass at once instead of the
 * next 30 s interval. Six doors, one helper: a create, an OAuth connect of a new address, an OAuth
 * reconnect, a re-enable, and the two lease presses, "Organize here" and "Hand the mailbox back",
 * which a served runtime's gate reads only after a roster pass. The census holds the six call sites
 * and refuses an INSERT into `mailboxes` in `packages/services/src` that does not ring it.
 */

const NOW = new Date("2026-09-27T06:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
const svc = makeMailboxService({ keyProvider: KP, allowance: async () => { /* unmetered here */ } });
const IMAP = { host: "imap.example", port: 993, secure: true, user: "u", pass: fixturePassword("mailbox-doorbell") };
const PROBE_OK = { probe: async () => ({ verdict: "ok" as const }) };
const OAUTH = {
  provider: "microsoft", tenant: "common", refreshToken: "refresh-fixture", accessToken: "access-fixture",
  imap: { host: "outlook.office365.example", port: 993, secure: true },
};

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seed(db: Db): Promise<ServiceContext> {
  const [a] = await db.insert(accounts).values({ name: "doorbell" }).returning();
  return { db, accountId: a!.id, userId: null, now: () => NOW, requestId: randomUUID() };
}

const stampOf = async (db: Db, id: string): Promise<Date | null> =>
  (await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, id)))[0]!.at;
const unstamp = (db: Db, id: string) =>
  db.update(mailboxes).set({ syncRequestedAt: null }).where(eq(mailboxes.id, id));

describe("the doors that make a mailbox the worker does not serve yet, or a press it must read, ring the doorbell", () => {
  it("a password create", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const dto = await svc.create(ctx, { provider: "imap", address: "new@trafficflow.test", imap: IMAP }, PROBE_OK);
    expect(await stampOf(db, dto.id)).not.toBeNull();
  });

  it("an OAuth connect of a new address, and its reconnect", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const first = await svc.connectOAuth(ctx, { provider: "outlook", address: "o@trafficflow.test", oauth: OAUTH }, PROBE_OK);
    expect(first.created).toBe(true);
    expect(await stampOf(db, first.mailbox.id)).not.toBeNull();
    await unstamp(db, first.mailbox.id);
    const again = await svc.connectOAuth(ctx, { provider: "outlook", address: "o@trafficflow.test", oauth: OAUTH }, PROBE_OK);
    expect(again.created).toBe(false);
    expect(await stampOf(db, again.mailbox.id), "the reconnect rang nothing").not.toBeNull();
  });

  it("a re-enable rings it, and an ordinary edit does not", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const dto = await svc.create(ctx, { provider: "imap", address: "back@trafficflow.test", imap: IMAP }, PROBE_OK);
    await svc.update(ctx, dto.id, { status: "disabled" }, PROBE_OK);
    await unstamp(db, dto.id);
    await svc.update(ctx, dto.id, { displayName: "Renamed" }, PROBE_OK);
    expect(await stampOf(db, dto.id), "an edit of a mailbox that stays disabled rang the doorbell").toBeNull();
    await svc.update(ctx, dto.id, { status: "connected", imap: IMAP }, PROBE_OK);
    expect(await stampOf(db, dto.id), "the re-enable rang nothing").not.toBeNull();
  });

  it("Organize here rings it on the press, and an answer that writes no press does not", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const dto = await svc.create(ctx, { provider: "imap", address: "here@trafficflow.test", imap: IMAP }, PROBE_OK);
    await unstamp(db, dto.id);
    expect((await svc.organizeHere(ctx, dto.id, { intent: "join" })).outcome).toBe("authorized");
    expect(await stampOf(db, dto.id), "the press rang nothing").not.toBeNull();
    await db.update(mailboxes).set({ organizerRole: "organizer", takeoverAuthorizedAt: null, syncRequestedAt: null })
      .where(eq(mailboxes.id, dto.id));
    expect((await svc.organizeHere(ctx, dto.id, { intent: "join" })).outcome).toBe("already_organizing");
    expect(await stampOf(db, dto.id), "an already-organizing answer rang the doorbell").toBeNull();
  });

  it("Hand the mailbox back rings it on the request, and a not-organizing answer does not", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const dto = await svc.create(ctx, { provider: "imap", address: "back@trafficflow.test", imap: IMAP }, PROBE_OK);
    await db.update(mailboxes).set({ organizerRole: "reader", syncRequestedAt: null }).where(eq(mailboxes.id, dto.id));
    expect((await svc.release(ctx, dto.id)).outcome).toBe("not_organizing");
    expect(await stampOf(db, dto.id), "a not-organizing answer rang the doorbell").toBeNull();
    await db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, dto.id));
    expect((await svc.release(ctx, dto.id)).outcome).toBe("requested");
    expect(await stampOf(db, dto.id), "the release rang nothing").not.toBeNull();
  });
});

const REPO = resolve(join(import.meta.dirname, "..", "..", ".."));
const SERVICES = join(REPO, "packages/services/src");
const HELPER = "newMailboxDoorbell";

/** The enclosing method of every helper call, and every `insert(mailboxes).values({…})` without it. */
export function doorbellCensus(file: string, text: string): { calls: string[]; bareInserts: string[] } {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const calls: string[] = [];
  const bareInserts: string[] = [];
  const methodOf = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) return p.name?.getText(src) ?? "?";
    }
    return "(module)";
  };
  const ringsIt = (obj: ts.Expression): boolean => ts.isObjectLiteralExpression(obj) && obj.properties.some((p) =>
    ts.isSpreadAssignment(p) && ts.isCallExpression(p.expression) && p.expression.expression.getText(src) === HELPER);
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (n.expression.getText(src) === HELPER) calls.push(methodOf(n));
      // `….insert(mailboxes).values(<arg>)` — the CALL, read off the tree, never a mention.
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "values"
        && ts.isCallExpression(callee.expression)
        && callee.expression.expression.getText(src).endsWith(".insert")
        && callee.expression.arguments[0]?.getText(src) === "mailboxes"
        && !(n.arguments[0] && ringsIt(n.arguments[0]))) {
        bareInserts.push(`${file}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return { calls: calls.sort(), bareInserts };
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourcesUnder(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

describe("the doorbell census", () => {
  it("the helper is called at the six doors, and every mailbox INSERT in the services rings it", () => {
    const all = sourcesUnder(SERVICES).map((f) => doorbellCensus(f.slice(REPO.length + 1), readFileSync(f, "utf8")));
    expect(all.flatMap((r) => r.calls).sort()).toEqual(["connectOAuth", "connectOAuth", "create", "organizeHere", "release", "update"]);
    expect(all.flatMap((r) => r.bareInserts), "a mailbox INSERT that rings no doorbell").toEqual([]);
  });

  it("THE CONTROL: a fifth INSERT without the helper is refused, and one with it is admitted", () => {
    const bare = "class S { async adopt(tx) { await tx.insert(mailboxes).values({ address: 'a' }); } }";
    expect(doorbellCensus("fixture.ts", bare).bareInserts).toEqual(["fixture.ts:1"]);
    const rung = "class S { async adopt(tx) { await tx.insert(mailboxes).values({ ...newMailboxDoorbell(db) }); } }";
    expect(doorbellCensus("fixture.ts", rung)).toEqual({ calls: ["adopt"], bareInserts: [] });
  });
});
