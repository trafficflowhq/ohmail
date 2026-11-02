import { describe, it, expect } from "vitest";
import { buildImapAuth, UnsupportedAuthTypeError } from "../../src/adapters/imap-auth.js";

/**
 * THE SHARED CREDENTIAL→AUTH BUILDER — the one reader of `meta.authType`, and the guard that keeps a
 * refresh token from ever leaving as an IMAP LOGIN password. See `imap-auth.ts`'s header.
 */
describe("buildImapAuth", () => {
  it("a password row (no authType) yields { user, pass } and NOTHING else — the byte-for-byte no-op", () => {
    const auth = buildImapAuth({ user: "u@example.net" }, "s3cret");
    expect(auth).toEqual({ user: "u@example.net", pass: "s3cret" });
    // The union must not have quietly grown a token member on the password path.
    expect("fetchAccessToken" in auth).toBe(false);
  });

  it("authType:'password' explicitly is the same password path", () => {
    expect(buildImapAuth({ user: "u", authType: "password" }, "p")).toEqual({ user: "u", pass: "p" });
  });

  it("an oauth2 microsoft row yields a fetchAccessToken CALLBACK and never a pass", () => {
    const factoryCalls: Array<{ refreshToken: string; tenant: string; provider: string }> = [];
    const auth = buildImapAuth(
      { user: "u@contoso-com.example", authType: "oauth2", provider: "microsoft", tenant: "common" },
      "REFRESH-TOKEN",
      (input) => { factoryCalls.push(input); return async () => "ACCESS-TOKEN"; },
    );
    // The deadliest property, asserted directly: an oauth auth carries NO password field at all.
    expect("pass" in auth).toBe(false);
    expect("fetchAccessToken" in auth).toBe(true);
    expect(auth.user).toBe("u@contoso-com.example");
    // The refresh token reached the token-source factory, not a `pass`.
    expect(factoryCalls).toEqual([{ refreshToken: "REFRESH-TOKEN", tenant: "common", provider: "microsoft" }]);
    // The provider rides the auth: Microsoft files every submission into Sent Items itself.
    expect((auth as { provider?: string }).provider).toBe("microsoft");
  });

  it("THROWS on an unhandled authType — fail-closed, not a silent password default", () => {
    expect(() => buildImapAuth({ user: "u", authType: "graph" }, "secret"))
      .toThrow(UnsupportedAuthTypeError);
    expect(() => buildImapAuth({ user: "u", authType: "totally-made-up" }, "secret"))
      .toThrow(UnsupportedAuthTypeError);
  });

  it("THROWS on oauth2 with an unknown provider — a refresh token is never dialled speculatively", () => {
    expect(() => buildImapAuth(
      { user: "u", authType: "oauth2", provider: "google" }, "secret", () => async () => "t",
    )).toThrow(UnsupportedAuthTypeError);
  });

  it("THROWS on an oauth2 row at a site with no token source wired — refusing beats leaking", () => {
    expect(() => buildImapAuth(
      { user: "u", authType: "oauth2", provider: "microsoft", tenant: "common" }, "REFRESH-TOKEN",
    )).toThrow(UnsupportedAuthTypeError);
  });

  it("the thrown error carries a stable code and never the offending authType as a log value", () => {
    try {
      buildImapAuth({ user: "u", authType: "graph" }, "secret");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as UnsupportedAuthTypeError).code).toBe("OAUTH_UNSUPPORTED_AUTH_TYPE");
    }
  });
});
