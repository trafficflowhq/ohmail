import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import postgres from "postgres";
import {
  MIGRATOR_ROLE, ownServersAvailable, pgTestUrl, startLockGround, type LockGround,
} from "../src/testing.js";
import { createPolicyStatement } from "../src/row-security/apply.js";
import { API_ROLE, LOCK_READERS, WORKER_ROLE, readerStatement } from "../src/row-security/names.js";
import { policyList } from "../src/row-security/policies.js";
import { rlsBench } from "./_rls-bench.js";

type RuntimeRole = typeof API_ROLE | typeof WORKER_ROLE;
const useFarmDatabase = () => process.env.TF_MAIL_QUERY_FARM === "1";

export function lockedQueryGroundAvailable(file: string): boolean {
  return useFarmDatabase() || ownServersAvailable(file);
}

export interface LockedQueryGround {
  readonly docker?: LockGround;
  readonly ownerUrl: string;
  readonly runtimeUrl: string;
  close(): Promise<void>;
}

export async function startLockedQueryGround(
  file: string, database: string, runtimeRole: RuntimeRole,
): Promise<LockedQueryGround> {
  if (useFarmDatabase()) return startFarmGround(file, runtimeRole);
  const docker = await startLockGround(17, database, database);
  try {
    await docker.setup(database);
    await docker.makeRoles(database);
    execFileSync(process.execPath, [
      "--conditions=ohmail-source", "--import=tsx", "packages/db/src/setup-prod-cli.ts", "--lock",
    ], {
      cwd: resolve(import.meta.dirname, "../../.."),
      env: { DATABASE_URL_SESSION: docker.urlAs(database, MIGRATOR_ROLE), TF_PROD_DB_HOST: "127.0.0.1" },
      stdio: "pipe",
    });
    await docker.runRolesScript(database);
    return {
      docker,
      ownerUrl: docker.urlAs(database, MIGRATOR_ROLE),
      runtimeUrl: docker.urlAs(database, runtimeRole),
      async close() { docker.stop(); },
    };
  } catch (error) {
    docker.stop();
    throw error;
  }
}

/** The farm can use PostgreSQL but cannot start Docker inside a slot's sandbox. */
async function startFarmGround(file: string, runtimeRole: RuntimeRole): Promise<LockedQueryGround> {
  const ownerUrl = pgTestUrl(file);
  const target = new URL(ownerUrl);
  if (!["localhost", "127.0.0.1"].includes(target.hostname)
      || !/^\/trafficflow_l_[a-f0-9]{12}$/.test(target.pathname)) {
    throw new Error("the locked query test needs a fresh isolated farm database");
  }
  const admin = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const bench = await rlsBench(admin, ownerUrl);
  const role = await bench.role();
  const policies = policyList().filter((row) => row.roles.includes(runtimeRole));
  const locked: string[] = [];
  const installed: typeof policies = [];
  let readers = false;
  const close = async () => {
    try {
      for (const policy of installed) {
        await admin.unsafe(`drop policy "${policy.name}" on public."${policy.table}"`);
      }
      await admin.unsafe(`drop owned by ${role.name}`);
      for (const table of locked) {
        await admin.unsafe(`alter table public."${table}" no force row level security, disable row level security`);
      }
      if (readers) await admin.unsafe("drop schema ohmail cascade");
      await bench.drop();
    } finally {
      await admin.end({ timeout: 2 });
    }
  };
  try {
    await admin.unsafe(`alter role ${role.name} set search_path = public`);
    await admin.unsafe("create schema ohmail");
    readers = true;
    for (const reader of LOCK_READERS) await admin.unsafe(readerStatement(reader));
    await admin.unsafe(`grant usage on schema public, ohmail to ${role.name}`);
    await admin.unsafe(`grant select on all tables in schema public to ${role.name}`);
    for (const table of new Set(policies.map(({ table }) => table))) {
      await admin.unsafe(`alter table public."${table}" enable row level security, force row level security`);
      locked.push(table);
    }
    for (const policy of policies) {
      await admin.unsafe(
        createPolicyStatement({ ...policy, roles: [runtimeRole] }).replace(`"${runtimeRole}"`, `"${role.name}"`),
      );
      installed.push(policy);
    }
    if (runtimeRole === WORKER_ROLE) {
      await admin.unsafe(`grant insert, update on change_log, account_sync_state to ${role.name}`);
    }
    return { ownerUrl, runtimeUrl: role.url(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
