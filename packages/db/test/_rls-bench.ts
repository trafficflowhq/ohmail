import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";

/**
 * A ROLE AND A SCHEMA OF THE TEST'S OWN on the shared test server, for proofs that need a runtime
 * role and row security: roles are cluster-wide, so each name is fresh; the password is made here
 * and never printed; nothing is owned by the role, and its search path points at the schema, so an
 * unqualified table name in the code under test reads the test's own table.
 */
export interface BenchRole {
  readonly name: string;
  /** The test database's address signed in as this role, at `host:port` when given (a pooler in front). */
  url(at?: string): string;
}

export interface Bench {
  readonly schema: string;
  /** Make a role that owns nothing, searching the bench's schema; `attributes` adds role attributes (BYPASSRLS). */
  role(attributes?: string): Promise<BenchRole>;
  /** Drop the schema and every role made here. */
  drop(): Promise<void>;
}

const fresh = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

export async function rlsBench(admin: postgres.Sql, adminUrl: string): Promise<Bench> {
  const schema = fresh("tf_bound");
  const roles: string[] = [];
  await admin.unsafe(`create schema ${schema}`);
  return {
    schema,
    async role(attributes = "") {
      const name = fresh("tf_bound");
      const password = randomBytes(18).toString("base64url");
      await admin.unsafe(`create role ${name} login password '${password}' nosuperuser nocreatedb nocreaterole `
        + `noreplication noinherit ${attributes}`);
      roles.push(name);
      await admin.unsafe(`grant usage on schema ${schema} to ${name}`);
      await admin.unsafe(`alter role ${name} set search_path = ${schema}`);
      return {
        name,
        url(at?: string): string {
          const u = new URL(adminUrl);
          u.username = name;
          u.password = password;
          if (at !== undefined) u.host = at;
          return u.toString();
        },
      };
    },
    async drop() {
      await admin.unsafe(`drop schema if exists ${schema} cascade`);
      for (const name of roles) await admin.unsafe(`drop role if exists ${name}`);
    },
  };
}
