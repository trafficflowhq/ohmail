import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { SECURITY_NOTICES_CRON_PATH } from "../src/routes/internal.js";
import { makeDeps, req } from "./helpers.js";

/**
 * THE SECURITY-NOTICE DOOR, end to end: twenty-one sign-in failures at one address from clients
 * that never signed in to it, then one poke of the scheduler's door, then exactly one mail to the
 * account's own address — and none from the sign-in requests themselves. The door is the reaper's
 * shape: a shared secret, 404 when the internal surface is unarmed.
 */
const app = createApp(apiRoutes);
const SECRET = "security-notices-internal-secret-fixture-token";
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

function login(email: string, ip: string): Request {
  return new Request("https://api.test/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vercel-forwarded-for": ip },
    body: JSON.stringify({ email, password: "WRONG-password-guess" }),
  });
}
const run = (secret?: string): Request =>
  req("GET", SECURITY_NOTICES_CRON_PATH, secret ? { bearer: secret } : {});

describe("GET /internal/security-notices/run", () => {
  it("is 404 unarmed and 401 without the secret", async () => {
    const { deps } = await makeDeps();
    expect((await H(run(SECRET), { ...deps, alerts: undefined })).status).toBe(404);
    const armed = { ...deps, alerts: { secret: SECRET, sinks: [] } as unknown as ApiDeps["alerts"] };
    expect((await H(run(), armed)).status).toBe(401);
    expect((await H(run("wrong-secret-wrong-secret-wrong"), armed)).status).toBe(401);
  });

  it("from twenty-one failures to one mail, sent by the door and never by a sign-in", async () => {
    const { deps, mailer } = await makeDeps();
    const armed = { ...deps, alerts: { secret: SECRET, sinks: [] } as unknown as ApiDeps["alerts"] };
    const reg = await H(new Request("https://api.test/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "x-vercel-forwarded-for": "10.200.0.1" },
      body: JSON.stringify({ email: "target@example.com", password: "pw-correct-horse-battery-password-password", displayName: "T", inviteCode: "INVITE-OK" }),
    }), armed);
    expect(reg.status).toBeLessThan(300);
    const before = mailer.sent.length;
    const statuses: number[] = [];
    let wait: string | null = null;
    for (let i = 0; i < 21; i++) {
      const r = await H(login("target@example.com", `10.201.0.${i + 1}`), armed);
      statuses.push(r.status);
      wait = r.headers.get("retry-after");
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(wait, "the slowed refusal carries no Retry-After").toMatch(/^[1-9]\d*$/);
    expect(mailer.sent.length, "a sign-in request sent mail").toBe(before);
    const res = await H(run(SECRET), armed);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 1, dropped: 0, failed: 0 });
    const notices = mailer.sent.slice(before).filter((s) => s.template === "security_notice");
    expect(notices.map((s) => s.to)).toEqual(["target@example.com"]);
  });
});
