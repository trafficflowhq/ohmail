import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE TEST BOX'S /dev/shm IS AT LEAST 1 GiB, AND THE COMPOSE FILE IS WHAT SAYS SO.
// Postgres keeps its dynamic shared memory in /dev/shm: the cumulative statistics of every lane
// database on the box and each parallel query's segment. Docker's default is 64 MB; with the box's
// many databases it was nearly full and a parallel query failed "could not resize shared memory segment
// … No space left on device". A container recreated by hand is gone at the next bare
// `docker compose up -d`, so the setting lives in the file and this reads it with a YAML parser.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FLOOR = 1024 ** 3;

// No workspace package declares a YAML parser; the root devDependency @playwright/test carries
// the `yaml` package inside playwright-core, exported as `./lib/utilsBundle`. A bump that drops it
// fails this file at import, never green.
function yamlParse(): (src: string) => unknown {
  const root = createRequire(join(ROOT, "package.json"));
  const pwTest = createRequire(root.resolve("@playwright/test/package.json"));
  const pw = createRequire(pwTest.resolve("playwright/package.json"));
  const parse = (pw("playwright-core/lib/utilsBundle") as { yaml?: { parse?: unknown } }).yaml?.parse;
  if (typeof parse !== "function") throw new Error("playwright-core/lib/utilsBundle no longer exports yaml.parse");
  return parse as (src: string) => unknown;
}

// A size as Docker reads it (go-units RAMInBytes): binary units, optional `i`/`b`, bare = bytes.
function bytesOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const m = /^(\d+(?:\.\d+)?) ?([kmgtp])?i?b?$/i.exec(v.trim());
  if (!m) return null;
  const power = m[2] ? "kmgtp".indexOf(m[2].toLowerCase()) + 1 : 0;
  return Math.floor(Number(m[1]) * 1024 ** power);
}

type Service = Record<string, unknown>;
const parse = yamlParse();
const compose = parse(readFileSync(join(ROOT, "docker-compose.yml"), "utf8")) as { services?: Record<string, Service> };

describe("the :5433 test box gets a /dev/shm big enough for its statistics", () => {
  it("the parser reads the file's services, and the box among them", () => {
    const names = Object.keys(compose.services ?? {});
    expect(names, "no services parsed out of the root docker-compose.yml").toEqual(expect.arrayContaining(["db", "greenmail", "minio"]));
    expect(compose.services?.db?.image, "the db service is not the Postgres box").toMatch(/^(?:ghcr\.io\/trafficflowhq\/mirror-)?postgres:/);
    expect(compose.services?.db?.ports, "the db service does not publish :5433").toEqual([expect.stringMatching(/:5433:5432$/)]);
  });

  it("the db service's shm_size is at least 1 GiB", () => {
    const raw = compose.services?.db?.shm_size;
    expect(raw, "the db service sets no shm_size: Docker gives it 64 MB").toBeDefined();
    const bytes = bytesOf(raw);
    expect(bytes, `shm_size ${JSON.stringify(raw)} is not a size Docker reads`).not.toBeNull();
    expect(bytes!, `shm_size ${JSON.stringify(raw)} is below 1 GiB`).toBeGreaterThanOrEqual(FLOOR);
  });

  it("the size reader agrees with Docker's units, and refuses the default that failed", () => {
    expect(bytesOf("1g")).toBe(FLOOR);
    expect(bytesOf("1024m")).toBe(FLOOR);
    expect(bytesOf("1GiB")).toBe(FLOOR);
    expect(bytesOf("1gb")).toBe(FLOOR);
    expect(bytesOf(FLOOR)).toBe(FLOOR);
    expect(bytesOf("64m")!).toBeLessThan(FLOOR);
    expect(bytesOf("1023m")!).toBeLessThan(FLOOR);
    expect(bytesOf("a lot")).toBeNull();
    expect(bytesOf(undefined)).toBeNull();
    expect((parse('services:\n  db:\n    shm_size: "2g"\n') as { services: Record<string, Service> }).services.db.shm_size).toBe("2g");
  });
});
