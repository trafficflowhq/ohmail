import { describe, expect, it } from "vitest";
import {
  NO_DETAILS,
  certificateOfferOf,
  gateOf,
  noPortProbeSentence,
  plaintextOfferOf,
  probeReasonOf,
  reasonCodeOf,
  refusalOf,
  saidOf,
  saidOfReturn,
  withoutEcho,
  type Said,
  type SaidContext,
} from "../../../src/mailboxes/connect/refusal.js";
import { echoes, secretOf } from "../../../src/mailboxes/connect/secret.js";
import { CONNECT_STATES, saidOfState } from "../../../src/mailboxes/connect/states.js";
import type { Refusal, RefusalDetails } from "../../../src/mailboxes/connect/types.js";

const keyOf = (said: Said | null): string | null =>
  said === null ? null : "server" in said ? "server" : `${said.ns}.${said.key}`;
const refusal = (
  code: string | null,
  details: Partial<RefusalDetails> = {},
  status = 422,
  message = "The server's own sentence.",
): Refusal => ({
  status,
  code,
  message,
  details: { ...NO_DETAILS, ...details },
});
const probe = (details: Partial<RefusalDetails>): Refusal => refusal("mailbox_probe_failed", details);
const CTX: SaidContext = {
  purpose: "add",
  preset: "imap",
  manual: true,
  ports: false,
  signInArmed: false,
  afterFactor: false,
  factor: true,
};

/**
 * THE REGISTRY'S 55 STATES OF A REFUSED CONNECT, each with the sentence it draws. `server`: the server's own words
 * (it has no catalogue key). `null`: the state draws no sentence (a ticked line). The left column is the registry's
 * `state=` word; a row added there without a row here fails the count below.
 */
const EXPECTED: readonly (readonly [string, string | null])[] = [
  ["c-auth", "mailboxes.probe_auth"],
  ["c-gmail-app", "mailboxes.probe_auth_gmail_app_password_required"],
  ["c-gmail-invalid", "mailboxes.probe_auth_gmail_invalid"],
  ["c-gmail-web", "mailboxes.probe_auth_gmail_web_login"],
  ["c-gmail-imap", "mailboxes.probe_auth_gmail_imap_disabled"],
  ["c-microsoft", "mailboxes.probe_auth_microsoft"],
  ["c-icloud", "mailboxes.probe_auth_icloud"],
  ["c-yahoo", "mailboxes.probe_auth_yahoo"],
  ["c-fastmail", "mailboxes.probe_auth_fastmail"],
  ["c-gmx", "mailboxes.probe_auth_gmx"],
  ["c-infomaniak", "mailboxes.probe_auth_infomaniak"],
  ["c-webde", "mailboxes.probe_auth_webde"],
  ["c-tonline", "mailboxes.probe_auth_tonline"],
  ["c-bluewin", "mailboxes.probe_auth_bluewin"],
  ["c-local", "mailboxes.probe_auth_local"],
  ["c-connect", "mailboxes.probe_connect"],
  ["c-timeout", "mailboxes.probe_timeout"],
  ["c-noport", "mailboxes.probe_connect_noport"],
  ["c-smtp-auth", "mailboxes.probe_auth_smtp"],
  ["c-smtp-connect", "mailboxes.probe_connect_smtp"],
  ["c-smtp-timeout", "mailboxes.probe_timeout_smtp"],
  ["c-localwait", "mailboxes.probe_timeout_local"],
  ["c-host-empty", "server"],
  ["c-host-shape", "server"],
  ["c-host-missing", "server"],
  ["c-host-private", "server"],
  ["c-host-self", "server"],
  ["c-port", "mailboxes.portInvalid"],
  ["c-dns", "providerPicker.discoveredHosts"],
  ["c-check", "mailboxes.probe_storage"],
  ["c-check-unknown", "mailboxes.probe_unknown"],
  ["c-tls", "mailboxes.probe_tls"],
  ["c-tls-smtp", "mailboxes.probe_tls_smtp"],
  ["c-tls-name", "mailboxes.probe_tls_hostname"],
  ["c-tls-suggest", "mailboxes.probe_tls_hostname_suggest"],
  ["c-tls-expired", "mailboxes.probe_tls_expired"],
  ["c-tls-early", "mailboxes.probe_tls_not_yet_valid"],
  ["c-tls-self", "mailboxes.probe_tls_self_signed"],
  ["c-tls-untrusted", "mailboxes.probe_tls_untrusted"],
  ["c-tls-self-own", "mailboxes.probe_tls_self_signed_private"],
  ["c-tls-trust", "mailboxes.probe_tls_self_signed_local"],
  ["c-tls-trusted", null],
  ["c-plain", "mailboxes.probe_tls_unavailable"],
  ["c-plain-on", null],
  ["c-plain-public", "mailboxes.probe_tls_unavailable_public"],
  ["c-limit", "mailboxes.refused_mailbox_limit_reached"],
  ["c-unpaid", "mailboxes.refused_payment_required"],
  ["c-suspended", "mailboxes.refused_account_suspended"],
  ["c-notpermitted", "mailboxes.refused_mailbox_not_permitted"],
  ["c-unverified", "server"],
  ["c-exists", "mailboxes.refused_mailbox_exists"],
  ["c-samelogin", "mailboxes.refused_same_login"],
  ["c-oauth", "mailboxes.refused_signs_in_with_oauth"],
  ["c-changed", "mailboxes.refused_mailbox_config_changed"],
  ["c-backed", "mailboxes.cancelledNothingChanged"],
];

describe("every state of a refused connect reaches its sentence", () => {
  it("holds a row for each of the registry's 55, and no other", () => {
    expect(CONNECT_STATES.map((row) => row.id)).toEqual(EXPECTED.map(([id]) => id));
    expect(EXPECTED).toHaveLength(55);
  });

  it.each(EXPECTED)("%s says %s", (id, expected) => {
    const row = CONNECT_STATES.find((state) => state.id === id)!;
    expect(keyOf(saidOfState(row))).toBe(expected);
  });

  it("hands each sentence the values it is written with", () => {
    const of = (id: string): Said | null => saidOfState(CONNECT_STATES.find((state) => state.id === id)!);
    expect(of("c-noport")).toMatchObject({ values: { field: "imap" } });
    expect(of("c-tls-name")).toMatchObject({
      values: { certHost: "mail.hostwerk.example", expectedHost: "mail.lichtgrat.example", protocol: "IMAP" },
    });
    expect(of("c-tls-suggest")).toMatchObject({ values: { suggestedHost: "mail.hostwerk.example" } });
    expect(of("c-plain")).toMatchObject({ values: { protocol: "IMAP" } });
    expect(of("c-limit")).toMatchObject({ values: { limit: 5, count: 5 } });
    expect(of("c-oauth")).toMatchObject({ values: { provider: "microsoft" } });
    expect(of("c-changed")).toMatchObject({ values: { transport: "imap" } });
    expect(of("c-tls-self-own")).toMatchObject({ values: { variable: "NODE_EXTRA_CA_CERTS" } });
  });
});

describe("the gate's three", () => {
  it("a closed window asks the factor; a dead session or an unfinished enrolment is sign in; the rest is the verb's own", () => {
    expect(gateOf(refusal("step_up_required", {}, 403))).toBe("factor");
    expect(gateOf(refusal("anything", {}, 401))).toBe("signIn");
    expect(gateOf(refusal("enrollment_incomplete", {}, 403))).toBe("signIn");
    expect(gateOf(refusal("step_up_required", {}, 400))).toBe("other");
    expect(gateOf(probe({ reason: "auth" }))).toBe("other");
    expect(gateOf(refusal(null, {}, 0, ""))).toBe("other");
  });

  it("says sign in again in the mount's own words: after a verified factor, with no dialog to ask, and on a dead session", () => {
    const window403 = refusal("step_up_required", {}, 403);
    expect(keyOf(saidOf(window403, { ...CTX, afterFactor: true }))).toBe("devices.stepUpExpired");
    expect(keyOf(saidOf(window403, { ...CTX, factor: false }))).toBe("devices.stepUpExpired");
    expect(keyOf(saidOf(refusal("x", {}, 401), CTX))).toBe("devices.stepUpExpired");
    expect(keyOf(saidOf(refusal("x", {}, 401), { ...CTX, purpose: "join" }))).toBe("join.stepUpExpired");
  });
});

describe("a named certificate fault on the join", () => {
  const unencrypted = probe({
    reason: "tls",
    transport: "imap",
    tls: {
      kind: "tls_unavailable",
      plaintext: "offered",
      certHost: null,
      expectedHost: null,
      suggestedHost: null,
      trustVariable: null,
      certificate: null,
    },
  });

  it("is said in the catalogue's words there as on every mount: the join's step said it through the product's catalogue", () => {
    for (const purpose of ["join", "add", "firstRun"] as const)
      expect(keyOf(saidOf(unencrypted, { ...CTX, purpose })), purpose).toBe(
        "mailboxes.probe_tls_unavailable",
      );
    expect(saidOf(unencrypted, { ...CTX, purpose: "join" })).toMatchObject({ values: { protocol: "IMAP" } });
  });

  it("with no sentence from the server, the join says the catalogue's too: never nothing", () => {
    expect(keyOf(saidOf({ ...unencrypted, message: "" }, { ...CTX, purpose: "join" }))).toBe(
      "mailboxes.probe_tls_unavailable",
    );
  });

  it("still opens the consent the server offered, whatever the sentence", () => {
    expect(plaintextOfferOf(unencrypted)).toBe("imap");
  });
});

describe("a certificate kind a newer server sends", () => {
  const read = refusalOf({
    status: 400,
    code: "mailbox_probe_failed",
    message: "The server's own sentence.",
    details: { reason: "tls", transport: "imap", tls: { kind: "revoked_by_its_authority" } },
  });

  it("is a named fault with no sentence of its own: the certificate's general sentence, never the no-port one", () => {
    expect(noPortProbeSentence(read, true)).toBeNull();
    expect(noPortProbeSentence(read, false)).toBeNull();
    for (const purpose of ["join", "firstRun", "add"] as const)
      expect(keyOf(saidOf(read, { ...CTX, purpose })), purpose).toBe("mailboxes.probe_tls");
  });

  it("carries none of what it named, and opens no consent and no trust line", () => {
    expect(JSON.stringify(read)).not.toContain("revoked");
    expect([plaintextOfferOf(read), certificateOfferOf(read)]).toEqual([null, null]);
  });
});

describe("a refused password where a sign-in stands", () => {
  it("on the join names the sign-in; elsewhere the plain sentence, never app-password advice for a mailbox that signs in", () => {
    const refused = probe({ reason: "auth", transport: "imap" });
    const microsoft = { ...CTX, preset: "microsoft", manual: false, signInArmed: true };
    expect(keyOf(saidOf(refused, { ...microsoft, purpose: "join" }))).toBe("join.mailboxMicrosoftRefused");
    expect(keyOf(saidOf(refused, microsoft))).toBe("mailboxes.probe_auth");
    expect(keyOf(saidOf(refused, { ...microsoft, signInArmed: false }))).toBe(
      "mailboxes.probe_auth_microsoft",
    );
  });
});

describe("a provider's sign-in that came back with nothing connected", () => {
  it.each(["admin_consent_required", "consent_declined", "consent_failed", "state_invalid"] as const)(
    "refused: %s",
    (reason) => {
      const { said, calm } = saidOfReturn({ kind: "refused", reason }, "add");
      expect(keyOf(said)).toBe(`mailboxes.oauth_${reason}`);
      expect(calm).toBe(reason === "consent_declined");
    },
  );

  it.each([
    "state_invalid",
    "state_expired",
    "account_mismatch",
    "provider_unavailable",
    "exchange_failed",
    "no_refresh_token",
    "no_address",
    "oauth_unconfigured",
  ] as const)("failed on the join: %s, in the wizard's words", (reason) => {
    expect(
      keyOf(saidOfReturn({ kind: "failed", reason, message: "Start again from Settings." }, "join").said),
    ).toBe(`join.mailboxOauth_${reason}`);
  });

  it("failed elsewhere, or for a reason nobody words: the server's sentence, and with none the one honest line", () => {
    expect(
      saidOfReturn({ kind: "failed", reason: "state_expired", message: "Start again from Settings." }, "add")
        .said,
    ).toEqual({ server: "Start again from Settings." });
    expect(saidOfReturn({ kind: "failed", reason: null, message: "Something else." }, "join").said).toEqual({
      server: "Something else.",
    });
    expect(keyOf(saidOfReturn({ kind: "failed", reason: null, message: null }, "join").said)).toBe(
      "mailboxes.oauth_consent_failed",
    );
  });
});

describe("an unknown refusal", () => {
  it("says the server's own sentence, never a generic apology", () => {
    expect(saidOf(refusal("a_code_from_next_year", {}, 409, "That mailbox is being moved."), CTX)).toEqual({
      server: "That mailbox is being moved.",
    });
    expect(saidOf(probe({ reason: "a_reason_from_next_year" }), CTX)).toEqual({
      server: "The server's own sentence.",
    });
  });

  it("with no sentence at all says that the check did not finish", () => {
    expect(keyOf(saidOf(refusal(null, {}, 0, ""), CTX))).toBe("mailboxes.probe_unknown");
  });

  it("a table row whose shape does not fit keeps the server's sentence", () => {
    expect(saidOf(refusal("mailbox_limit_reached", {}, 402, "Out of mailboxes."), CTX)).toEqual({
      server: "Out of mailboxes.",
    });
    expect(
      saidOf(
        refusal("validation_failed", { field: "u" }, 422, "Enter the incoming (IMAP) server address."),
        CTX,
      ),
    ).toEqual({
      server: "Enter the incoming (IMAP) server address.",
    });
    expect(keyOf(saidOf(refusal("validation_failed", { field: "imap.port" }), CTX))).toBe(
      "mailboxes.refused_field_imap_port",
    );
  });
});

describe("what a refusal offers, and what it never does", () => {
  it("no encryption opens a consent line only where the server said the host is on a private network", () => {
    const tls = {
      kind: "tls_unavailable",
      certHost: null,
      expectedHost: null,
      suggestedHost: null,
      trustVariable: null,
      certificate: null,
    } as const;
    expect(
      plaintextOfferOf(probe({ reason: "tls", transport: "smtp", tls: { ...tls, plaintext: "offered" } })),
    ).toBe("smtp");
    expect(
      plaintextOfferOf(
        probe({ reason: "tls", transport: "imap", tls: { ...tls, plaintext: "not_private" } }),
      ),
    ).toBeNull();
    expect(
      plaintextOfferOf(probe({ reason: "tls", transport: "imap", tls: { ...tls, plaintext: null } })),
    ).toBeNull();
    expect(
      plaintextOfferOf(refusal("other_code", { reason: "tls", tls: { ...tls, plaintext: "offered" } })),
    ).toBeNull();
  });

  it("a certificate is offered only self-signed, by its fingerprint, for the leg that refused", () => {
    const sha256 = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(":");
    const tls = {
      kind: "self_signed",
      certHost: null,
      expectedHost: null,
      suggestedHost: null,
      plaintext: null,
      trustVariable: null,
    } as const;
    expect(
      certificateOfferOf(probe({ reason: "tls", transport: "smtp", tls: { ...tls, certificate: sha256 } })),
    ).toEqual({ transport: "smtp", sha256 });
    expect(
      certificateOfferOf(probe({ reason: "tls", tls: { ...tls, kind: "untrusted", certificate: sha256 } })),
    ).toBeNull();
    expect(certificateOfferOf(probe({ reason: "tls", tls: { ...tls, certificate: null } }))).toBeNull();
  });

  it("names for support a closed word alone: the probe's reason, else the code, and nothing that is no identifier", () => {
    expect(reasonCodeOf(probe({ reason: "auth" }))).toBe("auth");
    expect(reasonCodeOf(refusal("mailbox_exists"))).toBe("mailbox_exists");
    expect(reasonCodeOf(refusal(null, {}, 0, ""))).toBeNull();
    expect(probeReasonOf(probe({ reason: "not_a_reason" }))).toBeNull();
  });
});

describe("a refusal read off a transport", () => {
  const MARKER = "zq-MARKER-pass";
  const thrown = {
    status: 422,
    code: "mailbox_probe_failed",
    message: "That mail server refused the password.",
    details: {
      reason: "auth",
      transport: "smtp",
      authHint: "web_login",
      localServer: true,
      tls: {
        kind: "self_signed",
        certHost: "a.example",
        certificate: { sha256: `${"AB:".repeat(31)}AB` },
        echoed: MARKER,
      },
      request: { imap: { pass: MARKER } },
      pass: MARKER,
      mailboxLimit: 5,
      mailboxCount: 4,
    },
    body: { imap: { pass: MARKER } },
  };

  it("copies the typed fields one by one, and nothing else of the answer", () => {
    const read = refusalOf(thrown);
    expect(read).toEqual({
      status: 422,
      code: "mailbox_probe_failed",
      message: "That mail server refused the password.",
      details: {
        ...NO_DETAILS,
        reason: "auth",
        transport: "smtp",
        authHint: "web_login",
        localServer: true,
        mailboxLimit: 5,
        mailboxCount: 4,
        tls: {
          kind: "self_signed",
          certHost: "a.example",
          expectedHost: null,
          suggestedHost: null,
          plaintext: null,
          trustVariable: null,
          certificate: `${"AB:".repeat(31)}AB`,
        },
      },
    });
    expect(JSON.stringify(read)).not.toContain(MARKER);
  });

  it("an error that is no answer of a server is no sentence: its own text is never taken", () => {
    const fault = Object.assign(new TypeError(`fetch failed for body {"pass":"${MARKER}"}`), {
      body: MARKER,
    });
    expect(refusalOf(fault)).toEqual({ status: 0, code: null, message: "", details: NO_DETAILS });
    for (const odd of [null, undefined, "a string", 7, { status: "422", message: MARKER }])
      expect(refusalOf(odd)).toEqual({ status: 0, code: null, message: "", details: NO_DETAILS });
  });

  it("bounds what a server sends: a code that is no identifier, a fingerprint cut short, a name of 5 kB", () => {
    const read = refusalOf({
      status: 422,
      code: "<script>",
      message: "x".repeat(5000),
      details: {
        reason: "tls",
        tls: {
          kind: "self_signed",
          certHost: "h".repeat(5000),
          certificate: { sha256: "AB:CD" },
          suggestedHost: "<b>mail</b>",
        },
      },
    });
    expect(read.code).toBeNull();
    expect(read.message.length).toBeLessThanOrEqual(600);
    expect(read.details.tls?.certificate).toBeNull();
    expect(read.details.tls?.certHost).toBeNull();
    expect(read.details.tls?.suggestedHost).toBeNull();
  });

  it("is asked about the whole sentence before it is cut: an echo across the 600th character, and a 10 kB password echoed whole, draw no part of the password", () => {
    /* As a wire reads a refused press and the form then draws it. */
    const drawn = (message: string, password: string): string => {
      const sealed = secretOf(password);
      const repeats = (text: string): boolean => echoes(sealed, text);
      const read = refusalOf({ status: 409, code: "a_code_nobody_words", message, details: {} }, repeats);
      return withoutEcho(read, repeats).message;
    };
    const ordinary = "Qx7-review-one-pass-91";
    const long = `Qz${"k9".repeat(5000)}`;
    expect({
      straddling: drawn(`${"a".repeat(590)} ${ordinary} was refused`, ordinary).includes(
        ordinary.slice(0, 8),
      ),
      tenKilobytes: drawn(`The login with ${long} was refused.`, long).includes(long.slice(0, 64)),
    }).toEqual({ straddling: false, tenKilobytes: false });
    // A sentence that repeats nothing is cut as ever.
    expect(drawn("b".repeat(700), ordinary)).toBe("b".repeat(600));
  });
});
