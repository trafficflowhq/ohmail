import { describe, it, expect } from "vitest";
import { imapFlowOptions, smtpTransportOptions } from "../../src/adapters/imap.js";
import { TLS_FLOOR, type ImapConfig } from "../../src/adapters/imap-types.js";

/**
 * THE DIAL PIN ON THE MAIL LEGS — the other half of the add-time probe's SSRF guard.
 *
 * ── THE HOLE THESE TESTS CLOSE ──────────────────────────────────────────────────────────────
 *
 * The hosted probe's host guard resolved a caller-supplied hostname, cleared its addresses, and
 * then handed the same NAME to the dialler — which resolved it AGAIN. Two lookups, one check: a
 * DNS-rebinding server answers the guard with a public address and the socket with
 * `169.254.169.254`, and the connect oracle the guard exists to close is open through the window
 * between them. `assertPublicHost` has returned the cleared addresses all along; nothing carried
 * them to the socket.
 *
 * ── WHY THESE ASSERT ON THE ASSEMBLED OPTION SET, AND ON THE LOOKUP ITSELF ──────────────────
 *
 * Because the pin is only worth anything if the LIBRARY reads it, and each library reads a
 * different thing. imapflow forwards exactly one option bag to the connector —
 * `Object.assign({ host, servername, port }, this.options.tls)` into `tls.connect` or
 * `net.connect` (`imap-flow.js:1811`, `:1932`) — so the pin has to be a `lookup` inside `tls` and
 * a top-level one would be silently ignored. nodemailer never consults a `lookup` at all: it
 * resolves the name itself before connecting (`smtp-connection/index.js:305`, `:345`), so its pin
 * has to be the dial host. The tests below drive the assembled option set for both, and CALL the
 * lookup with a hostname that has "changed its answer", which is the actual failure sequence.
 *
 * ── AND ON WHAT THE PIN MUST NOT CHANGE ─────────────────────────────────────────────────────
 *
 * This is the TLS-floor path, whose failure mode is a server transcript containing the user's
 * plaintext password. A pin that dropped a floor key, or that moved the certificate check off the
 * name and onto an address, would be a worse hole than the one it closes — so every assertion
 * about the pin is paired with one about `TLS_FLOOR` and `servername` surviving it intact.
 */

const NAME = "mail.vanity.example";
const CLEARED = ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] as const;

const cfg = (over: Partial<ImapConfig> = {}): ImapConfig => ({
  host: NAME, port: 993, secure: true,
  auth: { user: "u@vanity.example", pass: "user-entered-password" },
  ...over,
});

/** Call an assembled `tls.lookup` the way `net.connect` does, and report what the socket gets. It
 * awaits the callback, as `net` does: the pin answers after the call, never inside it. */
async function askLookup(
  options: Record<string, unknown>,
  hostname: string,
  opts: { all?: boolean; family?: number } = {},
): Promise<{ address: string; family: number } | { address: string; family: number }[]> {
  const lookup = (options.tls as { lookup?: unknown } | undefined)?.lookup;
  if (typeof lookup !== "function") throw new Error("no lookup on the assembled tls options");
  const [err, seen] = await new Promise<[unknown, unknown]>((resolve) => {
    (lookup as (h: string, o: unknown, cb: (e: unknown, a: unknown, f?: number) => void) => void)(
      hostname, opts,
      (e, a, f) => resolve([e, opts.all === true ? a : { address: a, family: f }]),
    );
  });
  expect(err, "the pinned lookup must never fail the connect").toBeNull();
  return seen as { address: string; family: number };
}

describe("imapFlowOptions — the pin reaches the socket, and nothing else moves", () => {
  it("NO PIN is the historical path byte for byte: the tls slot is exactly the floor", () => {
    const options = imapFlowOptions(cfg() as never) as Record<string, unknown>;
    expect(options.tls).toEqual(TLS_FLOOR);
    // Not merely equal-by-value: the key must be ABSENT, or a future reader would take an
    // undefined `lookup` for a pin that is present and empty.
    expect(Object.keys(options.tls as object)).not.toContain("lookup");
    expect(options.host).toBe(NAME);
  });

  it("AN EMPTY PIN IS NOT A PIN — it dials by name rather than refusing at the socket", () => {
    const options = imapFlowOptions(cfg({ pin: [] }) as never) as Record<string, unknown>;
    expect(options.tls).toEqual(TLS_FLOOR);
    expect(options.host).toBe(NAME);
  });

  it("WITH A PIN the lookup is in the tls slot — the one bag imapflow hands to the connector", () => {
    const options = imapFlowOptions(cfg({ pin: CLEARED }) as never) as Record<string, unknown>;
    const tls = options.tls as Record<string, unknown>;
    expect(typeof tls.lookup).toBe("function");
    // A top-level lookup would be read by NOTHING; assert the pin did not land there instead.
    expect(options.lookup).toBeUndefined();
  });

  it("THE FLOOR SURVIVES THE PIN — every TLS_FLOOR key, and the SNI, are untouched", () => {
    const options = imapFlowOptions(cfg({ pin: CLEARED }) as never) as Record<string, unknown>;
    const tls = options.tls as Record<string, unknown>;
    for (const [k, v] of Object.entries(TLS_FLOOR)) expect(tls[k], k).toEqual(v);
    expect(tls.rejectUnauthorized).toBe(true);
    expect(tls.minVersion).toBe("TLSv1.2");
    // The certificate is still checked against the NAME the user typed, not the pinned address.
    expect(options.host).toBe(NAME);
    expect(options.servername).toBe(NAME);
  });

  it("A DNS ANSWER THAT CHANGES AFTER THE CHECK CANNOT MOVE THE CONNECTION", async () => {
    const options = imapFlowOptions(cfg({ pin: ["93.184.216.34"] }) as never) as Record<string, unknown>;
    // `net.connect` calls the lookup with the hostname. By this point the name "resolves" to the
    // metadata address for everyone else; the socket still goes where the guard cleared.
    expect(await askLookup(options, NAME)).toEqual({ address: "93.184.216.34", family: 4 });
    // The hostname argument is not consulted at all — the same answer for a name nobody cleared.
    expect(await askLookup(options, "169.254.169.254.attacker.example"))
      .toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("the pin carries the WHOLE cleared set, in both of net's call shapes and both families", async () => {
    const options = imapFlowOptions(cfg({ pin: CLEARED }) as never) as Record<string, unknown>;
    expect(await askLookup(options, NAME, { all: true })).toEqual([
      { address: CLEARED[0], family: 4 },
      { address: CLEARED[1], family: 6 },
    ]);
    expect(await askLookup(options, NAME, { family: 6 })).toEqual({ address: CLEARED[1], family: 6 });
    expect(await askLookup(options, NAME, { family: 4 })).toEqual({ address: CLEARED[0], family: 4 });
  });

  it("THE STARTTLS RUNG IS PINNED TOO — the plaintext-then-upgrade dial is a socket like any other", async () => {
    const options = imapFlowOptions(cfg({ port: 143, secure: false, pin: CLEARED }) as never) as Record<string, unknown>;
    // `net.connect` gets the same merged bag on this rung, so the lookup is honoured there.
    expect(await askLookup(options, NAME)).toEqual({ address: CLEARED[0], family: 4 });
    // …and the mandatory upgrade is still mandatory.
    expect(options.doSTARTTLS).toBe(true);
    expect(options.tls).toMatchObject(TLS_FLOOR);
  });

  it("THE CONSENT BRANCH IS PINNED TOO — the one dial that may end up in clear text is the one that most needs it", async () => {
    const options = imapFlowOptions(
      cfg({ port: 143, secure: false, allowInsecure: true, pin: CLEARED }) as never,
    ) as Record<string, unknown>;
    expect(await askLookup(options, NAME)).toEqual({ address: CLEARED[0], family: 4 });
    // The consent trades a mandatory upgrade for an opportunistic one and NOTHING else: the
    // certificate of any upgrade that does happen is still validated.
    expect(options.doSTARTTLS).toBeUndefined();
    expect(options.tls).toMatchObject(TLS_FLOOR);
  });
});

describe("smtpTransportOptions — the submission leg pins by dial host, because nodemailer resolves it itself", () => {
  const smtpCfg = (pin?: readonly string[]): ImapConfig => cfg({
    smtp: {
      host: "smtp.vanity.example", port: 465, secure: true,
      auth: { user: "u@vanity.example", pass: "user-entered-password" },
      ...(pin ? { pin } : {}),
    },
  });

  it("NO PIN dials the name, exactly as before", () => {
    const options = smtpTransportOptions(smtpCfg()) as Record<string, unknown>;
    expect(options.host).toBe("smtp.vanity.example");
    expect(options.servername).toBe("smtp.vanity.example");
    expect(options.tls).toEqual(TLS_FLOOR);
  });

  it("WITH A PIN the dial host is the cleared address and the SNI is still the NAME", () => {
    const options = smtpTransportOptions(smtpCfg(CLEARED)) as Record<string, unknown>;
    // `shared.resolveHostname` short-circuits on a literal (`net.isIP` → "nothing to do here"),
    // so this is the one form nodemailer will not re-resolve.
    expect(options.host).toBe(CLEARED[0]);
    // The certificate is validated against the name — `tls.connect` prefers `servername` over
    // `host`, and the STARTTLS upgrade re-reads it from the same option. Pinning the address
    // must not turn every pinned submission dial into a hostname mismatch.
    expect(options.servername).toBe("smtp.vanity.example");
    expect(options.tls).toEqual(TLS_FLOOR);
    expect(options.secure).toBe(true);
  });

  it("AN EMPTY PIN dials the name — the pin narrows a permitted dial, it is not a refusal", () => {
    const options = smtpTransportOptions(smtpCfg([])) as Record<string, unknown>;
    expect(options.host).toBe("smtp.vanity.example");
  });

  it("the STARTTLS submission rung keeps requireTLS while pinned", () => {
    const options = smtpTransportOptions(cfg({
      smtp: {
        host: "smtp.vanity.example", port: 587, secure: false,
        auth: { user: "u@vanity.example", pass: "user-entered-password" }, pin: CLEARED,
      },
    })) as Record<string, unknown>;
    expect(options.host).toBe(CLEARED[0]);
    expect(options.servername).toBe("smtp.vanity.example");
    expect(options.requireTLS).toBe(true);
    expect(options.opportunisticTLS).toBe(false);
    expect(options.ignoreTLS).toBe(false);
  });
});
