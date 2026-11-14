import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_COOKIE } from "@ohmail/app-logic/storage/owner-cookie";
import ohmail, { isDoorFile, OWNER_MARKER_NAME } from "../../tools/eslint-plugin-ohmail/index.mjs";
import {
  borderVerdict,
  declaredVerdict,
  loadWorkspace,
} from "../../tools/eslint-plugin-ohmail/workspace.mjs";
import { linterConfig, otherLinterConfigs, runEslint } from "../../tools/lib/findings.mjs";
import type { Borders } from "../../tools/lib/table.mjs";

/** A small product: two packages with rows, a types-only pair, two apps and a test package. */
const borders: Borders = {
  packages: {
    tokens: { imports: [] },
    ui: { imports: ["tokens"] },
    engine: { imports: [] },
    app: { imports: ["ui"], typesOnly: ["engine"] },
    testing: { imports: "*" },
  },
  apps: { web: { never: ["testing"] }, server: {}, door: { apps: ["server"] } },
  tests: { alsoImport: ["testing"] },
  roots: { folders: ["test", "scripts"] },
};
const manifests = {
  ".": { name: "root", devDependencies: { vitest: "1", "@types/estree": "1" } },
  "packages/tokens": { name: "@x/tokens" },
  "packages/ui": {
    name: "@x/ui",
    dependencies: { "@x/tokens": "*", react: "19" },
    devDependencies: { "@x/testing": "*" },
  },
  "packages/engine": { name: "@x/engine" },
  "packages/app": { name: "@x/app", dependencies: { "@x/ui": "*", "@x/engine": "*" } },
  "packages/testing": { name: "@x/testing" },
  "packages/stray": { name: "@x/stray" },
  "apps/web": { name: "@x/web", dependencies: { "@x/ui": "*" } },
  "apps/server": { name: "@x/server" },
  "apps/door": { name: "@x/door", dependencies: { "@x/server": "*" } },
};
const workspace = loadWorkspace("/repo", { borders, manifests });
const value = { typeOnly: false };
const border = (file: string, source: string, how = value) =>
  borderVerdict(workspace, `/repo/${file}`, source, how);
const declared = (file: string, source: string, how = value) =>
  declaredVerdict(workspace, `/repo/${file}`, source, how);

describe("the import borders", () => {
  it("lets a package import what its row names, its own files and what is not ours", () => {
    expect(border("packages/ui/src/Button.tsx", "@x/tokens")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "@x/tokens/css")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "./icons.js")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "react")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "node:path")).toBeNull();
  });

  it("refuses a package its row does not name, by name and by path", () => {
    expect(border("packages/ui/src/Button.tsx", "@x/engine")).toBe(
      "packages/ui imports engine; its row names tokens",
    );
    expect(border("packages/ui/src/Button.tsx", "../../engine/src/index.js")).toBe(
      "packages/ui imports engine by path; its row names tokens",
    );
    expect(border("packages/tokens/src/index.ts", "@x/ui")).toBe(
      "packages/tokens imports ui; its row names nothing",
    );
  });

  it("takes a types-only package as a type and refuses its values", () => {
    expect(border("packages/app/src/frame.tsx", "@x/engine", { typeOnly: true })).toBeNull();
    expect(border("packages/app/src/frame.tsx", "@x/engine")).toMatch(
      /imports a value of engine; its row allows types only/,
    );
  });

  it("gives a test its package's row plus the test package, and no more", () => {
    expect(border("packages/ui/test/button.test.tsx", "@x/testing")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "@x/testing")).toMatch(/imports testing/);
    expect(border("packages/ui/test/button.test.tsx", "@x/engine")).toMatch(/imports engine/);
    expect(border("apps/web/test/shell.test.tsx", "@x/testing")).toBeNull();
    expect(border("apps/web/app/shell.tsx", "@x/testing")).toBe(
      "apps/web imports testing; its row refuses testing",
    );
  });

  it("never lets an app or a package import an app, but for the one row that names it", () => {
    expect(border("apps/web/app/shell.tsx", "../../server/src/index.js")).toMatch(
      /imports the app apps\/server by path; an app is never imported/,
    );
    expect(border("packages/ui/src/Button.tsx", "@x/web")).toMatch(/imports the app apps\/web/);
    expect(border("apps/door/src/handler.ts", "@x/server")).toBeNull();
  });

  it("refuses a package that has no row, and lets the repository's own checks import anything", () => {
    expect(border("apps/web/app/shell.tsx", "@x/stray")).toBe(
      "apps/web imports packages/stray, which has no row in tools/borders.json",
    );
    expect(border("test/lockfile.test.ts", "../apps/server/src/index.js")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "../../../scripts/build.mjs")).toMatch(
      /source imports only packages/,
    );
    expect(border("packages/ui/test/button.test.tsx", "../../../test/support/world.ts")).toBeNull();
  });
});

describe("the manifest", () => {
  it("passes what the manifest declares, and a builtin", () => {
    expect(declared("packages/ui/src/Button.tsx", "react")).toBeNull();
    expect(declared("packages/ui/src/Button.tsx", "react/jsx-runtime")).toBeNull();
    expect(declared("packages/ui/src/Button.tsx", "node:fs")).toBeNull();
  });

  it("refuses what resolves only because something else installed it", () => {
    expect(declared("packages/ui/src/Button.tsx", "lodash")).toBe(
      "lodash is not declared in packages/ui/package.json",
    );
    expect(declared("apps/web/app/shell.tsx", "@x/engine")).toBe(
      "@x/engine is not declared in apps/web/package.json",
    );
    expect(declared("apps/web/app/shell.tsx", "../../../packages/engine/src/index.js")).toMatch(
      /@x\/engine is not declared/,
    );
  });

  it("takes a development dependency for a test, a tool's config and a type, never for shipped code", () => {
    expect(declared("packages/ui/test/button.test.tsx", "vitest")).toBeNull();
    expect(declared("packages/ui/vitest.config.ts", "vitest")).toBeNull();
    expect(declared("packages/ui/src/Button.tsx", "vitest")).toMatch(/vitest is not declared/);
    expect(declared("packages/ui/src/tree.ts", "estree", { typeOnly: true })).toBeNull();
    expect(declared("packages/ui/src/tree.ts", "estree")).toMatch(/estree is not declared/);
  });

  it("leaves an import alone that the border check already refuses", () => {
    expect(border("packages/ui/src/Button.tsx", "@x/engine")).not.toBeNull();
    expect(declared("packages/ui/src/Button.tsx", "@x/engine")).toBeNull();
  });
});

describe("the lint rules, run on source text", () => {
  const lint = (
    rule: string,
    code: string,
    options: unknown[] = [],
    filename = "/repo/packages/core/src/a.ts",
  ) => {
    const linter = new Linter({ configType: "flat", cwd: "/repo" });
    const config: Linter.Config = {
      files: ["**/*.ts"],
      languageOptions: { parser: tseslint.parser as Linter.Parser },
      plugins: { ohmail },
      rules: { [`ohmail/${rule}`]: ["error", ...options] as Linter.RuleEntry },
    };
    const messages = linter.verify(code, [config], { filename });
    return messages
      .filter((message) => message.ruleId === `ohmail/${rule}`)
      .map((message) => message.message);
  };
  const platforms = [
    { id: "vercel", packages: ["vercel", "@vercel"], names: ["VERCEL_", "NEXT_PUBLIC_VERCEL_"] },
    { id: "railway", packages: ["railway", "@railway"], names: ["RAILWAY_"] },
  ];
  const doors = { root: "/repo", doors: ["apps/door/**", "packages/core/src/settings.ts"], platforms };

  it("refuses a platform's name as a property, a key, a string and a package, in every import form", () => {
    expect(lint("platform-name", "export const a = process.env.VERCEL_ENV;", [doors])).toEqual([
      expect.stringMatching(/^VERCEL_ENV is a hosting platform's own name/),
    ]);
    expect(
      lint("platform-name", "const { RAILWAY_REPLICA_ID: id } = process.env; export { id };", [doors]),
    ).toHaveLength(1);
    expect(lint("platform-name", 'export const key = "RAILWAY_REPLICA_ID";', [doors])).toHaveLength(1);
    expect(lint("platform-name", "export const key = `NEXT_PUBLIC_VERCEL_URL`;", [doors])).toHaveLength(1);
    expect(
      lint("platform-name", 'import { waitUntil } from "@vercel/functions"; export { waitUntil };', [doors]),
    ).toHaveLength(1);
    expect(lint("platform-name", 'export const load = () => import("@railway/cli");', [doors])).toHaveLength(
      1,
    );
    expect(lint("platform-name", 'export const sdk = require("railway");', [doors])).toHaveLength(1);
  });

  it("passes the product's own names, a comment, and a door file", () => {
    expect(
      lint("platform-name", "export const token = process.env.TF_SIGNAL_VERCEL_TOKEN;", [doors]),
    ).toEqual([]);
    expect(
      lint("platform-name", 'export const VERCEL_REQUEST_LOGS_URL = "https://example.invalid";', [doors]),
    ).toEqual([]);
    expect(lint("platform-name", "// reads VERCEL_ENV on that host\nexport const a = 1;", [doors])).toEqual(
      [],
    );
    expect(lint("platform-name", 'import { verse } from "vercelish"; export { verse };', [doors])).toEqual(
      [],
    );
    expect(
      lint(
        "platform-name",
        "export const a = process.env.VERCEL_ENV;",
        [doors],
        "/repo/apps/door/src/config.ts",
      ),
    ).toEqual([]);
    expect(
      lint(
        "platform-name",
        "export const a = process.env.VERCEL_ENV;",
        [doors],
        "/repo/packages/core/src/settings.ts",
      ),
    ).toEqual([]);
  });

  it("refuses every file when it has no list of door files, or no platform to look for", () => {
    const empty = { id: "nothing", packages: [], names: [] };
    for (const options of [
      [],
      [{ root: "/repo", doors: [], platforms }],
      [{ root: "/repo", doors: doors.doors }],
      [{ root: "/repo", doors: doors.doors, platforms: [] }],
      [{ root: "/repo", doors: doors.doors, platforms: [empty] }],
    ]) {
      expect(lint("platform-name", "export const a = 1;", options)).toEqual([
        expect.stringMatching(/so every file is refused/),
      ]);
    }
  });

  it("looks for the platforms its list names, and for no other", () => {
    const one = { ...doors, platforms: [{ id: "acme", packages: ["@acme"], names: ["ACME_"] }] };
    expect(lint("platform-name", "export const a = process.env.ACME_REGION;", [one])).toHaveLength(1);
    expect(lint("platform-name", 'import "@acme/edge";', [one])).toHaveLength(1);
    expect(lint("platform-name", "export const a = process.env.ACME_;", [one])).toEqual([]);
    expect(lint("platform-name", "export const a = process.env.ACME_region;", [one])).toEqual([]);
    expect(lint("platform-name", "export const a = process.env.VERCEL_ENV;", [one])).toEqual([]);
    expect(lint("platform-name", 'import "acme";', [one])).toEqual([]);
  });

  it("matches a door by its file or by its folder, never by a prefix of a name", () => {
    expect(isDoorFile("apps/door/src/a.ts", doors.doors)).toBe(true);
    expect(isDoorFile("apps/doorway/src/a.ts", doors.doors)).toBe(false);
    expect(isDoorFile("packages/core/src/settings.ts", doors.doors)).toBe(true);
    expect(isDoorFile("packages/core/src/settings.test.ts", doors.doors)).toBe(false);
  });

  it("lets wire export types and refuses every value", () => {
    const types =
      'export type Kind = "mail" | "event";\nexport interface Ask { kind: Kind }\nexport type { Other } from "./other.js";\nexport type * from "./more.js";';
    expect(lint("wire-exports-no-value", types)).toEqual([]);
    for (const code of [
      "export const version = 1;",
      "export function make() {}",
      "export enum Kind { Mail }",
      "export default {};",
      'export * from "./other.js";',
      'export { make } from "./other.js";',
      "const a = 1; export { a };",
    ]) {
      expect(lint("wire-exports-no-value", code), code).toEqual([
        expect.stringMatching(/^wire exports no value/),
      ]);
    }
  });

  it("refuses a comment that switches a rule off, and leaves other comments alone", () => {
    expect(
      lint("no-inline-config", "// eslint-disable-next-line no-empty\nexport const a = 1;"),
    ).toHaveLength(1);
    // A blanket switch-off silences what follows it, but not the finding on its own first line.
    expect(
      lint("no-inline-config", "/* eslint-disable */\nexport const a = 1;\n/* eslint-enable */"),
    ).toHaveLength(1);
    expect(lint("no-inline-config", "export const a = 1;\n/* eslint-enable */")).toHaveLength(1);
    expect(lint("no-inline-config", "/* eslint no-empty: off */\nexport const a = 1;")).toHaveLength(1);
    expect(lint("no-inline-config", "// eslint is not switched off here\nexport const a = 1;")).toEqual([]);
  });

  describe("the storage owner and the session's marker, read by a host alone", () => {
    const readers = {
      root: "/repo",
      readers: [
        "apps/web/app/session.ts",
        "apps/webapp/app/(product)/approve/settle-owner.ts",
        "apps/webapp/app/api-client.ts",
        "packages/app-logic/src/storage/storage-owner.ts",
      ],
      todaysScopeReaders: ["apps/webapp/app/views/search.ts"],
    };
    const at = "/repo/packages/app-logic/src/press/a.ts";
    const lookup = (code: string, filename = at, options: unknown[] = [readers]) =>
      lint("owner-lookup", code, options, filename);

    it("refuses each of the nine names, under any local name, by every specifier that reaches them", () => {
      for (const code of [
        'import { OWNER_COOKIE } from "@ohmail/app-logic/storage/owner-cookie"; export const a = OWNER_COOKIE;',
        'import { OWNER_COOKIE as marker } from "@ohmail/app-logic/storage"; export const a = marker;',
        'import { resetStorageOwnerForTest } from "../storage/storage-owner.js"; export const a = resetStorageOwnerForTest;',
        'import { storageOwner } from "@ohmail/app-logic/storage/storage-owner"; export const a = storageOwner;',
        'import { storageOwner as whose } from "@ohmail/app-logic/storage"; export const a = whose;',
        'import { storageOwnerState } from "../storage/storage-owner.js"; export const a = storageOwnerState;',
        'import { setStorageOwner } from "../storage/index.js"; export const a = setStorageOwner;',
        'import { setDemoStorage } from "../storage"; export const a = setDemoStorage;',
        'import { storageOwner } from "../storage/"; export const a = storageOwner;',
        'import { storageOwner } from "@ohmail/app-logic/storage/"; export const a = storageOwner;',
        'import { storageOwner } from "@ohmail/app-logic/storage/index"; export const a = storageOwner;',
        'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; export const a = readOwner;',
        'import { readOwnerMarker as marker } from "../storage/owner-cookie"; export const a = marker;',
        'import { readOwnerCookie } from "@ohmail/app-logic/storage"; export const a = readOwnerCookie;',
        'export { storageOwner } from "@ohmail/app-logic/storage/storage-owner";',
        'export { readOwner as who } from "../storage/owner-cookie.js";',
      ]) {
        expect(lookup(code), code).toEqual([
          expect.stringMatching(/^\w+ reads the storage owner or the session's marker/),
        ]);
      }
    });

    it("refuses a namespace of either module or of the door, and a whole re-export, a dynamic import or a require of one", () => {
      for (const code of [
        'import * as owner from "@ohmail/app-logic/storage/storage-owner"; export const a = owner;',
        'import * as storage from "@ohmail/app-logic/storage"; export const a = storage;',
        'export * from "../storage/owner-cookie.js";',
        'export * as owner from "@ohmail/app-logic/storage/storage-owner";',
        'export const load = () => import("@ohmail/app-logic/storage/storage-owner");',
        'export const owner = require("../storage/owner-cookie.js");',
      ]) {
        expect(lookup(code), code).toHaveLength(1);
      }
    });

    it("refuses the web session client's answers of whose session it speaks for, by every specifier and in every form", () => {
      const part = "/repo/apps/webapp/app/shell/a.ts";
      for (const code of [
        'import { boundApiOwner } from "../api-client"; export const key = (): string => `ohmail.ui.readingAlong.${boundApiOwner() ?? "local"}`;',
        'import { apiOwnerBinding as binding } from "../api-client.ts"; export const a = binding;',
        'import { boundApiOwner } from "../api-client.js"; export const a = boundApiOwner;',
        'import { boundApiOwner } from "../../app/api-client/"; export const a = boundApiOwner;',
        'import { boundApiOwner } from "@/app/api-client"; export const a = boundApiOwner;',
        'export { apiOwnerBinding } from "../api-client";',
      ]) {
        expect(lookup(code, part), code).toEqual([
          expect.stringMatching(/^\w+ reads the storage owner or the session's marker/),
        ]);
      }
      for (const code of [
        'export * from "../api-client";',
        'import * as client from "@/app/api-client.ts"; export const a = client;',
        'export const load = () => import("../api-client");',
        'export const client = require("../api-client.js");',
      ]) {
        expect(lookup(code, part), code).toEqual([
          expect.stringMatching(/ of \S*api-client\S* reaches the storage owner's/),
        ]);
      }
      // The client's other answers are any part's, and a listed host's file reads the getters itself.
      expect(
        lookup(
          'import { api, ApiError, type MailboxDTO } from "../api-client"; export const a = [api, ApiError];',
          part,
        ),
      ).toEqual([]);
      expect(
        lookup(
          'import { apiOwnerBinding } from "../../api-client"; export const blocked = (): boolean => apiOwnerBinding().kind === "blocked";',
          "/repo/apps/webapp/app/(product)/approve/settle-owner.ts",
        ),
      ).toEqual([]);
    });

    it("passes the free names, a type, another module of the door, and a listed host's file", () => {
      for (const code of [
        'import { isDemoOwned, DEMO_STORAGE_OWNER, namesOwner } from "@ohmail/app-logic/storage/storage-owner"; export const a = [isDemoOwned, DEMO_STORAGE_OWNER, namesOwner];',
        'import { isOwnerShaped, OWNER_SIGNED_OUT } from "@ohmail/app-logic/storage/owner-cookie"; export const a = [isOwnerShaped, OWNER_SIGNED_OUT];',
        'import type { StorageOwnerState } from "@ohmail/app-logic/storage/storage-owner"; export type A = StorageOwnerState;',
        'import { type OwnerMarker } from "../storage/owner-cookie.js"; export type A = OwnerMarker;',
        'import { scopeSuffix } from "@ohmail/app-logic/storage/scope"; export const a = scopeSuffix;',
        'import { storageOwner } from "./storage-owner-of-something-else.js"; export const a = storageOwner;',
      ]) {
        expect(lookup(code), code).toEqual([]);
      }
      expect(
        lookup(
          'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; export const a = (): boolean => readOwner() !== null;',
          "/repo/apps/web/app/session.ts",
        ),
      ).toEqual([]);
    });

    it("spells the marker's cookie name as the marker's own module does", () => {
      expect(OWNER_MARKER_NAME).toBe(OWNER_COOKIE);
    });

    it("refuses the marker's cookie name spelled in a string, a template or a regular expression, outside the list", () => {
      for (const code of [
        'import { cookieFromJar } from "@ohmail/app-logic/storage/cookie-jar"; export const a = (jar: string) => cookieFromJar(jar, "tf_owner");',
        "export const a = (jar: string) => jar.includes(`tf_owner=`);",
        "export const a = (id: string) => `tf_owner=${id}`;",
        "export const a = (jar: string) => /(?:^|;\\s*)tf_owner=([^;]*)/.exec(jar);",
      ]) {
        expect(lookup(code), code).toEqual([
          expect.stringMatching(/^tf_owner is the session's marker's cookie name/),
        ]);
      }
      // A comment that names it, and another cookie's name, are nobody's lookup.
      expect(lookup('// reads tf_owner on the server\nexport const a = "tf_session";')).toEqual([]);
      // A listed host's file spells it, and is no stale entry for that alone.
      expect(lookup('export const OWNER_COOKIE = "tf_owner";', "/repo/apps/web/app/session.ts")).toEqual([]);
    });

    it("refuses a listed host's file that hands a lookup on by exporting it, under any name", () => {
      const host = "/repo/apps/web/app/session.ts";
      for (const code of [
        'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; export { readOwner as marker };',
        'import { storageOwner as whose } from "@ohmail/app-logic/storage"; export const a = whose(); export { whose };',
        'export { whose }; import { storageOwner as whose } from "../../../packages/app-logic/src/storage/storage-owner.js";',
        'import * as owner from "@ohmail/app-logic/storage/storage-owner"; export { owner };',
        'export { readOwner as who } from "@ohmail/app-logic/storage/owner-cookie";',
        'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; export default readOwner;',
        'import { readOwner as whose } from "@ohmail/app-logic/storage/owner-cookie"; export const marker = whose;',
        'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; export const whose = (): string | null => readOwner();',
        'import { storageOwner } from "@ohmail/app-logic/storage"; export function whose() { return storageOwner(); }',
        'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; export default () => readOwner();',
        'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; const whose = function () { return readOwner(); }; export { whose };',
        'import * as owner from "@ohmail/app-logic/storage/storage-owner"; export const whose = () => owner.storageOwner();',
      ]) {
        expect(lookup(code, host), code).toEqual([expect.stringMatching(/an export hands it to every file/)]);
      }
      expect(
        lookup(
          'import { apiOwnerBinding } from "../../api-client"; export const binding = () => apiOwnerBinding();',
          "/repo/apps/webapp/app/(product)/approve/settle-owner.ts",
        ),
      ).toEqual([expect.stringMatching(/^apiOwnerBinding is a host's own lookup, and an export hands it/)]);
      // A free name it imported beside a lookup is its own to export, and so is what it read or handed down.
      expect(
        lookup(
          'import { readOwner, isOwnerShaped } from "@ohmail/app-logic/storage/owner-cookie"; export const a = readOwner(); export { isOwnerShaped };',
          host,
        ),
      ).toEqual([]);
      expect(
        lookup(
          'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; export function mount(draw: (scope: string | null) => void): void { draw(readOwner()); }',
          host,
        ),
      ).toEqual([]);
      // The session client's own answers stand in the plugin's table: every other file is refused their import.
      expect(
        lookup(
          'import { readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie"; export const boundApiOwner = (): string | null => readOwnerMarker();',
          "/repo/apps/webapp/app/api-client.ts",
        ),
      ).toEqual([]);
    });

    it("lets a file listed to spell the marker's cookie name spell it, and import none of the lookups", () => {
      const options = [{ ...readers, markerNameSpellers: ["packages/api/src/cookies.ts"] }];
      const speller = "/repo/packages/api/src/cookies.ts";
      expect(lookup('export const OWNER_COOKIE = "tf_owner";', speller, options)).toEqual([]);
      expect(
        lookup(
          'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie"; export const a = [readOwner, "tf_owner"];',
          speller,
          options,
        ),
      ).toEqual([expect.stringMatching(/^readOwner reads the storage owner or the session's marker/)]);
      expect(lookup("export const a = 1;", speller, options)).toEqual([
        expect.stringMatching(/is listed .* to spell the marker's cookie name and spells it nowhere/),
      ]);
    });

    it("refuses a listed file that reads none of them: the list only shrinks", () => {
      expect(lookup("export const a = 1;", "/repo/apps/web/app/session.ts")).toEqual([
        expect.stringMatching(/is listed .* and imports none of them/),
      ]);
    });

    it("refuses every file when it has no list of readers", () => {
      for (const options of [
        [],
        [{ root: "/repo" }],
        [{ root: "/repo", readers: [], todaysScopeReaders: ["x.ts"] }],
      ]) {
        expect(lookup("export const a = 1;", at, options)).toEqual([
          expect.stringMatching(/so every file is refused/),
        ]);
      }
    });

    it("lets the closed list read the shell's scope and refuses every other file", () => {
      const code = 'import { useTodaysScope } from "../shell/todays-scope"; export const a = useTodaysScope;';
      expect(lookup(code, "/repo/apps/webapp/app/views/search.ts")).toEqual([]);
      expect(lookup(code, "/repo/apps/webapp/app/views/other.ts")).toEqual([
        expect.stringMatching(/^useTodaysScope is read by the closed list/),
      ]);
      expect(lookup("export const a = 1;", "/repo/apps/webapp/app/views/search.ts")).toEqual([
        expect.stringMatching(/is listed .* and imports none of them/),
      ]);
    });
  });
});

describe("the linter as the check runs it", () => {
  const made: string[] = [];
  afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  /** A small tree of its own: `files` written under a new folder, the linter's configuration among them. */
  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ohmail-tools-"));
    made.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    return root;
  };
  const CONFIG = [
    "export default [{",
    '  files: ["**/*.mjs"],',
    '  linterOptions: { reportUnusedDisableDirectives: "error" },',
    '  rules: { "no-var": "error" },',
    "}];",
  ].join("\n");
  const rulesOf = async (root: string, ...rels: string[]) =>
    (
      await runEslint(
        root,
        rels.map((rel) => path.join(root, rel)),
      )
    ).map((f) => `${f.path} ${f.rule}`);

  it("counts a finding that a comment in the file switched off", async () => {
    const root = tree({
      "eslint.config.mjs": CONFIG,
      "plain.mjs": "var a = 1;\nexport { a };\n",
      "next-line.mjs": "// eslint-disable-next-line no-var\nvar a = 1;\nexport { a };\n",
      "blanket.mjs": "/* eslint-disable */\nvar a = 1;\nexport { a };\n",
      "inert.mjs": "// eslint-disable-next-line no-var\nexport const a = 1;\n",
    });
    expect(await rulesOf(root, "plain.mjs", "next-line.mjs", "blanket.mjs", "inert.mjs")).toEqual([
      "plain.mjs no-var",
      "next-line.mjs no-var",
      "blanket.mjs no-var",
      "inert.mjs eslint:unused-directive",
    ]);
  });

  it("refuses a comment that sets a rule, also one that sets the rule against such comments", async () => {
    const root = tree({
      "eslint.config.mjs": CONFIG,
      "set.mjs": "/* eslint no-var: off */\nvar a = 1;\nexport { a };\n",
      "set-both.mjs": "/* eslint ohmail/no-config-comment: off, no-var: off */\nvar a = 1;\nexport { a };\n",
      "said.mjs": 'export const said = "/* eslint no-var: off */";\n// eslint is a word here\n',
    });
    // The second file is refused twice: its comment also names a rule the configuration does not carry.
    expect(await rulesOf(root, "set.mjs", "set-both.mjs", "said.mjs")).toEqual([
      "set-both.mjs eslint:unused-directive",
      "set.mjs ohmail/no-config-comment",
      "set-both.mjs ohmail/no-config-comment",
    ]);
  });

  it("reads eslint.config.mjs alone, whatever other configuration stands beside it", async () => {
    const root = tree({
      "eslint.config.mjs": CONFIG,
      "eslint.config.js": 'module.exports = [{ files: ["**/*.mjs"], rules: { "no-var": "off" } }];\n',
      "plain.mjs": "var a = 1;\nexport { a };\n",
    });
    expect(await rulesOf(root, "plain.mjs")).toEqual(["plain.mjs no-var"]);
    expect(
      otherLinterConfigs(["eslint.config.mjs", "package.json", "eslint.config.js", "eslint.config.cts"]),
    ).toEqual([
      "config: eslint.config.cts stands beside eslint.config.mjs; the linter has one configuration file",
      "config: eslint.config.js stands beside eslint.config.mjs; the linter has one configuration file",
    ]);
    expect(otherLinterConfigs(["eslint.config.mjs", "stylelint.config.mjs"])).toEqual([]);
  });

  it("says which package a border finding reached", async () => {
    const plugin = pathToFileURL(path.resolve("tools/eslint-plugin-ohmail/index.mjs")).href;
    const root = tree({
      "eslint.config.mjs": [
        `import ohmail from ${JSON.stringify(plugin)};`,
        "export default [{",
        '  files: ["**/*.mjs"],',
        "  plugins: { ohmail },",
        '  rules: { "ohmail/package-borders": ["error", { root: import.meta.dirname }] },',
        "}];",
      ].join("\n"),
      "tools/borders.json": JSON.stringify({
        packages: { ui: { imports: [] }, engine: { imports: [] } },
        apps: { web: {}, server: {} },
      }),
      "packages/ui/package.json": '{ "name": "@x/ui" }',
      "packages/engine/package.json": '{ "name": "@x/engine" }',
      "apps/server/package.json": '{ "name": "@x/server" }',
      "packages/ui/src/a.mjs":
        'import "@x/engine";\nimport "../../../apps/server/src/index.mjs";\nimport "node:fs";\n',
      "packages/loose/src/a.mjs": "export const a = 1;\n",
    });
    const findings = await runEslint(root, [
      path.join(root, "packages/ui/src/a.mjs"),
      path.join(root, "packages/loose/src/a.mjs"),
    ]);
    expect(findings.map((f) => [f.path, f.rule, f.reach, f.line])).toEqual([
      ["packages/ui/src/a.mjs", "ohmail/package-borders", "engine", 1],
      ["packages/ui/src/a.mjs", "ohmail/package-borders", "apps/server", 2],
      ["packages/loose/src/a.mjs", "ohmail/package-borders", undefined, 1],
    ]);
  });
});

/** The two switches of a Next.js configuration this file reads (the root manifest does not declare next). */
type NextBuildSwitches = {
  eslint?: { ignoreDuringBuilds?: boolean };
  typescript?: { ignoreBuildErrors?: boolean };
};

describe("the one linter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is the check: the web builds lint nothing, and the check reads the web app", async () => {
    vi.stubEnv("NEXT_PUBLIC_GITHUB_STARS", "1");
    const load = async (app: string): Promise<unknown> =>
      (await import(pathToFileURL(path.resolve("apps", app, "next.config.mjs")).href)).default;
    const web = (await load("webapp")) as () => Promise<NextBuildSwitches>;
    const api = (await load("api-vercel")) as NextBuildSwitches;
    for (const config of [await web(), api]) {
      expect(config.eslint?.ignoreDuringBuilds).toBe(true);
      expect(config.typescript?.ignoreBuildErrors).not.toBe(true);
    }

    const root = path.resolve(".");
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: root, overrideConfigFile: linterConfig(root), warnIgnored: false });
    const [result] = await eslint.lintText(
      'import { a } from "../../worker/src/a.js";\n// eslint-disable-next-line no-console\nexport const b = a;\n',
      { filePath: path.join(root, "apps/webapp/app/planted.tsx") },
    );
    expect(result?.messages.map((m) => `${m.line} ${m.ruleId ?? "directive"}`)).toEqual([
      "1 ohmail/package-borders",
      "2 directive",
    ]);
  });

  it("binds the web app's root files and its words to the hosts' list, and shared code to every shell-only global by globalThis", async () => {
    const root = path.resolve(".");
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: root, overrideConfigFile: linterConfig(root), warnIgnored: false });
    const rulesAt = async (code: string, rel: string) =>
      (await eslint.lintText(code, { filePath: path.join(root, rel) }))[0]?.messages.map(
        (m) => `${m.line} ${m.ruleId}`,
      );
    const reader =
      'import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";\nexport const whose = (): string | null => readOwner();\n';
    expect(await rulesAt(reader, "apps/webapp/planted.ts")).toEqual(["1 ohmail/owner-lookup"]);
    expect(await rulesAt(reader, "apps/webapp/i18n/planted.ts")).toEqual(["1 ohmail/owner-lookup"]);
    for (const name of ["localStorage", "sessionStorage", "location", "navigator", "fetch"]) {
      expect(
        await rulesAt(
          `export const reach = () => globalThis.${name};\n`,
          "packages/app-logic/src/planted.ts",
        ),
        name,
      ).toEqual(["1 no-restricted-properties"]);
    }
  });
});
