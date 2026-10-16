import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * A SELF-HOST .env FROM THE MINIO ERA STILL BRINGS THE STACK UP.
 *
 * The store's credential was MINIO_ROOT_USER / MINIO_ROOT_PASSWORD in `.env`, and is now
 * RUSTFS_ROOT_USER / RUSTFS_ROOT_PASSWORD. An operator updates with `git pull && docker compose pull
 * && docker compose up -d` and does not re-read `.env.example`, so a compose that required the new
 * name refused that update at interpolation and every later compose command on the box with it.
 * Every place the compose reads the credential falls back to the old name.
 *
 * Compose interpolates the file before it starts anything, so the interpolation below is the
 * decision: `${A:-x}`, `${A-x}`, `${A:?m}` and `${A?m}`, nested, with `$$` as a literal `$`, the
 * way Compose v2 reads them — INCLUDING its one surprise: a default is resolved before compose
 * looks at the outer name, so a `:?` nested in a default refuses even when the outer name is set
 * (measured on Compose 2.40: `${NEW:-${OLD:?m}}` with only NEW set refuses, naming OLD). The
 * obvious required fallback would therefore refuse every fresh install. The compose falls back
 * without a requirement, and with neither name set the store itself refuses to start.
 */
const at = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const rd = (rel: string) => readFileSync(at(rel), "utf8");
const COMPOSE = "deploy/selfhost/docker-compose.yml";

/** Compose's interpolation of one value. Throws with the `:?` message, as compose refuses. A
 *  default is resolved FIRST, whether or not it is used, as compose-go's template package does. */
function interpolate(s: string, env: Record<string, string | undefined>): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "$") { out += "$"; i++; continue; }
    if (s[i] !== "$" || s[i + 1] !== "{") { out += s[i]; continue; }
    let depth = 0;
    let j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) break;
    }
    if (j >= s.length) throw new Error(`unterminated \${ in ${s}`);
    const inner = s.slice(i + 2, j);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([\s\S]*))?$/.exec(inner);
    if (!m) throw new Error(`not an interpolation: \${${inner}}`);
    const [, name, op, rest = ""] = m;
    const v = env[name!];
    const set = op?.startsWith(":") ? v !== undefined && v !== "" : v !== undefined;
    const fallback = op?.endsWith("-") ? interpolate(rest, env) : "";
    if (!op || set) out += v ?? "";
    else if (op.endsWith("-")) out += fallback;
    else throw new Error(`required variable ${name} is missing a value: ${interpolate(rest, env)}`);
    i = j;
  }
  return out;
}

type Service = { environment?: Record<string, string> };
const services = (parse(rd(COMPOSE)) as { services: Record<string, Service> }).services;

/** Every environment entry in the compose that reads the store credential, by either name. */
const readers = Object.entries(services).flatMap(([svc, s]) =>
  Object.entries(s.environment ?? {})
    .filter(([, v]) => /\b(?:RUSTFS|MINIO)_ROOT_(?:USER|PASSWORD)\b/.test(String(v)))
    .map(([key, v]) => ({ at: `${svc}.${key}`, raw: String(v), secret: /PASSWORD/.test(String(v)) })));

/** The whole stack's value of every credential reader under one .env. */
function resolved(env: Record<string, string | undefined>) {
  return Object.fromEntries(readers.map((r) => [r.at, interpolate(r.raw, env)]));
}

const hex = () => randomBytes(16).toString("hex");

describe("the self-host compose reads the store credential under either name", () => {
  it("finds every reader: the api, the organizer, the store and the bucket init, user and secret", () => {
    expect(readers.map((r) => r.at).sort()).toEqual([
      "api.S3_ACCESS_KEY_ID", "api.S3_SECRET_ACCESS_KEY",
      "organizer.S3_ACCESS_KEY_ID", "organizer.S3_SECRET_ACCESS_KEY",
      "rustfs-init.RUSTFS_ROOT_PASSWORD", "rustfs-init.RUSTFS_ROOT_USER",
      "rustfs.RUSTFS_ACCESS_KEY", "rustfs.RUSTFS_SECRET_KEY",
    ]);
  });

  it("a MinIO-era .env: every reader takes the old values, so the update needs no edit", () => {
    const old = { MINIO_ROOT_PASSWORD: hex(), MINIO_ROOT_USER: "staging-user" };
    for (const r of readers) {
      expect(interpolate(r.raw, old), r.at).toBe(r.secret ? old.MINIO_ROOT_PASSWORD : old.MINIO_ROOT_USER);
    }
  });

  it("a MinIO-era .env that never set the user: the default user, everywhere", () => {
    const old = { MINIO_ROOT_PASSWORD: hex() };
    for (const r of readers.filter((x) => !x.secret)) expect(interpolate(r.raw, old), r.at).toBe("ohmail-staging");
  });

  it("a current .env, and one holding both names: the new names win", () => {
    const now = { RUSTFS_ROOT_PASSWORD: hex(), RUSTFS_ROOT_USER: "new-user" };
    const both = { ...now, MINIO_ROOT_PASSWORD: hex(), MINIO_ROOT_USER: "old-user" };
    for (const env of [now, both]) {
      for (const r of readers) {
        expect(interpolate(r.raw, env), r.at).toBe(r.secret ? now.RUSTFS_ROOT_PASSWORD : now.RUSTFS_ROOT_USER);
      }
    }
  });

  it("the store, the api and the organizer always agree on the credential", () => {
    for (const env of [{ MINIO_ROOT_PASSWORD: hex() }, { RUSTFS_ROOT_PASSWORD: hex(), MINIO_ROOT_PASSWORD: hex() }]) {
      const v = resolved(env);
      expect(new Set(readers.filter((r) => r.secret).map((r) => v[r.at])).size).toBe(1);
      expect(new Set(readers.filter((r) => !r.secret).map((r) => v[r.at])).size).toBe(1);
    }
  });

  it("a current .env that holds only the new names: every reader resolves, nothing refuses", () => {
    const now = { RUSTFS_ROOT_PASSWORD: hex() };
    const want = { user: "ohmail-staging", secret: now.RUSTFS_ROOT_PASSWORD };
    for (const r of readers) {
      expect(() => interpolate(r.raw, now), r.at).not.toThrow();
      expect(interpolate(r.raw, now), r.at).toBe(r.secret ? want.secret : want.user);
    }
  });

  it("no required name hides in a default anywhere in the file: compose would ask for it always", () => {
    const text = rd(COMPOSE);
    const nested = [...text.matchAll(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-[^\n]*\$\{[A-Za-z_][A-Za-z0-9_]*:?\?/g)].map((m) => m[0]);
    expect(nested).toEqual([]);
  });

  it("neither name: the secret resolves empty everywhere, which the store refuses at start", () => {
    for (const env of [{}, { RUSTFS_ROOT_PASSWORD: "" }, { MINIO_ROOT_PASSWORD: "" }]) {
      for (const r of readers.filter((x) => x.secret)) expect(interpolate(r.raw, env), r.at).toBe("");
    }
  });

  it("the interpolation itself: the controls", () => {
    expect(interpolate("${A:-${B:-c}}", {})).toBe("c");
    expect(interpolate("${A:-${B:-c}}", { B: "b" })).toBe("b");
    expect(interpolate("${A:-${B:-c}}", { A: "a", B: "b" })).toBe("a");
    // Compose's eager default: the nested requirement refuses although A is set.
    expect(() => interpolate("${A:-${B:?say B}}", { A: "a" })).toThrow(/say B/);
    expect(interpolate("${A-x}", { A: "" })).toBe("");
    expect(() => interpolate("${A:?say A}", { A: "" })).toThrow(/say A/);
    expect(interpolate("$$A ${A}", { A: "1" })).toBe("$A 1");
  });
});

describe("the boot smoke and the upgrade note", () => {
  const smoke = rd("deploy/selfhost/boot-smoke.mjs");

  it("the boot smoke reads the store credential under either name, the new one first, as compose does", () => {
    // `||`, not `??`: compose's `:-` treats an empty value as unset, and .env.example ships the
    // new name empty.
    expect(smoke).toMatch(/envValues\.RUSTFS_ROOT_PASSWORD \|\| envValues\.MINIO_ROOT_PASSWORD;/);
    expect(smoke).toMatch(/envValues\.RUSTFS_ROOT_USER \|\| envValues\.MINIO_ROOT_USER \|\| "ohmail-staging";/);
  });

  it("the VPS guide's Updates section says, once, what the switch to RustFS leaves behind", () => {
    const vps = rd("docs/self-host/VPS.md");
    const updates = vps.slice(vps.search(/^## 10\. /m));
    const section = updates.slice(0, updates.slice(1).search(/^## /m) + 1 || undefined);
    expect(section).toMatch(/RustFS/);
    expect(section).toMatch(/starts empty/);
    expect(section).toMatch(/docker compose up -d --remove-orphans/);
    expect(section).toMatch(/docker volume rm \S*minio_data/);
  });
});

/**
 * THE UPDATE REACHES THE PROXY. `docker compose up -d` recreates a service only when its own
 * definition changed; a bind-mounted file that changed does not count, and `git pull` replaces
 * routes.caddy with a new file, so a running proxy keeps reading the old one. An update that only
 * renamed the store in routes.caddy left the proxy sending browser uploads to the old store while
 * the api read from the new one: measured on a stack updated from the MinIO release, the boot
 * smoke's upload went through and the download answered 404. The store's address therefore lives
 * in the proxy's environment, which routes.caddy reads, so a change of store recreates the proxy.
 * Any other edit to deploy/selfhost/proxy does as well: test/selfhost-proxy-reload.test.ts.
 */
describe("the proxy's route to the store", () => {
  type Full = { image?: string; environment?: Record<string, string> };
  const all = (parse(rd(COMPOSE)) as { services: Record<string, Full> }).services;
  const routes = rd("deploy/selfhost/proxy/routes.caddy");
  const store = Object.entries(all).find(([, s]) => /\/mirror-rustfs:/.test(s.image ?? ""))?.[0];

  it("is named in the proxy service's own definition, as the store service's address", () => {
    expect(store).toBe("rustfs");
    expect(all.proxy?.environment?.OHMAIL_STAGING_STORE).toBe(`${store}:9000`);
  });

  it("is what routes.caddy dials for the bucket's door, with the same address as its default", () => {
    const door = /@staging path [^\n]*\nhandle @staging \{\n([\s\S]*?)\n\}/.exec(routes)?.[1] ?? "";
    expect(door.trim()).toBe(`reverse_proxy {$OHMAIL_STAGING_STORE:${store}:9000}`);
  });
});
