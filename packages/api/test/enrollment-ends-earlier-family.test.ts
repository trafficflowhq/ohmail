import { describe, expect, it } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import type { AuthConfig } from "@trafficflow/services";
import { clearResumeCookie, clearSessionCookies, enrollmentCookies, OWNER_COOKIE } from "../src/cookies.js";
import { makeDeps, req } from "./helpers.js";

/**
 * AN ENROLLMENT SESSION LEAVES NO EARLIER FAMILY IN THE JAR. The register, verify and zero-factor
 * login answers set `tf_session` and `tf_csrf` and nothing else, so a browser that still held an
 * earlier family's `tf_refresh` and `tf_resume` kept them beside the new session: once it lapsed,
 * the next visit to `/` was sent to the resume splash and the earlier family was renewed. On a
 * shared computer after a sign-out the server never confirmed, that is somebody else's mailbox.
 * The enrollment answer now expires both, with the attributes they were set with, as the sign-out
 * door's clear does; a full sign-in already replaces them with its own.
 */

const CFG = { accessTtlMs: 15 * 60_000, refreshTtlMs: 30 * 86_400_000, loginTokenTtlMs: 300_000 } as unknown as AuthConfig;
const PW = "pw-correct-horse";
const app = createApp(apiRoutes);
const post = (deps: ApiDeps, path: string, body: unknown, cookie?: string): Promise<Response> =>
  app.handle(req("POST", path, { body: JSON.stringify(body), ...(cookie ? { cookie } : {}) }), { ...deps, session: null, idempotency: null });

const line = (lines: readonly string[], name: string): string | undefined => lines.find((l) => l.startsWith(`${name}=`));
/* Both spellings of each: the bare one an earlier release wrote, and the `__Host-` one. */
const REFRESH_CLEAR = line(clearSessionCookies(), "tf_refresh")!;
const RESUME_CLEAR = line(clearResumeCookie(), "tf_resume")!;
const HOST_REFRESH_CLEAR = line(clearSessionCookies(), "__Host-tf_refresh")!;
const HOST_RESUME_CLEAR = line(clearResumeCookie(), "__Host-tf_resume")!;

describe("the enrollment cookies expire the jar's earlier refresh cookie and resume marker", () => {
  it("both clears, byte for byte the sign-out door's, and no owner marker", () => {
    const lines = enrollmentCookies("enrol-token", "csrf-1", CFG);
    expect(line(lines, "tf_refresh"), "an earlier family's refresh cookie outlives the enrollment session").toBe(REFRESH_CLEAR);
    expect(line(lines, "tf_resume"), "an earlier family's resume marker outlives the enrollment session").toBe(RESUME_CLEAR);
    expect(line(lines, "__Host-tf_refresh")).toBe(HOST_REFRESH_CLEAR);
    expect(line(lines, "__Host-tf_resume")).toBe(HOST_RESUME_CLEAR);
    // THE CONTROL: the clears are the right cookies, at the path the browser holds them on.
    expect(REFRESH_CLEAR).toContain("Path=/auth/refresh");
    expect(REFRESH_CLEAR).toContain("Max-Age=0");
    expect(RESUME_CLEAR).toContain("Max-Age=0");
    // …and the session itself is still minted, and still names no mailbox.
    expect(line(lines, "__Host-tf_session")).toContain("__Host-tf_session=enrol-token;");
    expect(line(lines, OWNER_COOKIE)).toBeUndefined();
  });
});

describe("through the routes that mint an enrollment session", () => {
  it("register, then the zero-factor sign-in over a jar that still holds an earlier family", async () => {
    const { deps } = await makeDeps();
    const registered = await post(deps, "/auth/register",
      { email: "b@x.example", password: PW, displayName: "B", inviteCode: "INVITE-OK" });
    expect(registered.status, "B must exist with no enrolled factor").toBe(201);
    expect(registered.headers.getSetCookie()).toEqual(expect.arrayContaining([REFRESH_CLEAR, RESUME_CLEAR, HOST_REFRESH_CLEAR, HOST_RESUME_CLEAR]));

    const earlier = "tf_refresh=an-earlier-family; tf_resume=1; tf_owner=signed_out_pending";
    const signedIn = await post(deps, "/auth/login", { email: "b@x.example", password: PW }, earlier);
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json() as { status: string }).status, "the zero-factor re-entry arm").toBe("enrollment");
    const set = signedIn.headers.getSetCookie();
    expect(set, "the earlier family's cookies stay beside the enrollment session").toEqual(
      expect.arrayContaining([REFRESH_CLEAR, RESUME_CLEAR, HOST_REFRESH_CLEAR, HOST_RESUME_CLEAR]),
    );
    expect(set.some((l) => l.startsWith("__Host-tf_session=") && !l.includes("Max-Age=0")), "no enrollment session was minted").toBe(true);
  });
});
