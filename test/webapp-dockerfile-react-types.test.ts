import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * THE TYPE PASSES INSTALL WHAT THIS REPOSITORY'S OWN TYPECHECK RESOLVES. The self-host web image and the
 * engine job each install their TypeScript and @types by LITERAL after `npm ci`, because the manifests
 * they build from do not declare them. A literal that is not the lockfile's resolution checks the source
 * against a compiler or a declaration set nothing here ran (the engine job was on 5.6 while the workspace
 * ran 5.9), and a range there moves a locked package under the bundle. So every pin on those two lines is
 * the lockfile's version for that name: the root's own copy, else the one version any package installs.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");
type NpmLock = { packages: Record<string, { version?: string }> };
const lock = JSON.parse(read("../package-lock.json")) as NpmLock;

/** The lockfile's version for a name, or why there is none that one literal could state. */
function lockVersion(name: string): string {
  const own = lock.packages[`node_modules/${name}`]?.version;
  if (own) return own;
  const vs = [...new Set(Object.entries(lock.packages)
    .filter(([path, e]) => path.endsWith(`/node_modules/${name}`) && e.version)
    .map(([, e]) => e.version!))].sort();
  return vs.length === 1 ? vs[0]! : `(${vs.length} versions: ${vs.join(",")})`;
}

/** The `name@version` pins of one install command, continuation lines joined, and each one's verdict. */
function typePins(text: string, marker: RegExp): { pin: string; want: string }[] {
  const joined = text.replace(/\\\n\s*/g, " ");
  const line = joined.split("\n").find((l) => marker.test(l));
  expect(line, `no install line matches ${marker}`).toBeDefined();
  return [...line!.matchAll(/\s((?:@[a-z0-9.-]+\/)?[a-z0-9.-]+)@(\S+)/g)].map((m) => ({ pin: `${m[1]}@${m[2]}`, want: `${m[1]}@${lockVersion(m[1]!)}` }));
}
const offenders = (pins: { pin: string; want: string }[]) => pins.filter((p) => p.pin !== p.want).map((p) => `${p.pin} (lock: ${p.want})`);

const DOCKERFILE_MARKER = /^RUN npm install --no-save\b/;
const SITES: [string, () => string, RegExp, number][] = [
  ["apps/webapp/Dockerfile", () => read("../apps/webapp/Dockerfile"), DOCKERFILE_MARKER, 4],
  ["the engine job", () => readFileSync(publicPath("github/workflows/build.yml"), "utf8"), /retry-infra\.sh" npm-network -- npm install --no-save\b/, 5],
];

describe("the post-install type passes pin the lockfile's own resolution", () => {
  it.each(SITES)("%s", (_what, text, marker, count) => {
    const pins = typePins(text(), marker);
    expect(pins.length, `the install line names ${pins.length} pins`).toBe(count);
    expect(offenders(pins)).toEqual([]);
  });

  it("refuses a pin that drifted from the lockfile, and a range", () => {
    // Planted from the lockfile's own versions, so the control moves with every bump.
    const ts = lockVersion("typescript");
    const node = lockVersion("@types/node");
    const text = read("../apps/webapp/Dockerfile")
      .replace(`@types/node@${node} `, "@types/node@0.0.1 ")
      .replace(`typescript@${ts} `, "typescript@^5.0.0 ");
    expect(offenders(typePins(text, DOCKERFILE_MARKER))).toEqual([
      `typescript@^5.0.0 (lock: typescript@${ts})`,
      `@types/node@0.0.1 (lock: @types/node@${node})`,
    ]);
  });
});
