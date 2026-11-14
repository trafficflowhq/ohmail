import { describe, expect, it } from "vitest";
import {
  inputOf,
  lookupOf,
  patchOf,
  sentOf,
  splitHostPort,
  validPort,
} from "../../../src/mailboxes/connect/body.js";
import { providerById } from "../../../src/mailboxes/connect/providers.js";
import { reveal, secretOf } from "../../../src/mailboxes/connect/secret.js";
import type { ConnectTyped } from "../../../src/mailboxes/connect/types.js";

const NOTHING: ConnectTyped = {
  address: "",
  provider: null,
  byHand: false,
  user: "",
  imapHost: "",
  smtpHost: "",
  imapPort: "",
  smtpPort: "",
  byPassword: false,
};
const typed = (over: Partial<ConnectTyped>): ConnectTyped => ({ ...NOTHING, ...over });
const NO_CLAIM = { imap: {}, smtp: {} } as const;
const PASS = secretOf("zq-MARKER-pass");
/** A body as it is written out, the seal marked, so its keys and their order can be read. */
const written = (body: unknown): string => JSON.stringify(body).replaceAll('"[secret]"', '"<the password>"');

describe("what a connect and a test send", () => {
  const manual = providerById("imap");
  const gmail = providerById("gmail");

  it("a manual server sends no TLS mode, and a port only when one was typed after the name", () => {
    const body = inputOf(
      typed({
        address: " me@example.org ",
        provider: "imap",
        imapHost: " mail.example.org ",
        smtpHost: "smtp.example.org:2525",
      }),
      manual,
      PASS,
      NO_CLAIM,
    );
    expect(written(body)).toBe(
      '{"provider":"imap","address":"me@example.org",' +
        '"imap":{"host":"mail.example.org","user":"me@example.org","pass":"<the password>"},' +
        '"smtp":{"host":"smtp.example.org","port":2525,"user":"me@example.org","pass":"<the password>"}}',
    );
    expect(body.imap).not.toHaveProperty("secure");
    expect(body.imap).not.toHaveProperty("port");
  });

  it("a preset sends its own host, port and TLS mode, whatever stands in the host fields' ports", () => {
    const body = inputOf(
      typed({
        address: "me@example.org",
        provider: "gmail",
        imapHost: gmail.imap.host,
        smtpHost: gmail.smtp.host,
      }),
      gmail,
      PASS,
      NO_CLAIM,
    );
    expect(body.imap).toMatchObject({
      host: gmail.imap.host,
      port: gmail.imap.port,
      secure: gmail.imap.secure,
    });
    expect(body.smtp).toMatchObject({
      host: gmail.smtp.host,
      port: gmail.smtp.port,
      secure: gmail.smtp.secure,
    });
  });

  it("the username defaults to the address, and a typed one rides both servers: the same body for the test and the connect", () => {
    const base = typed({
      address: "me@example.org",
      provider: "imap",
      imapHost: "mail.example.org",
      smtpHost: "mail.example.org",
    });
    expect(inputOf(base, manual, PASS, NO_CLAIM).imap.user).toBe("me@example.org");
    const named = inputOf({ ...base, user: " postbox7 " }, manual, PASS, NO_CLAIM);
    expect(named.imap.user).toBe("postbox7");
    expect(named.smtp?.user).toBe("postbox7");
  });

  it("carries the password sealed, the same seal on both servers, and never as a string", () => {
    const body = inputOf(
      typed({ address: "me@example.org", provider: "imap", imapHost: "a.example", smtpHost: "b.example" }),
      manual,
      PASS,
      NO_CLAIM,
    );
    expect(body.imap.pass).toBe(PASS);
    expect(body.smtp?.pass).toBe(PASS);
    expect(JSON.stringify(body)).not.toContain("MARKER");
    expect(reveal(body.imap.pass)).toBe("zq-MARKER-pass");
    expect(Object.isFrozen(body) && Object.isFrozen(body.imap) && Object.isFrozen(body.smtp)).toBe(true);
  });

  it("a consent or a trusted certificate rides only the server it is claimed for, and nothing rides unclaimed", () => {
    const base = typed({
      address: "me@example.org",
      provider: "imap",
      imapHost: "a.example",
      smtpHost: "b.example",
    });
    const none = inputOf(base, manual, PASS, NO_CLAIM);
    expect(written(none)).not.toContain("allowInsecure");
    expect(written(none)).not.toContain("trustCertificate");
    const one = inputOf(base, manual, PASS, {
      imap: { allowInsecure: true },
      smtp: { trustCertificate: "AA:BB" },
    });
    expect(one.imap.allowInsecure).toBe(true);
    expect(one.smtp).not.toHaveProperty("allowInsecure");
    expect(one.smtp?.trustCertificate).toBe("AA:BB");
    expect(one.imap).not.toHaveProperty("trustCertificate");
  });
});

describe("what an edit sends", () => {
  it("drops every blank, so rotating the password is a body of the password alone, and no outgoing server is dialled", () => {
    const patch = patchOf(typed({}), PASS, NO_CLAIM);
    expect(written(patch)).toBe('{"imap":{"pass":"<the password>"}}');
    expect(patch).not.toHaveProperty("smtp");
  });

  it("sends the outgoing block only when one of its fields was touched, with the password and a typed username", () => {
    const patch = patchOf(
      typed({ imapHost: " new.example ", imapPort: "1143", user: "u7", smtpPort: "2525" }),
      PASS,
      NO_CLAIM,
    );
    expect(written(patch)).toBe(
      '{"imap":{"pass":"<the password>","host":"new.example","user":"u7","port":1143},' +
        '"smtp":{"pass":"<the password>","port":2525,"user":"u7"}}',
    );
  });

  it("a consent rides an edit only where claimed", () => {
    const patch = patchOf(typed({ smtpHost: "s.example" }), PASS, {
      imap: { allowInsecure: true },
      smtp: {},
    });
    expect(patch.imap.allowInsecure).toBe(true);
    expect(patch.smtp).not.toHaveProperty("allowInsecure");
  });
});

describe("the small rules beside them", () => {
  it("a port after a name is split off; anything else stays one host", () => {
    expect(splitHostPort("mail.home.arpa:1143")).toEqual({ host: "mail.home.arpa", port: 1143 });
    expect(splitHostPort("[fd00::25]:587")).toEqual({ host: "fd00::25", port: 587 });
    expect(splitHostPort(" mail.example.org ")).toEqual({ host: "mail.example.org" });
    expect(splitHostPort("mail.example.org:99999")).toEqual({ host: "mail.example.org:99999" });
  });

  it("a port is a whole number from 1 to 65535", () => {
    expect(["1", "993", "65535"].every(validPort)).toBe(true);
    expect(["", "0", "65536", "99x", "-1", "1.5"].some(validPort)).toBe(false);
  });

  it("the lookup is asked about the domain alone, never the part before the @", () => {
    expect(lookupOf(" first.last+tag@Lichtgrat.example ")).toBe("lichtgrat.example");
    expect(lookupOf("no-at-sign")).toBeNull();
  });

  it("names each server a press dials as it was sent: the field whole, trimmed and lower-cased, its port included", () => {
    expect(
      sentOf(
        typed({ provider: "imap", imapHost: " Mail.Example.org:1143 ", smtpHost: "" }),
        providerById("imap"),
      ),
    ).toEqual({
      imap: "mail.example.org:1143",
      smtp: "",
    });
    expect(sentOf(typed({ imapHost: "", imapPort: "993", smtpHost: "S.example" }), null)).toEqual({
      imap: "stored:993",
      smtp: "s.example",
    });
    expect(sentOf(typed({}), null)).toEqual({ imap: "stored", smtp: "stored" });
  });
});
