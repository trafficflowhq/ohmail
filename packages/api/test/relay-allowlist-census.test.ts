import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRoutes } from "../src/routes/index.js";
import { localRoutes } from "../src/local.js";
import { selfHostRoutes } from "../src/routes/self-host.js";
import { desktopHostRoutes } from "../src/routes/desktop-host.js";
import { mailboxDeviceOAuthRoutes } from "../src/routes/mailbox-oauth-device.js";
import type { Route } from "../src/router.js";
import { RELAY_ALLOWLIST, mayRelay } from "../src/relay-allowlist.js";
import { normalizePathname } from "../src/canonical-path.js";

/**
 * A Cloud-mode install's relay forwards to the server its door names, so the refusal is the
 * boundary between a credential and somebody else's machine. It is an allowlist: a non-member is
 * a 404, and the spellings that used to slip past a denylist have no entry to slip into.
 *
 * This holds three things down: every route declares `relay`, the projection the sidecar reads
 * matches the table exactly, and no route that resolves a credential from its body is relayable —
 * that last one derived from the handlers rather than listed.
 */

const TABLES: ReadonlyArray<readonly [string, readonly Route[]]> = [
  ["apiRoutes", apiRoutes],
  ["localRoutes", localRoutes],
  ["selfHostRoutes", selfHostRoutes],
  ["desktopHostRoutes", desktopHostRoutes],
  ["mailboxDeviceOAuthRoutes", mailboxDeviceOAuthRoutes],
];

const key = (r: { method: string; pattern: string }) => `${r.method.toUpperCase()} ${r.pattern}`;

/** Every distinct route across every table, with the table it was first seen in. */
function everyRoute(): Map<string, { route: Route; table: string }> {
  const out = new Map<string, { route: Route; table: string }>();
  for (const [table, routes] of TABLES) {
    for (const r of routes) if (!out.has(key(r))) out.set(key(r), { route: r, table });
  }
  return out;
}

describe("every route declares whether it may be relayed", () => {
  it("no route in any table leaves the field undeclared", () => {
    /* The compiler already refuses a literal without it. This is the other door: a cast, a
       JS caller, or a synthetic route in a test file the package does not typecheck. */
    const missing: string[] = [];
    for (const [k, { route, table }] of everyRoute()) {
      if (typeof route.relay !== "boolean") missing.push(`${k} (${table})`);
    }
    expect(missing, "a route reached the runtime with no relay verdict").toEqual([]);
  });

  it("the tables are not empty, so the case above is about something", () => {
    for (const [name, routes] of TABLES) {
      expect(routes.length, `${name} is empty`).toBeGreaterThan(0);
    }
    expect(everyRoute().size).toBeGreaterThan(200);
  });
});

describe("the projection the sidecar reads matches the table", () => {
  it("exactly the relay:true routes, in both directions", () => {
    const declared = new Set(
      [...everyRoute().values()].filter((x) => x.route.relay === true).map((x) => key(x.route)),
    );
    const projected = new Set(RELAY_ALLOWLIST.map(key));
    expect([...declared].filter((k) => !projected.has(k)), "relayable but absent from the projection").toEqual([]);
    expect([...projected].filter((k) => !declared.has(k)), "in the projection but not relayable").toEqual([]);
  });

  it("and the count is pinned, so a widening is visible", () => {
    /* Not a style rule: this number is how many routes a relay may carry to a server the person
       runs themselves. It moves when somebody means it to. */
    // 166 -> 168 with mail 0104's held-release pair. Both are relayable for the reason the
    // Screener's other routes are: a reader's door has to be able to ask the organizer's
    // server what is held and to press, or the screen exists on one install out of two.
    // 168 -> 169 with FIX-021's held-release dismiss: "not now" made on a reader's install has
    // to reach the organizer's server, or the offer comes back on every OTHER device.
    // 169 -> 170 with the wall's export door (`GET /account/export`): the way out with your
    // configuration is read from the account host, so a Cloud-mode install's relay forwards it.
    // 170 -> 172 with the undecided-sender pair, relayable for the held-release pair's reason: a
    // reader's door has to ask the organizer's server what is undecided and to press, or the
    // screen exists on one install out of two.
    // 172 -> 173 with `GET /drafts/:id/send-attempt`: the send's read half, which a Cloud-mode
    // install must be able to forward or its client cannot present a key before re-uploading.

    // 173 -> 174 with `GET /messages/timeline`: History's month counts, which a Cloud-mode install
    // forwards to the account host for the reason `GET /messages` is absent from its local door.
    // 174 -> 175 with `POST /mailboxes/:id/profile-import/replace`: the Settings row's release,
    // forwarded like the decline beside it or the hosted desktop and a paired phone answer 404.
    // 175 -> 176 with `GET /mailboxes/:id/profile-import/status`: where a press the organizer is
    // finishing stands, relayed like the candidate beside it.
    // 176 -> 177 with `GET /mailboxes/:id/self-check`, the self-check, relayed like the organizer peek.
    // 177 -> 178 with `DELETE /screener/junk/rescue/:id`, relayed like the rescue it clears.
    // 178 -> 180 with the Screener's automatic filing and its put-back, relayed like the
    // held-release pair beside them.
    // 180 -> 181 with `GET /screener/stayed`, relayed like the held-release read.
    // 181 -> 182 with `GET /organizer-requests`, relayed like `GET /rules` beside it.
    // 182 -> 183 with `POST /sends/withdraw`: Cancel asks the server the send went to, so it is
    // relayed with the send or a Cloud-mode install's Cancel answers a 404.
    // 183 -> 184 with `POST /mailboxes/:id/gap-letters`: the gap offer is answered on the server
    // that organizes the mailbox, like the organizer notice's dismiss beside it.
    // 184 -> 185 with `GET /screener/unscreened/count`, relayed like the offer's read beside it.
    // 185 -> 186 with `POST /auth/password`: the session is the subject and the body a
    // re-assertion, the position `POST /auth/step-up/totp` is relayed from.
    // 186 -> 187 with `GET /screener/waiting/count`, relayed like the decision count beside it.
    expect(RELAY_ALLOWLIST.length).toBe(187);
  });

  it("every pattern in the projection is a real route", () => {
    const real = new Set([...everyRoute().keys()]);
    expect(RELAY_ALLOWLIST.map(key).filter((k) => !real.has(k))).toEqual([]);
  });
});

describe("the refusals that carry a credential are derived, not listed", () => {
  it("no route that resolves a credential from its body is relayable", () => {
    /* `credentialSubject` marks the handlers that answer for a credential in the request body.
       Derived here so a route that becomes one cannot stay relayable by nobody noticing. */
    const subjects = [...everyRoute().values()].filter((x) => x.route.options?.credentialSubject === true);
    expect(subjects.length, "the credential-subject set is empty — the derivation has broken")
      .toBeGreaterThanOrEqual(10);
    expect(subjects.filter((x) => x.route.relay === true).map((x) => key(x.route))).toEqual([]);
  });

  it("the browser hand-off pair is refused, mint and claim", () => {
    for (const k of ["POST /auth/desktop-link", "POST /auth/desktop-claim"]) {
      expect(mayRelay(...(k.split(" ") as [string, string])), `${k} is relayable`).toBe(false);
    }
  });

  it("the hosted console and the shared-secret intake are refused wholesale", () => {
    const leaked = [...everyRoute().values()]
      .filter((x) => /^\/(admin|internal)(\/|$)/.test(x.route.pattern) && x.route.relay === true)
      .map((x) => key(x.route));
    expect(leaked).toEqual([]);
  });
});

describe("a spelling that reaches a hosted route reaches the same verdict here", () => {
  /* The five spellings that got different answers from the old denylist and the server. Each is a
     path the hosted API resolves to `/auth/desktop-claim`, or refuses; none may be relayed. */
  const REACHES_THE_CLAIM = [
    "/auth/desktop-claim",
    "/auth/desktop-claim/",        // a trailing slash
    "//auth//desktop-claim",       // repeated separators
    "/api/auth/desktop-claim",     // the prefix the server strips off itself
    "/auth/desktop%2Dclaim",       // an unreserved escape the server decodes
  ];

  for (const p of REACHES_THE_CLAIM) {
    it(`POST ${p} is not relayed`, () => {
      expect(normalizePathname(p), "the canonicalizer disagrees with the server").toBe("/auth/desktop-claim");
      expect(mayRelay("POST", p)).toBe(false);
    });
  }

  it("a malformed escape is refused rather than reasoned about", () => {
    expect(mayRelay("POST", "/auth/desktop-claim%")).toBe(false);
    expect(mayRelay("GET", "/messages%ZZ")).toBe(false);
  });

  it("the method is part of the comparison", () => {
    /* The old guard compared pathname alone, so a GET on a POST-only route got the wrong answer. */
    expect(mayRelay("POST", "/messages/abc/move")).toBe(true);
    expect(mayRelay("GET", "/messages/abc/move")).toBe(false);
  });

  it("case is not folded, because static route segments are compared byte-for-byte", () => {
    expect(mayRelay("POST", "/messages/abc/move")).toBe(true);
    expect(mayRelay("POST", "/Messages/abc/MOVE")).toBe(false);
  });
});

describe("the routes a self-hosted client needs are admitted", () => {
  /* THE POSITIVE CONTROL. A refusal rule whose every case asserts a refusal has no evidence it
     admits the right person — and here that person is every operator running their own server. */
  const NEEDED: ReadonlyArray<readonly [string, string]> = [
    ["GET", "/hello"],
    ["GET", "/messages"],
    ["PATCH", "/messages"],
    ["POST", "/messages/abc/move"],
    ["DELETE", "/messages/abc"],
    ["POST", "/drafts"],
    ["POST", "/drafts/abc/send"],
    ["GET", "/attachments/abc"],
    ["POST", "/attachments/staging"],
    ["GET", "/img"],
    ["POST", "/mailboxes"],
    ["PATCH", "/mailboxes/abc"],
    ["GET", "/events"],
    ["POST", "/sync/pull"],
    ["POST", "/messages/abc/tags"],
    ["POST", "/rules"],
    ["POST", "/screener/abc"],
    ["PUT", "/away-responder"],
    ["POST", "/auth/logout"],
    ["POST", "/auth/step-up/totp"],
    ["DELETE", "/account"],
    ["POST", "/pair"],
    ["GET", "/search"],
  ];

  for (const [m, p] of NEEDED) {
    it(`${m} ${p}`, () => expect(mayRelay(m, p)).toBe(true));
  }

  it("and the same paths under the webapp's /api split", () => {
    for (const [m, p] of NEEDED) {
      expect(mayRelay(m, `/api${p}`), `${m} /api${p}`).toBe(true);
    }
  });
});

describe("the canonicalizer is DEFINED once, and every host CALLS that one", () => {
  /* The rule that decides a request hash used to be written out three times — this leaf and a
     code-identical copy in each host — pinned by a text compare. A pin is not one definition: it
     says the three agree TODAY, and the thing it is defending against is a correction applied to
     one of them. So the census counts DEFINITIONS, by parse, and admits exactly one. */
  const ROOTS = ["apps", "packages"];
  const NAMES = ["normalizeEscapes", "normalizePathname"];
  /** Where the one definition is allowed to be. Any other file is the defect. */
  const HOME = "packages/api/src/canonical-path.ts";

  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".next" || e.name === "build") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(full);
    }
    return out;
  };
  const sources = ROOTS.flatMap((r) => walk(join(repo, r)));

  /* A DEFINITION, never a mention: `function normalizePathname(` and the assigned forms. A call
     (`normalizePathname(url.pathname)`), an import specifier, a re-export and a docblock all name
     the symbol too, and counting those would make every caller a copy. */
  const defines = (src: string, name: string): boolean =>
    new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).test(src)
    || new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*[:=]`).test(src);

  for (const name of NAMES) {
    it(`${name} is defined in exactly one file`, () => {
      const homes = sources
        .filter((f) => defines(readFileSync(f, "utf8"), name))
        .map((f) => f.slice(repo.length).replace(/\\/g, "/"));
      expect(homes, `${name} is defined in ${homes.length} files; the canonicalizer is one routine `
        + `and every host imports it from ${HOME}`).toEqual([HOME]);
    });
  }

  it("and the hosts CALL it — a census of definitions must not pass for a deletion", () => {
    /* The positive control on the rule above: zero definitions everywhere would satisfy a naive
       count too, and so would a host that quietly stopped canonicalizing. Both pipelines are read
       for the call by name. */
    for (const rel of ["apps/server/src/handler.ts", "apps/api-vercel/src/normalize.ts"]) {
      const src = readFileSync(join(repo, rel), "utf8");
      expect(/normalizePathname\(\s*url\.pathname\s*\)/.test(src), `${rel} no longer canonicalizes`)
        .toBe(true);
    }
  });

  it("and the hosted host's own API_PREFIX is the same text", () => {
    /* `apps/api-vercel/src/prefix.ts` may not import from this workspace — the webapp's tests
       reach into it (`input-bounds-census` §5) — so it keeps its own copy of the one constant.
       A constant is pinnable where a routine is not; two spellings of the prefix is a 404 on
       every proxied path. */
    const read = (rel: string): string | null => {
      const m = /export const API_PREFIX = "([^"]*)"/.exec(readFileSync(join(repo, rel), "utf8"));
      return m ? m[1]! : null;
    };
    const here = read("packages/api/src/canonical-path.ts");
    expect(here, "the leaf no longer declares API_PREFIX").not.toBeNull();
    expect(read("apps/api-vercel/src/prefix.ts"), "the hosted host's API_PREFIX has drifted")
      .toBe(here);
  });
});
