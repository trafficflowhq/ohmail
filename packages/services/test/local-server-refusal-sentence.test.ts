import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { dbFor, makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * A SERVER ON THIS COMPUTER IS SAID AS ITS OWN ONLY WHERE THE LONG WAIT APPLIED. The stamp is the
 * probe's own: the desktop door's IMAP probe marks a refusal it dialled under the local wait, and
 * the service says the local sentence for that verdict alone. A door without the wait (Cloud,
 * self-host) gets the base refusal byte for byte, loopback host or not; the outgoing leg never waits.
 */

const NOW = new Date("2026-10-07T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
const svc = makeMailboxService({ keyProvider: KP, allowance: async () => { /* unmetered here */ } });

type Verdict = { verdict: "ok" } | { verdict: "refuse"; code: "auth" | "timeout" | "connect"; localServer?: true };
interface Refused { code: string; message: string; details: Record<string, unknown> }

const OK: Verdict = { verdict: "ok" };

let ctx: ServiceContext;
beforeAll(async () => {
  const db = await makeTestDb();
  const [a] = await db.insert(accounts).values({ name: "local-server" }).returning();
  ctx = { db: dbFor(db, a!.id), accountId: a!.id, userId: null, now: () => NOW, requestId: randomUUID() };
});

/** One connect press with both legs' verdicts given; the refusal it answered, or null. */
async function connect(host: string, imap: Verdict, smtp: Verdict): Promise<Refused | null> {
  try {
    await svc.create(ctx, {
      provider: "imap", address: `gw-${randomUUID()}@gateway.test`,
      imap: { host, port: 1143, secure: false, user: "u", pass: "p" },
      smtp: { host, port: 1025, secure: false },
    }, { probe: async () => imap, smtpProbe: async () => smtp } as never);
    return null;
  } catch (err) {
    const e = err as { code?: unknown; message: string; details?: Record<string, unknown> };
    return { code: String(e.code), message: e.message, details: e.details ?? {} };
  }
}

describe("a refusal from a server on this computer", () => {
  it("a door without the long wait: a loopback refusal is the base refusal, byte for byte", async () => {
    for (const code of ["auth", "timeout", "connect"] as const) {
      const loopback = await connect("127.0.0.1", { verdict: "refuse", code }, OK);
      const remote = await connect("imap.example.test", { verdict: "refuse", code }, OK);
      expect(loopback, code).toEqual(remote);
      expect(loopback?.details, code).toEqual({ reason: code, transport: "imap" });
    }
  });

  it("the probe's stamp says it: the local sentence and details.localServer", async () => {
    const auth = await connect("127.0.0.1", { verdict: "refuse", code: "auth", localServer: true }, OK);
    expect(auth?.details).toEqual({ reason: "auth", transport: "imap", localServer: true });
    expect(auth?.message).toMatch(/server on this computer refused the sign-in/);
    expect(auth?.message).not.toMatch(/app-specific password/);
    const quiet = await connect("127.0.0.1", { verdict: "refuse", code: "timeout", localServer: true }, OK);
    expect(quiet?.message).toMatch(/did not answer in time/);
    // The bound also covers the folder count after a sign-in, so the sentence names no sign-in.
    expect(quiet?.message).not.toMatch(/sign-in/i);
  });

  it("the launch's refusal: the local sentence only when the engine that waits says so", async () => {
    const { launchRefused } = await import("../src/mailbox-service.js");
    const local = launchRefused("auth", true) as unknown as Refused;
    expect(local.message).toMatch(/server on this computer refused the sign-in/);
    expect(local.details).toEqual({ reason: "auth", transport: "imap", localServer: true });
    const plain = launchRefused("auth") as unknown as Refused;
    expect(plain.message).not.toMatch(/this computer/);
    expect(plain.details).toEqual({ reason: "auth", transport: "imap" });
  });

  it("the outgoing leg never waits, so it is never said as the local server's", async () => {
    for (const code of ["auth", "timeout"] as const) {
      const r = await connect("127.0.0.1", OK, { verdict: "refuse", code, localServer: true });
      expect(r?.details, code).toEqual({ reason: code, transport: "smtp" });
      expect(r?.message, code).not.toMatch(/two minutes|this computer/);
      expect(r?.message, code).toMatch(/SMTP/);
    }
  });
});
