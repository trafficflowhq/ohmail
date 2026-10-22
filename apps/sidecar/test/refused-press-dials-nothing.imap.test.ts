import { rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { mailboxCredentials, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { serviceUp } from "@trafficflow/db/testing";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 3 });

/**
 * A "SIGN IN AGAIN" REFUSED AT ITS LAUNCH LEAVES NOTHING THAT DIALS. The rows went and the runtime
 * kept the plaintext with its poll armed, so the next poll (no STARTTLS) or a forced cycle (a refused
 * certificate) dialled the removed password again. Real engine and store, a real `ImapAdapter` to
 * this checkout's GreenMail for every dial that succeeds; GreenMail refuses neither a login nor a
 * certificate, so the one launch under test is refused by the SCRIPT with the flag production
 * carries (imapflow's `authenticationFailed` and `tlsFailed`, the phone shim's `certificateRefused`).
 * The second press is unscripted: it dials, which a bump on the press's purge would refuse.
 */

const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IMAP_PORT ?? 3143);
const POLL_MS = 400;
const N = 2;

const SERVER_UP = serviceUp("greenmail", `${HOST}:${PORT}`).up;

type Arm = "auth" | "certificate" | "no-tls";

/** A launch refusal in the shape production gives it: the flags the engine's predicates read. */
function refusal(arm: Arm): Error {
  const err = new Error(`rig: the server refused this launch (${arm})`) as Error & Record<string, unknown>;
  if (arm === "auth") err.authenticationFailed = true;
  if (arm === "no-tls") err.tlsFailed = true;
  if (arm === "certificate") { err.tlsFailed = true; err.certificateRefused = true; }
  return err;
}

interface Wire {
  /** One step per `connect()`, in call order; unscripted, the dial goes to GreenMail. */
  script: Array<"ok" | Arm>;
  connects: number;
  factoryCalls: number;
  /** Every config a dial was built from — the runtime's own objects, read by reference. */
  configs: ImapConfig[];
  /** `connect()` calls per config object, so the runtime's own dials are told from a probe's. */
  byConfig: Map<ImapConfig, number>;
  /** The engine's own log lines, event and reason only. */
  events: Array<{ event: string; reason: string }>;
}

class ScriptedAdapter extends ImapAdapter {
  constructor(
    private readonly cfg: ImapConfig, onConnectionError: (err: unknown) => void, private readonly wire: Wire,
  ) {
    super(cfg, { onConnectionError });
  }

  override async connect(): Promise<void> {
    this.wire.connects += 1;
    this.wire.byConfig.set(this.cfg, (this.wire.byConfig.get(this.cfg) ?? 0) + 1);
    const step = this.wire.script.shift() ?? "ok";
    if (step !== "ok") throw refusal(step);
    return super.connect();
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function seedServer(address: string, pass: string): Promise<void> {
  const seeder = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user: address, pass }, logger: false });
  await seeder.connect();
  try {
    for (let i = 0; i < N; i++) {
      await seeder.append("INBOX", Buffer.from([
        `From: sender${i} <sender${i}@example.test>`, `To: <${address}>`, `Subject: refused press ${i}`,
        `Message-ID: <refused-press-${i}-${randomUUID()}@example.test>`,
        `Date: Mon, 28 Sep 2026 10:0${i}:00 +0000`, "Content-Type: text/plain; charset=utf-8", "", `body ${i}`, "",
      ].join("\r\n"), "utf8"));
    }
  } finally {
    await seeder.logout().catch(() => undefined);
  }
}

/** The seed a first launch starts: its settings, no password yet, a short poll. */
async function bootSeed(address: string, wire: Wire): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-refused-press-");
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const s = await createSidecar({
    dataDir, address, keks: { 1: randomBytes(32) },
    imap: { host: HOST, port: PORT, secure: false, auth: { user: address } },
    machineName: "the computer being set up",
    pollIntervalMs: POLL_MS,
    leaseStaleAfterMs: 60_000,
    adapterFactory: (cfg, ctx) => {
      wire.factoryCalls += 1;
      wire.configs.push(cfg);
      return new ScriptedAdapter(cfg, ctx.onConnectionError, wire);
    },
    log: (event, detail) => {
      const reason = (detail as { reason?: unknown } | undefined)?.reason;
      wire.events.push({ event, reason: typeof reason === "string" ? reason : "" });
    },
  });
  cleanups.push(async () => { await s.stop().catch(() => undefined); });
  await s.start();
  return s;
}

const local = (s: Sidecar, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  s.handle(new Request(`http://local${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }));
const press = (s: Sidecar, pass: string): Promise<Response> =>
  local(s, `/local/mailboxes/${s.world.mailboxId}`, { method: "PATCH", body: { imap: { pass } } });
async function connection(s: Sidecar): Promise<Record<string, unknown>> {
  const res = await local(s, "/local/mailboxes/connections");
  const { items } = (await res.json()) as { items: Array<Record<string, unknown>> };
  return items.find((i) => i.mailboxId === s.world.mailboxId) ?? {};
}
const rows = (s: Sidecar) => s.db.select({ t: mailboxCredentials.transport }).from(mailboxCredentials)
  .where(eq(mailboxCredentials.mailboxId, s.world.mailboxId));
const stored = async (s: Sidecar): Promise<number> =>
  (await s.db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, s.world.mailboxId))).length;
const pause = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe.skipIf(!SERVER_UP)("a press refused at its launch", () => {
  it.each(["auth", "certificate", "no-tls"] as const)(
    "(%s) leaves no password anywhere, dials nothing, and the next press dials",
    async (arm) => {
      const address = `rp-${randomUUID()}@trafficflow.test`;
      const pass = randomUUID();
      await seedServer(address, pass);
      const wire: Wire = { script: [], connects: 0, factoryCalls: 0, configs: [], byConfig: new Map(), events: [] };
      const s = await bootSeed(address, wire);
      expect((await connection(s)).needsCredential, "the rig did not boot without a password").toBe(true);

      // The press: its probe dials GreenMail, its launch is the refusal under test.
      wire.script = ["ok", arm];
      const refused = await press(s, pass);
      const body = (await refused.json()) as { error?: { code?: string } };
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(body.error?.code).toBe("mailbox_probe_failed");
      expect(wire.script, "the rig's script was not spent as written").toEqual([]);
      /* AND THE LOG SAYS SO: no line after the refusal promises a dial the purge made impossible. */
      const promised = wire.events.filter((e) => e.reason.includes("next poll dials again"));
      expect.soft(promised.map((e) => e.event), "a line after the purge says the next poll dials").toEqual([]);

      /* Each group is soft so a red names every fault it has, not the first. Nothing of the
         password is left in the store, and nothing the runtime reports was earned by it. */
      expect.soft(await s.credentialState()).toBe("absent");
      expect.soft(await rows(s)).toEqual([]);
      const after = await connection(s);
      expect.soft(after.needsCredential, "the runtime does not say it has no password").toBe(true);
      expect.soft(after.unreachableSince, "a runtime that dials nothing reads an outage").toBeNull();
      /* The runtime's own record, which carries the refusals the route leaves to other surfaces:
         none may outlive the password it was recorded against. */
      const own = s.connectionStates()[s.world.mailboxId]!;
      expect.soft({
        signInRefused: own.signInRefused, certificateRefused: own.certificateRefused,
        plaintextRefused: own.plaintextRefused === true, since: own.needsCredentialSince instanceof Date,
      }).toEqual({ signInRefused: false, certificateRefused: false, plaintextRefused: false, since: true });

      /* …and nothing dials: two polls, a wake, then a FORCED cycle — the foreground resume, the
         one forced path a reader row has ("Sync now" is an organizer's press). */
      const quiet = { connects: wire.connects, factoryCalls: wire.factoryCalls };
      await pause(POLL_MS * 2 + 200);
      await s.wake();
      await s.resume().catch(() => undefined);
      await pause(POLL_MS + 200);
      expect.soft({ connects: wire.connects, factoryCalls: wire.factoryCalls }, "the removed password was dialled")
        .toEqual(quiet);
      /* AND THE DIAL CONFIG HOLDS NO PASSWORD, read after the forced cycle: the runtime's own object,
         by reference, so a memory the other resets happen to cover is still seen. */
      const dialConfig = wire.configs[0]!;
      expect.soft((dialConfig.auth as { pass?: string }).pass === "", "the removed password is still in the runtime's dial config")
        .toBe(true);

      /* A second press, the right password, no script: the SAME runtime launches — its own config
         dialled, not only the press's probe — and syncs. */
      const runtimeDials = wire.byConfig.get(dialConfig) ?? 0;
      const again = await press(s, pass);
      expect(again.status, JSON.stringify(await again.clone().json())).toBe(200);
      expect(wire.byConfig.get(dialConfig) ?? 0, "the next press stored a password nothing dialled")
        .toBeGreaterThan(runtimeDials);
      await vi.waitFor(async () => {
        expect(await stored(s)).toBe(N);
      }, { timeout: 15_000, interval: 100 });
      expect((await connection(s)).needsCredential).toBe(false);
    },
  );
});
