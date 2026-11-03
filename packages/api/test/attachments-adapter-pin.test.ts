import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { imapAdmissionKey, acquireImapSlot, releaseImapSlot, authThrottle } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { ImapAdapter, imapFlowOptions, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { ServiceError, StaticKeyProvider, type HostResolver } from "@trafficflow/services/mail";

/** The probe keys its slot by the deployment's keyed hash of the address. */
const KEYS = StaticKeyProvider.fromSecret(Buffer.alloc(32, 5));
import { makeOpenAdapter } from "../src/attachments-adapter.js";
import { makeImapProbe, makeProbeHostGuard, type ProbeDialer } from "../src/imap-probe.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * ═══ THE ATTACHMENT DOOR DIALS THE ADDRESS IT CHECKED ══════════════════════════════════════
 *
 * The same defect as the send path's, one door over. `openImapUnderCap` read `meta.host` out of
 * the credential row and handed the NAME to a fresh `ImapAdapter`, which resolved it again — with
 * the mailbox's own credential, on a request a signed-in person can make at will. The add-time
 * probe's check was the only one that ever ran, and it ran once.
 *
 * The guard now runs at this dial too, from the one module both doors share
 * (`dial-host-guard.ts`), and the cleared addresses go down as `ImapConfig.pin`. The name is
 * untouched, so SNI and certificate validation still see what the person typed.
 *
 * AHEAD OF BOTH ADMISSION SLOTS, and the last case measures that: a server this deployment will
 * not dial should cost neither the in-process slot nor the shared counter's, or a refused host
 * would spend a mailbox's connection budget on a socket that never existed.
 */

const NAME = "imap.vanity.example";
const PUBLIC_A = "93.184.216.34";
const METADATA = "169.254.169.254";
const ADDRESS = "u@vanity.example";

/** A resolver whose answer changes: every entry but the last is used once, the last repeats. */
function scriptedResolver(answers: string[][]): HostResolver {
  const left = answers.map((a) => [...a]);
  return {
    async resolve(): Promise<string[]> {
      return left.length > 1 ? left.shift()! : left[0]!;
    },
  };
}

/** A real (PGlite) database with one mailbox + its IMAP credential row, and the REAL counter. */
async function seed(resolver: HostResolver | null): Promise<{ deps: ApiDeps; mailboxId: string; accountId: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: ADDRESS })
    .returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: NAME, port: 993, secure: true, user: ADDRESS },
  });
  const deps = {
    db,
    // Required by the probe (one arm drives the real one), optional for the door — supply it once.
    now: () => new Date("2026-01-01T00:00:00Z"),
    // Never asserted on and never printed — only that a fetch was possible at all.
    keyProvider: { decrypt: async () => "not-printed", deriveSubkey: (info: string) => KEYS.deriveSubkey(info) },
    services: {
      imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot },
      // No guard at all IS the self-host policy (`ALLOW_ANY_PROBE_HOST`); a resolver means Cloud.
      ...(resolver ? { probeHostGuard: makeProbeHostGuard(resolver) } : {}),
    },
  } as unknown as ApiDeps;
  return { deps, mailboxId: row!.id, accountId };
}

/** Watch the dial: how many sockets were opened, and the config each was built with. */
function watchDial(): { configs: ImapConfig[]; opened: () => number } {
  const configs: ImapConfig[] = [];
  let opened = 0;
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: object) {
    opened += 1;
    // The constructor keeps its config (`private readonly config`), which is the only place the
    // pin is observable without a socket — and the pin is exactly what a socket would read.
    configs.push((this as unknown as { config: ImapConfig }).config);
  });
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  return { configs, opened: () => opened };
}

/** What the SHARED counter row says is held for this mailbox — what another instance would read. */
async function slotCount(deps: ApiDeps, mailboxId: string): Promise<number> {
  const rows = await deps.db.select({ failures: authThrottle.failures }).from(authThrottle)
    .where(eq(authThrottle.key, imapAdmissionKey(mailboxId)));
  return rows[0]?.failures ?? 0;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the attachment door dials the address it checked", () => {
  it("REFUSES a host whose resolution changed between the probe and the fetch", async () => {
    /* The sequence, not a stand-in for it: the probe clears a public address and the mailbox is
       stored on the strength of it; the name then answers the metadata address; the fetch used to
       dial that with the mailbox's own credential. */
    const resolver = scriptedResolver([[PUBLIC_A], [METADATA]]);
    const { deps, mailboxId, accountId } = await seed(resolver);
    const dial = watchDial();

    const probe = makeImapProbe(deps, {
      adapterFactory: () => ({
        connect: async (): Promise<void> => undefined,
        close: async (): Promise<void> => undefined,
      }) as ProbeDialer,
    });
    const verdict = await probe({
      accountId, address: ADDRESS,
      imap: { host: NAME, port: 993, secure: true, user: ADDRESS, pass: "typed-secret-password-password" },
    });
    expect(verdict.verdict, "the probe must pass, or this proves nothing").toBe("ok");

    await expect(makeOpenAdapter(deps)(mailboxId))
      .rejects.toThrow(/is not one this service will connect to/);
    expect(dial.opened(), "a socket was opened for a host the guard refused").toBe(0);
  });

  it("an unchanged host still fetches, and the adapter carries the cleared address", async () => {
    /* The positive control. Without it the refusals could pass because attachments had stopped
       working for everybody, and the pin is the half that makes the check worth anything. */
    const { deps, mailboxId } = await seed(scriptedResolver([[PUBLIC_A]]));
    const dial = watchDial();

    const handle = await makeOpenAdapter(deps)(mailboxId);
    try {
      expect(dial.opened()).toBe(1);
      expect(dial.configs[0]!.host, "the dial must keep the name").toBe(NAME);
      expect(dial.configs[0]!.pin).toEqual([PUBLIC_A]);
    } finally {
      await handle.close();
    }
  });

  it("REFUSES a name that resolves to a private range at fetch time", async () => {
    const { deps, mailboxId } = await seed(scriptedResolver([[METADATA]]));
    const dial = watchDial();

    await expect(makeOpenAdapter(deps)(mailboxId))
      .rejects.toThrow(/is not one this service will connect to/);
    expect(dial.opened()).toBe(0);
  });

  it("the pin moves the ADDRESS and nothing else: SNI and the certificate see the name", async () => {
    /* The arm that fails if the pin dropped SNI. `servername` is derived from `host`, and RFC 6066
       §3 forbids an IP literal there — so a door that dialled the address would produce NO
       servername, a multi-vhost server would answer with its default certificate, and the failure
       would be indistinguishable from a wrong one. Asserted FIRST for that reason. */
    const { deps, mailboxId } = await seed(scriptedResolver([[PUBLIC_A]]));
    const dial = watchDial();
    const handle = await makeOpenAdapter(deps)(mailboxId);
    try {
      const cfg = dial.configs[0]! as Parameters<typeof imapFlowOptions>[0];
      const opts = imapFlowOptions(cfg) as unknown as Record<string, unknown>;
      expect(opts.servername, "SNI must be the name, never the address").toBe(NAME);
      expect(opts.host).toBe(NAME);
      expect((opts.tls as Record<string, unknown>).rejectUnauthorized).toBe(true);
      // ...and the socket still goes to the checked address: the lookup `net.connect` calls.
      const lookup = (opts.tls as { lookup?: unknown }).lookup;
      expect(typeof lookup).toBe("function");
      // Awaited, as `net` awaits it: the pin answers after the call, never inside it.
      const [err, address] = await new Promise<[unknown, unknown]>((resolve) => {
        (lookup as (h: string, o: unknown, cb: (e: unknown, a: unknown) => void) => void)(
          NAME, {}, (e, a) => resolve([e, a]),
        );
      });
      expect(err, "the pinned lookup must never fail the connect").toBeNull();
      expect(address).toBe(PUBLIC_A);
    } finally {
      await handle.close();
    }
  });

  it("a SELF-HOST install is untouched: no resolution, no pin, dial by name", async () => {
    /* The policy's other half. A self-hosted attachment fetch reaches the operator's own network
       by a name only their resolver knows; the self-host guard clears nothing, so there is nothing
       to pin. No `probeHostGuard` on the deps IS that policy. */
    const { deps, mailboxId } = await seed(null);
    const dial = watchDial();

    const handle = await makeOpenAdapter(deps)(mailboxId);
    try {
      expect(dial.opened()).toBe(1);
      expect(dial.configs[0]!.pin).toBeUndefined();
      expect(dial.configs[0]!.host).toBe(NAME);
    } finally {
      await handle.close();
    }
  });

  it("a refused host costs NO admission slot — neither the shared one nor the local one", async () => {
    /* Why the check sits ahead of both slots. Charging a refused host would let a mailbox whose
       server has moved burn its own connection budget on sockets that never existed, and the
       budget is the thing that stops a provider reading a burst as a wrong password. Measured from
       both sides: the shared counter is untouched, and the mailbox can still be opened afterwards. */
    const { deps, mailboxId } = await seed(scriptedResolver([[METADATA]]));
    const dial = watchDial();

    await expect(makeOpenAdapter(deps)(mailboxId)).rejects.toBeInstanceOf(ServiceError);
    expect(await slotCount(deps, mailboxId), "the refusal charged the shared counter").toBe(0);

    // The LOCAL slot too: a leaked in-process slot is invisible to the counter above, so the
    // proof is that the very next open of the same mailbox still succeeds.
    (deps.services as unknown as { probeHostGuard: unknown }).probeHostGuard =
      makeProbeHostGuard(scriptedResolver([[PUBLIC_A]]));
    const handle = await makeOpenAdapter(deps)(mailboxId);
    try {
      expect(dial.opened()).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
