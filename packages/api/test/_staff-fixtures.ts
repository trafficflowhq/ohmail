import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { staffUsers, staffSessions, staffRoleGrants, staffAuditEvents } from "@trafficflow/db/cloud";
import { scryptHasher, generateToken, hashToken, newTotpSecret, type StaffRole } from "@trafficflow/services";
import { eq } from "drizzle-orm";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { makeDeps, FIXED_NOW } from "./helpers.js";

/** The cloud 0047 staff suites' shared harness: one app, one secret, staff with chosen roles. */

export const app = createApp(apiRoutes);
export const SECRET = "admin-console-internal-secret-fixture-token";
export const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };
export const PASSWORD = "staff-console-sign-in-password";

export const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}`, ...headers },
    body: JSON.stringify(body),
  });
}

export function get(path: string, token: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.test${path}`, {
    headers: { Authorization: `Bearer ${SECRET}`, [STAFF_SESSION_HEADER]: token, ...headers },
  });
}

export async function staffDeps(over: Partial<ApiDeps> = {}): Promise<ApiDeps> {
  const { deps } = await makeDeps();
  return { ...deps, admin: ADMIN, ...over } as ApiDeps;
}

export interface Staff { staffId: string; token: string; email: string; totpSecret: string; sessionId: string }

/** A staff member with an activated authenticator, a live session and exactly `roles`. */
export async function seedStaff(
  deps: ApiDeps, o: { email?: string; roles?: readonly StaffRole[]; lastTwofaAt?: Date } = {},
): Promise<Staff> {
  const email = o.email ?? `staff-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const totpSecret = newTotpSecret();
  const sealed = await deps.keyProvider.encrypt(totpSecret);
  const [staff] = await deps.db.insert(staffUsers).values({
    email, passwordHash: await scryptHasher.hash(PASSWORD),
    totpSecretEnc: sealed.ciphertext, totpKeyVersion: sealed.keyVersion, totpActivated: true,
  }).returning();
  const staffId = (staff as { id: string }).id;
  for (const role of o.roles ?? ["owner"]) {
    await deps.db.insert(staffRoleGrants).values({ staffUserId: staffId, role, grantedAt: FIXED_NOW });
  }
  const token = generateToken(32);
  const [session] = await deps.db.insert(staffSessions).values({
    staffUserId: staffId, tokenHash: hashToken(token), createdAt: FIXED_NOW,
    lastTwofaAt: o.lastTwofaAt ?? FIXED_NOW, expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
  }).returning();
  return { staffId, token, email, totpSecret, sessionId: (session as { id: string }).id };
}

export const auditRows = (deps: ApiDeps) => deps.db.select().from(staffAuditEvents);
export const auditRowsFor = (deps: ApiDeps, staffId: string) =>
  deps.db.select().from(staffAuditEvents).where(eq(staffAuditEvents.staffUserId, staffId)).orderBy(staffAuditEvents.at);

/**
 * `deps.db` with every insert into `table` failing — on the handle itself AND on the handle a
 * transaction hands its callback, so a write that inserts inside its transaction meets the
 * fault where production would. `faults.count` proves the fault was reached.
 */
export function failingInsertInto<T extends ApiDeps["db"]>(db: T, table: unknown): { db: T; faults: { count: number } } {
  const faults = { count: 0 };
  const wrap = <D extends object>(target: D): D => new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "insert") {
        return (tbl: unknown) => {
          if (tbl !== table) return (t as unknown as { insert(x: unknown): unknown }).insert(tbl);
          return {
            values: () => {
              faults.count += 1;
              const err = new Error("injected staff audit insert fault");
              return { then: (_ok: unknown, bad: (e: unknown) => void) => bad(err), returning: () => Promise.reject(err) };
            },
          };
        };
      }
      if (prop === "transaction") {
        return (fn: (tx: unknown) => unknown, cfg?: unknown) =>
          (t as unknown as { transaction(f: (tx: object) => unknown, c?: unknown): unknown })
            .transaction((tx: object) => fn(wrap(tx)), cfg);
      }
      return Reflect.get(t, prop, receiver) as unknown;
    },
  });
  return { db: wrap(db), faults };
}
