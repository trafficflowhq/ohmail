import { describe, it, expect } from "vitest";
import { managedAddress } from "../../../test/support/fixture-credentials.js";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { staffUsers, staffSessions, staffAuditLog, authThrottle } from "@trafficflow/db/cloud";
import { scryptHasher, totpNow } from "@trafficflow/services";
import { eq } from "drizzle-orm";
import { makeDeps } from "./helpers.js";

/**
 * AN ENROLMENT IN PROGRESS NEVER TOUCHES THE AUTHENTICATOR CURRENTLY IN USE.
 *
 * Two tabs, both authorised. Tab A confirms its authenticator. Tab B's `begin` arrives late and
 * its response is lost — the tab was closed, the connection dropped. Nobody holds B's secret, and
 * if `begin` wrote it over the ACTIVE one the operator is locked out of their own console with no
 * recovery through it: the way back is database intervention.
 */

const app = createApp(apiRoutes);
const SECRET = "admin-enrollment-console-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };
const EMAIL = managedAddress("fixture.ops");
const PASSWORD = "admin-staff-enrollment-fixture-password";
const MINUTE = 60_000;

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

function post(path: string, body: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
}

async function world() {
  const { deps: base, clock } = await makeDeps();
  const deps = { ...base, admin: ADMIN } as ApiDeps;
  await deps.db.insert(staffUsers).values({
    email: EMAIL, passwordHash: await scryptHasher.hash(PASSWORD),
  });
  return { deps, clock };
}

const body = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** Password ⇒ the short unprivileged enrolment token. */
async function enrollToken(deps: ApiDeps): Promise<string> {
  const res = await H(post("/admin/staff/session", { email: EMAIL, password: PASSWORD }), deps);
  const out = await body(res);
  expect(out.status).toBe("enrollment_required");
  return out.enrollToken as string;
}

describe("a second enrolment never disturbs the authenticator in use", () => {
  it("shares the password limit between both replacement actions", async () => {
    const { deps, clock } = await world();
    const grant = await enrollToken(deps);
    const began = await body(await H(post("/admin/staff/totp/begin", { enrollToken: grant }), deps));
    clock.advance(MINUTE);
    const confirmed = await body(await H(post("/admin/staff/totp/confirm", {
      enrollToken: grant, code: totpNow(began.secret as string, deps.now()),
    }), deps));
    expect(confirmed.status).toBe("signed_in");
    const sessionToken = confirmed.token as string;
    const [original] = await deps.db.select().from(staffSessions);

    for (const route of ["begin", "confirm", "begin", "confirm", "begin"]) {
      const refused = await H(post(`/admin/staff/totp/${route}`, { sessionToken, password: `${PASSWORD}-typo` }), deps);
      expect(refused.status).toBe(401);
    }
    const blocked = await H(post("/admin/staff/totp/begin", { sessionToken, password: PASSWORD }), deps);
    expect(blocked.status).toBe(429);

    clock.advance(16 * MINUTE);
    const retry = await H(post("/admin/staff/totp/begin", { sessionToken, password: PASSWORD }), deps);
    expect(retry.status).toBe(200);
    const replacement = await body(retry);
    const done = await H(post("/admin/staff/totp/confirm", {
      sessionToken, password: PASSWORD, code: totpNow(replacement.secret as string, deps.now()),
    }), deps);
    expect((await body(done)).status).toBe("reenrolled");
    const [current] = await deps.db.select().from(staffSessions);
    expect(current!.expiresAt).toEqual(original!.expiresAt);
  });

  it("leaves A's codes working when B's begin is abandoned", async () => {
    const { deps, clock } = await world();

    // Tab A: begin, then confirm. From here on, A's authenticator is the live one.
    const a = await body(await H(post("/admin/staff/totp/begin", { enrollToken: await enrollToken(deps) }), deps));
    clock.advance(MINUTE);
    const confirmed = await body(await H(post("/admin/staff/totp/confirm", {
      enrollToken: await enrollToken(deps), code: totpNow(a.secret as string, deps.now()),
    }), deps));
    expect(confirmed.status).toBe("signed_in");
    const session = confirmed.token as string;

    // Tab B: a begin that arrives after A's confirmation, and whose response nobody receives.
    clock.advance(MINUTE);
    const late = await H(post("/admin/staff/totp/begin", { sessionToken: session, password: PASSWORD }), deps);
    expect(late.status).toBe(200);

    // A's authenticator is the one this operator holds, and it still signs them in.
    clock.advance(MINUTE);
    const signIn = await body(await H(post("/admin/staff/session", {
      email: EMAIL, password: PASSWORD, code: totpNow(a.secret as string, deps.now()),
    }), deps));
    expect(signIn.status).toBe("signed_in");

    // And the row is coherent: activated, against the secret the operator actually has.
    const [row] = await deps.db.select().from(staffUsers).where(eq(staffUsers.email, EMAIL));
    expect(row!.totpActivated).toBe(true);
  });

  it("replaces the authenticator when the second enrolment IS confirmed (the positive control)", async () => {
    const { deps, clock } = await world();

    const a = await body(await H(post("/admin/staff/totp/begin", { enrollToken: await enrollToken(deps) }), deps));
    clock.advance(MINUTE);
    const confirmed = await body(await H(post("/admin/staff/totp/confirm", {
      enrollToken: await enrollToken(deps), code: totpNow(a.secret as string, deps.now()),
    }), deps));
    const session = confirmed.token as string;

    clock.advance(MINUTE);
    const b = await body(await H(post("/admin/staff/totp/begin", { sessionToken: session, password: PASSWORD }), deps));
    clock.advance(MINUTE);
    const reenrolled = await body(await H(post("/admin/staff/totp/confirm", {
      sessionToken: session, password: PASSWORD, code: totpNow(b.secret as string, deps.now()),
    }), deps));
    expect(reenrolled.status).toBe("reenrolled");

    clock.advance(MINUTE);
    const withB = await body(await H(post("/admin/staff/session", {
      email: EMAIL, password: PASSWORD, code: totpNow(b.secret as string, deps.now()),
    }), deps));
    expect(withB.status).toBe("signed_in");

    clock.advance(MINUTE);
    const withA = await body(await H(post("/admin/staff/session", {
      email: EMAIL, password: PASSWORD, code: totpNow(a.secret as string, deps.now()),
    }), deps));
    expect(withA.status).toBe("invalid");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The recovery — an operator command, not a console button
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * People are in the locked-out state TODAY, put there by the defect above, and their way back was
 * SQL on the hosted service. `POST /admin/staff/totp/reset` is the supported way back: it returns a named
 * staff member to "not enrolled", revokes their live sessions and leaves a `staff_audit_log` row.
 *
 * What it deliberately is NOT: access. Its authority is the deployment's shared secret — held by
 * whoever operates the service — and after it runs, signing in still costs the PASSWORD and then
 * a fresh enrolment. An operator command drives it; the runbook has the
 * procedure.
 */
const RESET = {
  confirm: "reset-second-factor",
  operator: "the on-call operator",
  note: "lost the phone, confirmed by video call",
} as const;

describe("the second-factor recovery an operator runs", () => {
  it("leaves the sign-in budget intact after a superseded enrollment is refused", async () => {
    const { deps, clock } = await world();
    const grant = await enrollToken(deps);
    const began = await body(await H(post("/admin/staff/totp/begin", { enrollToken: grant }), deps));
    clock.advance(MINUTE);
    const confirmed = await H(post("/admin/staff/totp/confirm", {
      enrollToken: grant, code: totpNow(began.secret as string, deps.now()),
    }), deps);
    expect(confirmed.status).toBe(200);

    const expectBudgetUnchanged = async () => {
      const before = await deps.db.select().from(authThrottle);
      const response = await H(post("/admin/staff/totp/confirm", { enrollToken: grant }), deps);
      expect(response.status).toBe(401);
      expect(await deps.db.select().from(authThrottle)).toEqual(before);
    };
    await expectBudgetUnchanged();
    expect((await H(post("/admin/staff/totp/reset", { ...RESET, email: EMAIL }), deps)).status).toBe(200);
    await expectBudgetUnchanged();
    const fresh = await enrollToken(deps);
    const reopened = await body(await H(post("/admin/staff/totp/begin", { enrollToken: fresh }), deps));
    clock.advance(MINUTE);
    const signedIn = await body(await H(post("/admin/staff/totp/confirm", {
      enrollToken: fresh, code: totpNow(reopened.secret as string, deps.now()),
    }), deps));
    expect(signedIn.status).toBe("signed_in");
  });

  it("issues a different enrollment grant after recovery even in the same second", async () => {
    const { deps } = await world();
    const before = await enrollToken(deps);
    expect((await H(post("/admin/staff/totp/reset", { ...RESET, email: EMAIL }), deps)).status).toBe(200);
    expect((await enrollToken(deps)) === before).toBe(false);
  });

  it("returns the operator to not-enrolled, revokes their sessions and records the act", async () => {
    const { deps, clock } = await world();
    const a = await body(await H(post("/admin/staff/totp/begin", { enrollToken: await enrollToken(deps) }), deps));
    clock.advance(MINUTE);
    const confirmed = await body(await H(post("/admin/staff/totp/confirm", {
      enrollToken: await enrollToken(deps), code: totpNow(a.secret as string, deps.now()),
    }), deps));
    expect(confirmed.status).toBe("signed_in");

    clock.advance(MINUTE);
    const reset = await H(post("/admin/staff/totp/reset", { ...RESET, email: EMAIL }), deps);
    expect(reset.status).toBe(200);
    expect((await body(reset)).sessionsRevoked).toBe(1);

    const [row] = await deps.db.select().from(staffUsers).where(eq(staffUsers.email, EMAIL));
    expect(row!.totpActivated).toBe(false);
    expect(row!.totpSecretEnc).toBeNull();
    expect(row!.totpPendingSecretEnc).toBeNull();
    expect(row!.totpLastConsumedStep).toBeNull();

    const [session] = await deps.db.select().from(staffSessions);
    expect(session!.revokedAt).not.toBeNull();

    const [audit] = await deps.db.select().from(staffAuditLog);
    expect(audit!.action).toBe("staff.totp.reset");
    expect(audit!.actor).toBe(RESET.operator);
    expect(audit!.note).toBe(RESET.note);
  });

  it("grants nothing: the password is still the price of the next sign-in", async () => {
    const { deps, clock } = await world();
    const a = await body(await H(post("/admin/staff/totp/begin", { enrollToken: await enrollToken(deps) }), deps));
    clock.advance(MINUTE);
    await H(post("/admin/staff/totp/confirm", {
      enrollToken: await enrollToken(deps), code: totpNow(a.secret as string, deps.now()),
    }), deps);
    await H(post("/admin/staff/totp/reset", { ...RESET, email: EMAIL }), deps);

    clock.advance(MINUTE);
    const wrong = await H(post("/admin/staff/session", { email: EMAIL, password: "not the password" }), deps);
    expect(wrong.status).toBe(401);

    // And with the right password the operator is back at enrolment, not signed in.
    const right = await body(await H(post("/admin/staff/session", { email: EMAIL, password: PASSWORD }), deps));
    expect(right.status).toBe("enrollment_required");
  });

  it("completes the loop: the recovered operator enrols again and signs in", async () => {
    const { deps, clock } = await world();
    const a = await body(await H(post("/admin/staff/totp/begin", { enrollToken: await enrollToken(deps) }), deps));
    clock.advance(MINUTE);
    await H(post("/admin/staff/totp/confirm", {
      enrollToken: await enrollToken(deps), code: totpNow(a.secret as string, deps.now()),
    }), deps);
    await H(post("/admin/staff/totp/reset", { ...RESET, email: EMAIL }), deps);

    clock.advance(MINUTE);
    const fresh = await body(await H(post("/admin/staff/totp/begin", { enrollToken: await enrollToken(deps) }), deps));
    clock.advance(MINUTE);
    const back = await body(await H(post("/admin/staff/totp/confirm", {
      enrollToken: await enrollToken(deps), code: totpNow(fresh.secret as string, deps.now()),
    }), deps));
    expect(back.status).toBe("signed_in");
  });

  it("refuses without the typed confirmation, a reason, an operator or a known address — and writes nothing", async () => {
    const { deps } = await world();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...RESET, email: EMAIL, confirm: "" }, "confirm_required"],
      [{ ...RESET, email: EMAIL, confirm: "yes" }, "confirm_required"],
      [{ ...RESET, email: EMAIL, operator: "me" }, "operator_required"],
      [{ ...RESET, email: EMAIL, note: "lost" }, "note_required"],
      [{ ...RESET, email: "" }, "email_required"],
      [{ ...RESET, email: managedAddress("fixture.somebody") }, "staff_not_found"],
    ];
    for (const [payload, expected] of cases) {
      const res = await H(post("/admin/staff/totp/reset", payload), deps);
      expect(res.status, expected).toBeGreaterThanOrEqual(400);
      expect(((await body(res)) as { error?: { code?: string } }).error?.code).toBe(expected);
    }
    expect(await deps.db.select().from(staffAuditLog)).toHaveLength(0);
  });

  it("is 401 without the shared secret and 404 on a host with no admin surface", async () => {
    const { deps } = await world();
    const noSecret = new Request("https://api.test/admin/staff/totp/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...RESET, email: EMAIL }),
    });
    expect((await H(noSecret, deps)).status).toBe(401);

    const { deps: bare } = await makeDeps();
    expect((await H(post("/admin/staff/totp/reset", { ...RESET, email: EMAIL }), bare)).status).toBe(404);
  });
});
