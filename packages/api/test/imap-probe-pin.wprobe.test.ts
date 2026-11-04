import { describe, it, expect } from "vitest";
import type { ApiDeps } from "@trafficflow/api";
import { imapFlowOptions, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { StaticKeyProvider, type HostResolver } from "@trafficflow/services/mail";
import {
  makeImapProbe, makeSmtpProbe, makeProbeHostGuard, ALLOW_ANY_PROBE_HOST,
  MAX_PINNED_PROBE_ADDRESSES,
  type ProbeDialer,
} from "../src/imap-probe.js";
import { FIXED_NOW } from "./helpers.js";

/**
 * E2-PROBE-HOST-NOT-PINNED — the probe dials WHAT THE GUARD CLEARED, not what the name resolves
 * to next.
 *
 * ── THE DEFECT, AS A SEQUENCE ───────────────────────────────────────────────────────────────
 *
 * 1. A person types a host into the connect form. `POST /mailboxes/probe` is the one route that
 *    dials a caller-supplied `host:port`, so the hosted deployment gates it: resolve the name,
 *    refuse any private/loopback/link-local answer, refuse a non-mail port.
 * 2. The gate cleared `93.184.216.34` and returned it. The probe threw the return value away and
 *    handed the dialler the NAME.
 * 3. The dialler resolved the name a SECOND time. A server that answers the first lookup with a
 *    public address and the second with `169.254.169.254` has just been dialled at an address
 *    nothing checked — and it is dialled with the user's mail password, on a path whose failure
 *    mode is a server transcript containing it.
 *
 * Two lookups, one check. The window between them is the whole guard.
 *
 * ── WHAT THESE TESTS DRIVE ──────────────────────────────────────────────────────────────────
 *
 * A resolver that CHANGES ITS ANSWER — public first, the metadata address on every call after.
 * That is the rebinding server, and it is the only shape that can tell a pinned probe from an
 * unpinned one: with a pin the second answer is never asked for and never reaches a socket; the
 * count of resolutions is therefore an assertion in its own right. The last test carries the
 * cleared address all the way into the assembled `ImapFlow` option set and calls the lookup
 * `net.connect` would call, because a pin the library does not read is not a pin.
 *
 * The refuse branch (a private answer is refused before any dial) lives in
 * `imap-probe-ladder.wprobe.test.ts` and is not repeated here.
 */

const NAME = "mail.vanity.example";
const PUBLIC_A = "93.184.216.34";
const METADATA = "169.254.169.254";
const CRED = { host: NAME, user: "u@vanity.example", pass: "user-entered-password" } as const;

function fakeDeps(guard: unknown): ApiDeps {
  return {
    db: {} as ApiDeps["db"],
    now: () => new Date(FIXED_NOW),
    // The probe keys its slot by the deployment's keyed hash of the address.
    keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 5)),
    services: {
      imapAdmission: { acquire: async () => true, release: async () => { /* counted elsewhere */ } },
      probeHostGuard: guard,
    } as unknown as ApiDeps["services"],
  } as ApiDeps;
}

/** A DNS-rebinding server: the first answer is public, every answer after it is the metadata address. */
function rebindingResolver(): { resolver: HostResolver; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    resolver: {
      async resolve(): Promise<string[]> {
        calls += 1;
        return calls === 1 ? [PUBLIC_A] : [METADATA];
      },
    },
  };
}

function recordingFactory(script: (c: ImapConfig) => Promise<void> = async () => { /* accepted */ }): {
  factory: (c: ImapConfig) => ProbeDialer; dialled: ImapConfig[];
} {
  const dialled: ImapConfig[] = [];
  return {
    dialled,
    factory: (config: ImapConfig): ProbeDialer => ({
      connect: async () => { dialled.push(config); await script(config); },
      close: async () => { /* nothing held */ },
    }),
  };
}

const refusedPort = (): Error =>
  Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", authenticationFailed: true });

const imapIn = (over: Record<string, unknown> = {}): Parameters<ReturnType<typeof makeImapProbe>>[0] =>
  ({ accountId: "a", address: "u@vanity.example", imap: { ...CRED, ...over } }) as never;

describe("makeImapProbe — the cleared address is the one dialled", () => {
  it("A DNS ANSWER THAT CHANGES BETWEEN THE GUARD AND THE DIAL CANNOT MOVE THE CONNECTION", async () => {
    const { resolver, calls } = rebindingResolver();
    // 993 is refused so the ladder walks to 143: two dials, and still ONE resolution.
    const { factory, dialled } = recordingFactory(async (c) => { if (c.port === 993) throw refusedPort(); });
    const probe = makeImapProbe(fakeDeps(makeProbeHostGuard(resolver)), { adapterFactory: factory });

    const verdict = await probe(imapIn());

    expect(verdict.verdict).toBe("ok");
    expect(dialled.map((c) => c.port)).toEqual([993, 143]);
    // ONE resolution for the whole probe. The second answer — the metadata address — was never
    // asked for, which is the property the pin buys: there is no second lookup to poison.
    expect(calls()).toBe(1);
    for (const c of dialled) {
      expect(c.pin, `rung ${c.port}`).toEqual([PUBLIC_A]);
      // The NAME survives on the config: SNI and the certificate check must still see it.
      expect(c.host, `rung ${c.port}`).toBe(NAME);
      expect(c.pin).not.toContain(METADATA);
    }
  });

  it("…and the pin reaches the SOCKET: the assembled option set answers the pinned address for any name", async () => {
    const { resolver } = rebindingResolver();
    const { factory, dialled } = recordingFactory();
    const probe = makeImapProbe(fakeDeps(makeProbeHostGuard(resolver)), { adapterFactory: factory });
    await probe(imapIn());

    // The real adapter builds its client from exactly this. A pin that stopped at the config and
    // never reached the library would pass every assertion above and change nothing on the wire.
    const options = imapFlowOptions(dialled[0]! as never) as Record<string, unknown>;
    const lookup = (options.tls as { lookup?: unknown }).lookup;
    expect(typeof lookup).toBe("function");
    // Awaited, as `net` awaits it: the pin answers after the call, never inside it.
    const got = await new Promise<unknown>((resolve) => {
      (lookup as (h: string, o: unknown, cb: (e: unknown, a: unknown, f?: number) => void) => void)(
        // By now the name resolves to the metadata address for everyone who asks.
        NAME, {}, (_e, a) => resolve(a),
      );
    });
    expect(got).toBe(PUBLIC_A);
    expect(options.host).toBe(NAME);
    expect(options.servername).toBe(NAME);
  });

  it("THE LOCAL POLICY IS UNPINNED, and must stay so — a LAN mail server is resolved by the OS", async () => {
    const { factory, dialled } = recordingFactory();
    const probe = makeImapProbe(fakeDeps(ALLOW_ANY_PROBE_HOST), { adapterFactory: factory });
    await probe(imapIn({ host: "dovecot.lan" }));
    expect(dialled).toHaveLength(1);
    // ABSENT, not empty: the desktop policy resolves nothing, so it has nothing to pin to, and a
    // `pin: []` would be a claim it never made.
    expect(dialled[0]!.pin).toBeUndefined();
    expect(dialled[0]!.host).toBe("dovecot.lan");
  });

  it("A HOSTILE DNS ANSWER IS BOUNDED — the pin never carries more addresses than the cap", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `93.184.${Math.floor(i / 256)}.${i % 256}`);
    const resolver: HostResolver = { async resolve(): Promise<string[]> { return many; } };
    const { factory, dialled } = recordingFactory();
    const probe = makeImapProbe(fakeDeps(makeProbeHostGuard(resolver)), { adapterFactory: factory });
    await probe(imapIn());
    expect(dialled[0]!.pin).toHaveLength(MAX_PINNED_PROBE_ADDRESSES);
    // Truncation is safe because every address in the list was already cleared as public — the
    // cap narrows the dial, it never widens what it may reach.
    expect(dialled[0]!.pin).toEqual(many.slice(0, MAX_PINNED_PROBE_ADDRESSES));
  });
});

describe("makeSmtpProbe — the submission leg is pinned by its own check", () => {
  const smtpIn = { accountId: "a", address: "u@vanity.example", smtp: { host: "smtp.vanity.example", user: "u@vanity.example", pass: "user-entered-password" } };

  it("the dial receives the cleared address, and the name is resolved ONCE for the whole ladder", async () => {
    const { resolver, calls } = rebindingResolver();
    const seen: { host: string; port: number; pin?: readonly string[] }[] = [];
    const probe = makeSmtpProbe(fakeDeps(makeProbeHostGuard(resolver)), {
      dial: async (s) => {
        seen.push({ host: s.host, port: s.port, pin: s.pin });
        if (s.port === 465) throw refusedPort();
      },
    });

    const verdict = await probe(smtpIn as never);

    expect(verdict.verdict).toBe("ok");
    expect(seen.map((s) => s.port)).toEqual([465, 587]);
    expect(calls()).toBe(1);
    for (const s of seen) {
      expect(s.pin, `rung ${s.port}`).toEqual([PUBLIC_A]);
      expect(s.host, `rung ${s.port}`).toBe("smtp.vanity.example");
    }
  });

  it("the local policy leaves the submission dial unpinned too", async () => {
    const seen: { pin?: readonly string[] }[] = [];
    const probe = makeSmtpProbe(fakeDeps(ALLOW_ANY_PROBE_HOST), {
      dial: async (s) => { seen.push({ pin: s.pin }); },
    });
    await probe(smtpIn as never);
    expect(seen[0]!.pin).toBeUndefined();
  });
});
