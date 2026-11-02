import { describe, expect, it } from "vitest";
import type { AuthConfig, OAuthTokens } from "@trafficflow/services";
import {
  clearResumeCookie,
  clearSessionCookies,
  enrollmentCookies,
  ownerCookie,
  ownerCookieValue,
  sessionCookies,
  OWNER_COOKIE,
} from "../src/cookies.js";

/**
 * ═══ THE OWNER MARKER: A NAME BESIDE THE SESSION, AND NEVER A CREDENTIAL ═══════════════════
 *
 * The web client's mail mirror is named for the account it holds, and the name has to be one the
 * server issued — a shared database name is how one person's mail came to render to another. So
 * the shell asked `GET /auth/session` and rendered nothing until it answered, which put a network
 * round trip in front of every first paint, ahead of mail already on the device.
 *
 * This cookie carries that id so the browser can open the right mirror immediately and confirm in
 * parallel. It authorises nothing, is read by no handler, and is the only cookie in the set the
 * client is meant to read.
 *
 * What this file holds down is the posture — every attribute, on both the set and the clear — and
 * the one thing that could turn a harmless identifier into a header the caller controls.
 */

const CFG = { accessTtlMs: 15 * 60_000, refreshTtlMs: 30 * 86_400_000 } as unknown as AuthConfig;
const TOKENS = {
  accessToken: "access-abc",
  refreshToken: "refresh-def",
  tokenType: "Bearer",
  expiresIn: 900,
} as OAuthTokens;

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

/** The marker's line as written: the `__Host-` spelling (the bare one is only ever cleared). */
const ownerLine = (cookies: string[]): string | undefined =>
  cookies.find((c) => c.startsWith(`__Host-${OWNER_COOKIE}=`));

describe("the marker is set beside the session, with the session's own narrowness", () => {
  it("carries the account id, host-only, Secure, Strict — and READABLE", () => {
    const line = ownerLine(sessionCookies(TOKENS, "csrf-1", CFG, ACCOUNT));
    expect(line, "no owner cookie was set for a signed-in account").toBeDefined();
    expect(line).toContain(`__Host-${OWNER_COOKIE}=${ACCOUNT}`);
    expect(line).toContain("SameSite=Strict");
    expect(line).toContain("Secure");
    expect(line).toContain("Path=/");
    // The narrowness the single-origin merge was done to keep. `Domain=` would widen this to
    // every current and future subdomain.
    expect(line).not.toContain("Domain=");
    // NOT HttpOnly, uniquely among the markers, and it is the whole point: the client reads it
    // synchronously on its first render. HttpOnly here silently un-does the warm open.
    expect(line).not.toContain("HttpOnly");
  });

  it("lives as long as a RESUME could succeed, not as long as the access token", () => {
    // Fifteen minutes would expire the marker while the session it belongs to is still renewable,
    // and the browser would go back to blocking on the session check with nothing reporting it.
    const line = ownerLine(sessionCookies(TOKENS, "csrf-1", CFG, ACCOUNT))!;
    expect(line).toContain(`Max-Age=${30 * 86_400}`);
    expect(line).not.toContain(`Max-Age=${15 * 60}`);
  });

  it("the other four cookies are untouched — this adds a cookie, it does not change one", () => {
    // The session cookies' posture is load-bearing. Each is written in its `__Host-` spelling,
    // which is `Path=/` for all of them, and each bare spelling an earlier release wrote is expired.
    const cookies = sessionCookies(TOKENS, "csrf-1", CFG, ACCOUNT);
    expect(cookies).toHaveLength(10);
    expect(cookies[0]).toBe(
      `__Host-tf_session=${TOKENS.accessToken}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${15 * 60}`,
    );
    expect(cookies[1]).toBe(
      `__Host-tf_refresh=${TOKENS.refreshToken}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${30 * 86_400}`,
    );
    expect(cookies[2]).toBe(`__Host-tf_csrf=csrf-1; SameSite=Strict; Secure; Path=/; Max-Age=${15 * 60}`);
    expect(cookies.filter((c) => /^tf_/.test(c)).map((c) => c.split("=")[0]).sort())
      .toEqual(["tf_csrf", "tf_owner", "tf_refresh", "tf_resume", "tf_session"]);
    expect(cookies.find((c) => c.startsWith("tf_refresh="))).toBe(
      "tf_refresh=; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh; Max-Age=0");
  });

  it("`null` sets NOTHING — an omission is not a clear", () => {
    // The refresh path answers `null` when the browser sent no marker. It must leave the jar
    // alone: emitting an expiring line there would sign a resuming browser out of its own warm
    // open every time its access token rotated.
    const cookies = sessionCookies(TOKENS, "csrf-1", CFG, null);
    expect(cookies).toHaveLength(8);
    expect(ownerLine(cookies)).toBeUndefined();
    expect(cookies.some((c) => c.startsWith(`${OWNER_COOKIE}=`)), "an omission cleared the bare marker").toBe(false);
  });

  it("an ENROLLMENT session gets no marker — it owns no mailbox to open", () => {
    // The password factor alone. It is not allowed to open a mailbox at the gate, so it must not
    // be handed the one thing that would let a client open one optimistically.
    const cookies = enrollmentCookies("enrol-token", "csrf-1", { ...CFG, loginTokenTtlMs: 300_000 } as AuthConfig);
    expect(ownerLine(cookies)).toBeUndefined();
  });
});

describe("the marker has ONE spelling, minted from one place", () => {
  it("`sessionCookies` and the standalone mint produce the identical line", () => {
    // `GET /auth/session` mints this when a live jar has lost the marker. Two spellings of these
    // attributes is how a re-mint acquires a different `Path` — or a `Domain=` — and quietly
    // becomes a different cookie the clear above can no longer reach.
    expect(ownerLine(sessionCookies(TOKENS, "csrf-1", CFG, ACCOUNT)))
      .toBe(ownerCookie(ACCOUNT, CFG)[0]);
  });

  it("an id outside the safe set mints nothing, on this path too", () => {
    expect(ownerCookie("a=b; Domain=evil.example", CFG)).toEqual([]);
    expect(ownerCookie(null, CFG)).toEqual([]);
  });
});

describe("the value can never become an attribute", () => {
  it("THE INJECTION: an owner carrying cookie syntax sets no cookie at all", () => {
    // The refresh path re-stamps a value the BROWSER sent. Without the shape check that value
    // reaches a header we build by concatenation, and `Domain=` is one semicolon away — which is
    // precisely the widening the whole single-origin topology exists to prevent.
    for (const hostile of [
      `${ACCOUNT}; Domain=ohmail.app`,
      `${ACCOUNT}; SameSite=None`,
      "a\nSet-Cookie: tf_session=stolen",
      "has spaces",
      `${ACCOUNT}=extra`,
      "",
      "x".repeat(129),
    ]) {
      const cookies = sessionCookies(TOKENS, "csrf-1", CFG, hostile);
      expect(ownerLine(cookies), `a hostile owner produced a cookie: ${JSON.stringify(hostile)}`)
        .toBeUndefined();
      // …and it reached no OTHER line either.
      expect(cookies.join("\n")).not.toContain("Domain=");
      expect(cookies.join("\n")).not.toContain("SameSite=None");
    }
  });

  it("`ownerCookieValue` admits an account id and refuses everything else", () => {
    expect(ownerCookieValue(ACCOUNT)).toBe(ACCOUNT);
    expect(ownerCookieValue("aBc-123_x.y~z")).toBe("aBc-123_x.y~z");
    expect(ownerCookieValue(undefined)).toBeNull();
    expect(ownerCookieValue(null)).toBeNull();
    expect(ownerCookieValue("a b")).toBeNull();
    expect(ownerCookieValue("a;b")).toBeNull();
    expect(ownerCookieValue("a\r\nb")).toBeNull();
  });
});

describe("signing out takes it with the rest", () => {
  it("the clear expires the marker, with the attributes the set used", () => {
    // Max-Age=0 only removes a cookie the browser recognises as the same one. A mismatched
    // attribute leaves the original in the jar and the deletion silently does nothing — which
    // here would leave a signed-out browser still naming a mailbox.
    const cleared = clearSessionCookies();
    const line = cleared.find((c) => c.startsWith(`__Host-${OWNER_COOKIE}=`));
    expect(line, "logout does not clear the account marker").toBeDefined();
    expect(line).toBe(`__Host-${OWNER_COOKIE}=; SameSite=Strict; Secure; Path=/; Max-Age=0`);
    // …and the bare spelling an earlier release wrote, with the attributes it was written with.
    expect(cleared.find((c) => c.startsWith(`${OWNER_COOKIE}=`)))
      .toBe(`${OWNER_COOKIE}=; SameSite=Strict; Secure; Path=/; Max-Age=0`);
    expect(cleared).toHaveLength(10);
  });
});

/**
 * HOST-ONLY IS AN INVARIANT OF THE FILE, NOT OF ONE COOKIE — every Set-Cookie this module
 * mints, on every path.
 *
 * The session cookie is deliberately host-only: no `Domain=` attribute, so it never reaches
 * any current or future subdomain — the narrowness that made the single-origin merge worth
 * doing, and the one this suite already pins on individual lines. This case states it
 * structurally, because the file publishes with the open server and a self-host operator will
 * read it as the reference for how sessions are minted: whatever new cookie or new path is
 * added here, a `Domain=` attribute anywhere in this module's output is a widening, and it
 * must fail THIS case by name rather than ride out on a line no individual assertion covers.
 *
 * THE MINT LIST IS DERIVED FROM THE MODULE'S OWN EXPORTS, never hand-kept: a hand-typed list
 * covers the mints somebody remembered on the day it was written, which is exactly the mint a
 * later addition is not. Every exported function must have a registered invocation below —
 * an export with none fails this case BY NAME, so a new mint cannot ship without its output
 * joining the sweep (and a non-minting helper gets an explicit empty registration, which is a
 * reviewed decision rather than an omission).
 *
 * Shown red before it was trusted, twice: adding `Domain=ohmail.app; ` to one mint turned the
 * sweep red while the per-line cases stayed green, and exporting a `probeCookies` helper with
 * no registration turned the coverage half red on the export's name alone.
 */
describe("no Set-Cookie this module mints carries Domain=", () => {
  /* Every function export, invoked. `[]` is the explicit "mints nothing" registration
   * (`ownerCookieValue` returns a value, not a Set-Cookie line). */
  const INVOCATIONS: { [name: string]: () => string[] } = {
    sessionCookies: () => [
      ...sessionCookies(TOKENS, "csrf-1", CFG, ACCOUNT),
      ...sessionCookies(TOKENS, "csrf-1", CFG, null),
    ],
    enrollmentCookies: () => enrollmentCookies("enroll-tok", "csrf-2", CFG),
    clearSessionCookies: () => clearSessionCookies(),
    ownerCookieValue: () => [],
    // The marker's own line, minted a second time by `GET /auth/session` when a browser's jar
    // has lost it. Both arms: an id, and the `null` that mints nothing.
    ownerCookie: () => [...ownerCookie(ACCOUNT, CFG), ...ownerCookie(null, CFG)],
    // The resume marker's own clear, answered by the refresh door when there is nothing to rotate.
    clearResumeCookie: () => clearResumeCookie(),
    // Reads a jar in either spelling; returns a value, never a Set-Cookie line.
    jarCookie: () => [],
    // Reads the resume marker a jar presented; returns a value or null, never a Set-Cookie line.
    presentedResumeMarker: () => [],
  };

  it("every exported function is registered — a new mint cannot dodge the sweep", async () => {
    const mod = await import("../src/cookies.js");
    const fnExports = Object.entries(mod)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(fnExports.length, "the module stopped exporting functions — the sweep reads nothing")
      .toBeGreaterThanOrEqual(4);
    const unregistered = fnExports.filter((name) => !(name in INVOCATIONS));
    expect(unregistered, "cookies.ts exports a function this sweep does not invoke — register " +
      "it in INVOCATIONS (with its real arguments if it mints Set-Cookie lines, or [] if it " +
      "provably mints none) so the host-only invariant covers it").toEqual([]);
  });

  it("every mint on every path is host-only", () => {
    const everyLine = Object.values(INVOCATIONS).flatMap((call) => call());
    // The harness bites only if it is reading real output.
    expect(everyLine.length).toBeGreaterThanOrEqual(12);
    for (const line of everyLine) {
      expect(line, `a minted cookie carries Domain= — host-only is the invariant: ${line}`)
        .not.toMatch(/;\s*Domain=/i);
    }
  });
});
