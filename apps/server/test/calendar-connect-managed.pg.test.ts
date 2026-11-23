import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, mailboxes, sessions, users } from "@trafficflow/db";
import { closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, serviceUp, throwawayDb } from "@trafficflow/db/testing";
import { generateToken, hashToken } from "@trafficflow/services";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { MANAGED_ENV, PROCESS_DOOR, env, processInput, recordingLogger } from "./_envs.js";

describe.skipIf(!serviceUp("pg").up)("calendar setup on a managed server", () => {
  const fixture = throwawayDb("calendar_connect");
  let program: Program;
  const access = generateToken();

  beforeAll(async () => {
    await fixture.createFromTemplate();
    const db = makePooledDb(fixture.url);
    const now = new Date();
    const [account] = await db.insert(accounts).values({ name: "Calendar fixture" }).returning();
    const [user] = await db.insert(users).values({
      accountId: account!.id, email: "person@example.invalid", emailVerifiedAt: now,
    }).returning();
    await db.insert(sessions).values({
      accountId: account!.id, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(access),
      accessExpiresAt: new Date(now.getTime() + 60_000), refreshExpiresAt: new Date(now.getTime() + 120_000),
      lastTwofaAt: now,
    });
    await db.insert(mailboxes).values({ accountId: account!.id, provider: "icloud", address: user!.email });
    program = buildProgram(loadSettings(env(MANAGED_ENV, {
      DATABASE_URL_POOLED: fixture.url, OHMAIL_CALENDAR: "1",
    }), PROCESS_DOOR), processInput(recordingLogger().logger));
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await program?.close();
    await closePooledDbs();
    await fixture.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  async function ask(path: string, enabled?: boolean) {
    const response = await program.dispatch(new Request(new URL(path, "http://localhost"), {
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      ...(enabled === undefined ? {} : { method: "PATCH", body: JSON.stringify({ enabled }) }),
    }));
    expect(response.status).toBe(200);
    return response.json();
  }

  it("offers typed connections when calendar is enabled and keeps the fixture mailbox separate", async () => {
    expect(await ask("/calendar/settings")).toMatchObject({ enabledAt: null, unconfigured: true });
    expect(await ask("/calendar/connect")).toEqual({ ways: [], connections: [] });
    expect(await ask("/calendar/settings", true)).toMatchObject({ enabledAt: expect.any(String) });
    expect(await ask("/calendar/connect")).toEqual({ ways: ["icloud", "caldav", "ics"], connections: [] });
  });
});
