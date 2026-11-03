import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createLogger } from "@trafficflow/core/mail";
import type { Logger } from "@trafficflow/core/mail";
import { makeImapProbe, makeSmtpProbe, type ProbeDialer } from "../src/imap-probe.js";
import type { ApiDeps } from "../src/deps.js";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { accountSettings, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { openMailboxImap } from "../src/attachments-adapter.js";
import { createApp, apiRoutes } from "@trafficflow/api";
/* The device door is a SELF-HOST route table, not `apiRoutes` — `mailbox-oauth-device.test.ts`
   asserts that separation, and driving its prune through the wrong table is a 404. */
import { selfHostRoutes } from "@trafficflow/api/self-host";
import {
  staffUsers, staffSessions, oauthProviderConfig, mailboxOauthCeremonies,
  mailboxOauthDeviceCeremonies, staffRoleGrants,
} from "@trafficflow/db/cloud";
import { scryptHasher, generateToken, hashToken, StaticKeyProvider } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * THE SEVEN REFUSAL LOG SITES HAND THE LOGGER THE THROWN VALUE — DRIVEN, NOT GREPPED.
 *
 * `packages/api/test/err-channel-census.test.ts` asks the source whether any site stringifies.
 * This asks the LINE. Both are needed and neither substitutes: the census cannot see what the
 * logger does with what it is given, and a driven site cannot speak for the one beside it.
 *
 * WHAT THE CHANGE IS. `err` is the logger's own slot: `createLogger` deletes it and derives
 * `errorClass` + `errorCode` from the value, plus a thrown STRING's redacted text as `errorText`.
 * `err: String(e)` handed it a string, so every Error arrived as `errorClass:"String"` with its
 * MESSAGE — a driver's prose — in `errorText`, the channel a genuinely thrown string uses. Each
 * case below drives BOTH arms: an Error carrying a `code`, whose class and code must survive and
 * whose message must not appear anywhere in the line; and a thrown string, whose text is the whole
 * diagnosis and must survive. The verdict is the bytes handed to the sink, never a fake's argument.
 *
 * MUTATION WATCHED, all seven, one at a time (2026-09-17): restore `err: String(err)` and that
 * site's ERROR arm alone goes red — `expected 'String' to be 'Error'`. Its STRING arm stays green,
 * and that is the measurement rather than a gap: `String(s) === s`, so the string arm was never
 * what the defect cost. Each file was restored by copying back a pristine copy and proved by `cmp`.
 */

/** The message no line may carry. Deliberately unlike anything else in these files. */
beforeEach(() => { vi.restoreAllMocks(); });

const PROSE = "connect ECONNREFUSED 10.99.0.7:5432 while reading mailbox_admission for u@vanity.example";
const THROWN_ERROR = (): Error => Object.assign(new Error(PROSE), { code: "ECONNREFUSED" });
const THROWN_STRING = "the pool was closed mid-release";

function capture(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: "api", level: "debug",
    sink: (l: string) => { lines.push(JSON.parse(l) as Record<string, unknown>); },
  });
  return { logger, lines };
}

/** The one line an event wrote. A site that wrote none fails here rather than vacuously passing. */
function lineFor(lines: Record<string, unknown>[], event: string): Record<string, unknown> {
  const found = lines.filter((l) => l.event === event);
  expect(found.length, `${event} was not written exactly once — the catch was not reached`).toBe(1);
  return found[0]!;
}

/**
 * The two arms, asserted identically everywhere. An Error keeps its class and code and loses its
 * prose; a thrown string keeps its text, which is all it has.
 */
function assertErrorArm(line: Record<string, unknown>): void {
  expect(line.errorClass, "the thrown value arrived pre-stringified").toBe("Error");
  expect(line.errorCode, "the code the operator acts on was lost").toBe("ECONNREFUSED");
  expect(JSON.stringify(line), "the driver's message reached the line").not.toContain("ECONNREFUSED 10.99");
  expect(line.errorText, "an Error has no business in the thrown-text channel").toBeUndefined();
}

function assertStringArm(line: Record<string, unknown>): void {
  expect(line.errorClass, "a thrown string is a String — that much is honest either way").toBe("String");
  expect(line.errorText, "the thrown string's text IS its diagnosis and it was dropped")
    .toBe(THROWN_STRING);
}

/* ── the probes: the slot is given back in a `finally`, and the giving back can fail ───────── */

function probeDeps(logger: Logger, thrown: unknown): ApiDeps {
  return {
    db: {} as ApiDeps["db"],
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    logger,
    // The probe keys its slot by the deployment's keyed hash of the address.
    keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 5)),
    services: {
      imapAdmission: {
        acquire: async () => true,
        release: async () => { throw thrown; },
      },
    } as unknown as ApiDeps["services"],
  } as ApiDeps;
}

const IMAP_IN = {
  accountId: "acct", address: "u@vanity.example",
  imap: { host: "imap.vanity.example", user: "u@vanity.example", pass: "typed-secret-password-password" },
};
const SMTP_IN = {
  accountId: "acct", address: "u@vanity.example",
  smtp: { host: "smtp.vanity.example", user: "u@vanity.example", pass: "typed-secret-password-password" },
};

/** A dialer whose connect refuses, so the ladder ends and the `finally` runs. */
const refusingFactory = (_c: ImapConfig): ProbeDialer => ({
  connect: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
  close: async () => { /* nothing held */ },
});

describe("imap_probe_slot_release_failed — imap-probe.ts", () => {
  it("a thrown Error keeps its class and code and loses its message", async () => {
    const { logger, lines } = capture();
    const probe = makeImapProbe(probeDeps(logger, THROWN_ERROR()), { adapterFactory: refusingFactory });
    await probe(IMAP_IN);
    assertErrorArm(lineFor(lines, "imap_probe_slot_release_failed"));
  });

  it("a thrown string keeps its text", async () => {
    const { logger, lines } = capture();
    const probe = makeImapProbe(probeDeps(logger, THROWN_STRING), { adapterFactory: refusingFactory });
    await probe(IMAP_IN);
    assertStringArm(lineFor(lines, "imap_probe_slot_release_failed"));
  });
});

describe("smtp_probe_slot_release_failed — imap-probe.ts", () => {
  const dial = async (): Promise<never> => {
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  };

  it("a thrown Error keeps its class and code and loses its message", async () => {
    const { logger, lines } = capture();
    const probe = makeSmtpProbe(probeDeps(logger, THROWN_ERROR()), { dial });
    await probe(SMTP_IN);
    assertErrorArm(lineFor(lines, "smtp_probe_slot_release_failed"));
  });

  it("a thrown string keeps its text", async () => {
    const { logger, lines } = capture();
    const probe = makeSmtpProbe(probeDeps(logger, THROWN_STRING), { dial });
    await probe(SMTP_IN);
    assertStringArm(lineFor(lines, "smtp_probe_slot_release_failed"));
  });
});

/* ── the admin OAuth surface: the wrapper's catch, and the re-read after a committed write ──── */

/**
 * A db whose reads of ONE table throw the planted value, and whose everything else is real. Keyed
 * on the TABLE rather than a call counter: a counter is a guess about how many reads run before
 * the subject, and it silently starts failing the wrong one when a route gains a read.
 */
function dbFailingSelectFrom(db: ApiDeps["db"], table: unknown, thrown: unknown): ApiDeps["db"] {
  return new Proxy(db as object, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (prop !== "select" || typeof v !== "function") {
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return (...args: unknown[]) => {
        const builder = (v as (...a: unknown[]) => unknown).apply(target, args) as object;
        return new Proxy(builder, {
          get(b, p, r) {
            const bv = Reflect.get(b, p, r) as unknown;
            if (p !== "from" || typeof bv !== "function") {
              return typeof bv === "function" ? (bv as (...a: unknown[]) => unknown).bind(b) : bv;
            }
            return (t: unknown, ...rest: unknown[]) => {
              if (t === table) throw thrown;
              return (bv as (...a: unknown[]) => unknown).apply(b, [t, ...rest]);
            };
          },
        });
      };
    },
  }) as ApiDeps["db"];
}

/** The same shape for a DELETE, which is what both ceremony prunes run. */
function dbFailingDeleteFrom(db: ApiDeps["db"], table: unknown, thrown: unknown): ApiDeps["db"] {
  return new Proxy(db as object, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (prop !== "delete" || typeof v !== "function") {
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return (t: unknown, ...rest: unknown[]) => {
        if (t === table) throw thrown;
        return (v as (...a: unknown[]) => unknown).apply(target, [t, ...rest]);
      };
    },
  }) as ApiDeps["db"];
}

describe("admin_oauth_failed and admin_oauth_reread_failed — routes/admin-oauth.ts", () => {
  const ADMIN_SECRET = "admin-console-internal-secret-fixture-token";

  async function seeded(thrown: unknown): Promise<{
    deps: ApiDeps; token: string; lines: Record<string, unknown>[];
  }> {
    const { deps } = await makeDeps();
    const { logger, lines } = capture();
    const [staff] = await deps.db.insert(staffUsers).values({
      email: `ops-${Math.random().toString(36).slice(2, 8)}@ohmail.app`,
      passwordHash: await scryptHasher.hash("staff-console-sign-in-password"),
    }).returning();
    // Cloud 0047: roles are read live; the registration routes admit ops and owner.
    await deps.db.insert(staffRoleGrants).values({ staffUserId: (staff as { id: string }).id, role: "owner" });
    const token = generateToken(32);
    await deps.db.insert(staffSessions).values({
      staffUserId: (staff as { id: string }).id,
      tokenHash: hashToken(token),
      lastTwofaAt: FIXED_NOW,
      expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
    });
    /* The proxy goes on AFTER the seed, so the fault is the route's read and not the fixture's. */
    return {
      deps: {
        ...deps, logger,
        admin: { secret: ADMIN_SECRET, environment: "test" },
        db: dbFailingSelectFrom(deps.db, oauthProviderConfig, thrown),
      } as ApiDeps,
      token, lines,
    };
  }

  const post = (path: string, body: unknown): Request => new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}` },
    body: JSON.stringify(body),
  });
  const handle = (r: Request, d: ApiDeps): Promise<Response> =>
    createApp(apiRoutes).handle(r, { ...d, session: null, idempotency: null });

  it("the wrapper's catch: a thrown Error keeps its class and code and loses its message", async () => {
    const { deps, token, lines } = await seeded(THROWN_ERROR());
    const res = await handle(post("/admin/oauth/microsoft", { sessionToken: token }), deps);
    expect(res.status, "the route did not take the fault path").toBe(503);
    assertErrorArm(lineFor(lines, "admin_oauth_failed"));
  });

  it("the wrapper's catch: a thrown string keeps its text", async () => {
    const { deps, token, lines } = await seeded(THROWN_STRING);
    await handle(post("/admin/oauth/microsoft", { sessionToken: token }), deps);
    assertStringArm(lineFor(lines, "admin_oauth_failed"));
  });

  it("the re-read after a COMMITTED write: an Error keeps its class and code, not its message", async () => {
    const { deps, token, lines } = await seeded(THROWN_ERROR());
    const res = await handle(post("/admin/oauth/microsoft/save", {
      sessionToken: token, note: "rotated the Entra secret", clientId: "26dd5904-19d1-495d-bc3c-67aa2da6f5e3",
    }), deps);
    /* 200 with `reread: false` — the write committed and only the read after it failed, which is
       the whole reason this catch exists. A 503 here would mean the proxy fired too early. */
    expect(res.status, "the save itself failed — the fault landed before the re-read").toBe(200);
    expect((await res.json() as { reread?: boolean }).reread).toBe(false);
    assertErrorArm(lineFor(lines, "admin_oauth_reread_failed"));
  });

  it("the re-read after a COMMITTED write: a thrown string keeps its text", async () => {
    const { deps, token, lines } = await seeded(THROWN_STRING);
    await handle(post("/admin/oauth/microsoft/save", {
      sessionToken: token, note: "rotated the Entra secret", clientId: "26dd5904-19d1-495d-bc3c-67aa2da6f5e3",
    }), deps);
    assertStringArm(lineFor(lines, "admin_oauth_reread_failed"));
  });
});

/* ── the two ceremony prunes: opportunistic, swallowed, and therefore only ever a LINE ──────── */

const MS_CLIENT_ID = "26dd5904-19d1-495d-bc3c-67aa2da6f5e3";

/**
 * Both prunes run AFTER the ceremony is committed and their failure is swallowed on purpose — a
 * ceremonies table that grew by one row is not a reason to refuse somebody's connect. So the line
 * is the only record there will ever be that the prune failed, which is what makes what the line
 * says the whole of the property.
 */
async function ceremonyWorld(thrown: unknown, over: Partial<ApiDeps>): Promise<{
  deps: ApiDeps; token: string; lines: Record<string, unknown>[];
}> {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const { logger, lines } = capture();
  return {
    deps: {
      ...deps, ...over, logger,
      appOrigin: "https://ohmail.app",
      db: dbFailingDeleteFrom(deps.db, mailboxOauthCeremonies, thrown),
    } as ApiDeps,
    token: s.token, lines,
  };
}

const handleApi = (r: Request, d: ApiDeps): Promise<Response> =>
  createApp(apiRoutes).handle(r, { ...d, session: null, idempotency: null });

describe("oauth_ceremony_prune_failed — routes/mailbox-oauth.ts", () => {
  const ENV_REGISTRATION = {
    msOAuth: {
      clientId: MS_CLIENT_ID, clientSecret: "THE-CLIENT-SECRET", tenant: "common",
      redirectUri: "https://ohmail.app/api/mailboxes/oauth/microsoft/callback",
    },
  } as Partial<ApiDeps>;

  async function drive(thrown: unknown): Promise<Record<string, unknown>[]> {
    const w = await ceremonyWorld(thrown, ENV_REGISTRATION);
    const res = await handleApi(req("POST", "/mailboxes/oauth/microsoft/start", {
      bearer: w.token, body: "{}",
    }), w.deps);
    /* 201: the ceremony was minted and the prune's failure did not refuse the connect. A non-201
       would mean the fault landed somewhere else and this case is measuring that instead. */
    expect(res.status, await res.clone().text()).toBe(201);
    return w.lines;
  }

  it("a thrown Error keeps its class and code and loses its message", async () => {
    assertErrorArm(lineFor(await drive(THROWN_ERROR()), "oauth_ceremony_prune_failed"));
  });

  it("a thrown string keeps its text", async () => {
    assertStringArm(lineFor(await drive(THROWN_STRING), "oauth_ceremony_prune_failed"));
  });
});

describe("oauth_device_prune_failed — routes/mailbox-oauth-device.ts", () => {
  /** The device-code grant, answered just far enough for the ceremony to be created. */
  const idp = {
    oauthFetch: (async (url: string, init: { body?: string }) => {
      const body = /\/devicecode$/.test(url)
        ? {
          device_code: "DEV-CODE-1", user_code: "H" + "7RMD2QK",
          verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5,
        }
        : { error: "authorization_pending" };
      void init;
      return {
        ok: /\/devicecode$/.test(url), status: /\/devicecode$/.test(url) ? 200 : 400,
        json: async () => body, text: async () => JSON.stringify(body),
      };
    }) as unknown as ApiDeps["oauthFetch"],
    msDevice: { clientId: MS_CLIENT_ID, tenant: "common" },
  } as Partial<ApiDeps>;

  async function drive(thrown: unknown): Promise<Record<string, unknown>[]> {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { logger, lines } = capture();
    const bag = {
      ...deps, ...idp, logger,
      appOrigin: "https://ohmail.app",
      db: dbFailingDeleteFrom(deps.db, mailboxOauthDeviceCeremonies, thrown),
    } as ApiDeps;
    const res = await createApp(selfHostRoutes).handle(
      req("POST", "/mailboxes/oauth/microsoft/device/start", { bearer: s.token, body: "{}" }),
      { ...bag, session: null, idempotency: null },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    return lines;
  }

  it("a thrown Error keeps its class and code and loses its message", async () => {
    assertErrorArm(lineFor(await drive(THROWN_ERROR()), "oauth_device_prune_failed"));
  });

  it("a thrown string keeps its text", async () => {
    assertStringArm(lineFor(await drive(THROWN_STRING), "oauth_device_prune_failed"));
  });
});

/* ── the attachment door's slot release: the one that runs on the success path too ──────────── */

/**
 * `openMailboxImap` gives back a LOCAL slot and a DATABASE one, exactly once, from a `release`
 * the door's `close()` reaches on every ending it has. Its failure is deliberately swallowed —
 * throwing would replace a completed download with an error about our own bookkeeping — so the
 * line is again the only record.
 */
describe("imap_slot_release_failed — attachments-adapter.ts", () => {
  async function drive(thrown: unknown): Promise<Record<string, unknown>[]> {
    const { db, deps } = await makeDeps();
    const { logger, lines } = capture();
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const accountId = randomUUID();
    await db.insert(accountSettings).values({ accountId });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `att-${randomUUID().slice(0, 8)}@example.invalid`,
    }).returning();
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport: "imap", secretEnc: "enc", keyVersion: 1,
      meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
    });
    const bag = {
      ...deps, logger,
      /* The stored secret is a fixture string, so the real provider would refuse to decode it;
         the subject is the RELEASE, not the unseal. Nothing it returns is ever printed. */
      keyProvider: { ...deps.keyProvider, decrypt: async () => "not-printed" },
      services: {
        ...(deps.services ?? {}),
        /* The port that production passes is `releaseImapSlot`; one that cannot comply is the
           production SHAPE of a failing release, not a double that answers differently. */
        imapAdmission: { acquire: async () => true, release: async () => { throw thrown; } },
      } as unknown as ApiDeps["services"],
    } as ApiDeps;
    const opened = await openMailboxImap(bag, mb!.id);
    await opened.close();
    return lines;
  }

  it("a thrown Error keeps its class and code and loses its message", async () => {
    assertErrorArm(lineFor(await drive(THROWN_ERROR()), "imap_slot_release_failed"));
  });

  it("a thrown string keeps its text", async () => {
    assertStringArm(lineFor(await drive(THROWN_STRING), "imap_slot_release_failed"));
  });
});
