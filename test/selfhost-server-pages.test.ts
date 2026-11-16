// @services: none — reads the proxy's files as text and runs the Umbrel hook and the proxy's entrypoint
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

/**
 * THE PAGES A SERVER YOU RUN ANSWERS WITH BEFORE THE APP: the self-host proxy's 421 for a Host that is
 * not the origin, and the Umbrel launcher's two pages (starting, and the setup steps while no origin is
 * set). Each is one document with its style inline: no script, no picture, no link, no font, nothing
 * fetched, nothing to press, and nothing of the request in it. The only value is the configured origin,
 * on the 421, substituted when Caddy reads the file; the proxy's entrypoint admits only an origin's
 * characters for it.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rd = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const ENTRYPOINT = join(ROOT, "deploy/selfhost/proxy/entrypoint.sh");

const scratch = mkdtempSync(join(tmpdir(), "ohmail-server-pages-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The Umbrel hook's render with no origin set: the file the launcher serves until one is. */
function unconfiguredUmbrel(): string {
  const app = join(scratch, "umbrel");
  mkdirSync(join(app, "data", "env"), { recursive: true });
  writeFileSync(join(app, "data", "env", "settings.env"), "OHMAIL_ORIGIN=\n");
  execFileSync("bash", [join(ROOT, "deploy/umbrel/ohmail/hooks/pre-start")], { env: { ...process.env, APP_DATA_DIR: app }, stdio: ["ignore", "ignore", "pipe"] });
  return readFileSync(join(app, "data", "caddy", "etc", "Caddyfile"), "utf8");
}

interface Page { headers: Map<string, string>; body: string; status: number }

/**
 * The one respond of a Caddyfile and the `header` lines before it in the same block, its body as Caddy
 * reads it: a backtick-quoted token (`respond \`…\` <status>`, the 421, which carries the origin) as it
 * stands, or a heredoc (`respond <<HTML … HTML <status>`) with the closing marker's indentation taken
 * off every line.
 */
function pageOf(caddyfile: string, after: RegExp): Page {
  const from = caddyfile.search(after);
  expect(from, `no ${after} in the Caddyfile`).toBeGreaterThanOrEqual(0);
  const rest = caddyfile.slice(from);
  const quoted = /\n((?:[ \t]*header [^\n]*\n)*)[ \t]*respond `([^`]*)` (\d{3})\n/.exec(rest);
  const heredoc = /\n((?:[ \t]*header [^\n]*\n)*)[ \t]*respond <<HTML\n([\s\S]*?)\n([ \t]*)HTML (\d{3})\n/.exec(rest);
  const first = quoted && (!heredoc || quoted.index < heredoc.index) ? "quoted" : heredoc ? "heredoc" : null;
  expect(first, "no respond with a quoted or heredoc body").not.toBeNull();
  const m = first === "quoted" ? quoted! : heredoc!;
  const indent = first === "quoted" ? "" : m[3]!;
  const status = first === "quoted" ? m[3]! : m[4]!;
  const body = m[2]!.split("\n").map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
  const headers = new Map<string, string>();
  for (const l of m[1]!.split("\n").filter(Boolean)) {
    const h = /^\s*header (\S+) (.*)$/.exec(l)!;
    headers.set(h[1]!, h[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return { headers, body, status: Number(status) };
}

const ELEMENTS = new Set(["html", "head", "meta", "title", "style", "body", "main", "h1", "p", "ol", "li", "code"]);
const ATTRS = new Set(["lang", "charset", "name", "content", "class", "style"]);
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** Every reason this page is not a plain, self-contained page; empty when it is. */
function problems(body: string): string[] {
  const found: string[] = [];
  for (const re of [/\bsrc\s*=/i, /\burl\s*\(/i, /@import/i, /@font-face/i, /<script/i, /<link/i, /<img/i, /\bhref\s*=/i, /\\/]) {
    if (re.test(body)) found.push(`matched ${re}`);
  }
  const doc = new JSDOM(body).window.document;
  for (const el of doc.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (!ELEMENTS.has(tag)) found.push(`element ${tag}`);
    for (const a of el.getAttributeNames()) if (!ATTRS.has(a)) found.push(`attribute ${a}`);
    const style = el.getAttribute("style");
    if (style !== null && /[(\\@{}<]|\/\*/.test(style)) found.push(`style attribute ${style}`);
  }
  if (doc.querySelectorAll("style").length > 1) found.push("more than one style element");
  const css = doc.querySelector("style")?.textContent ?? "";
  for (const l of css.split("\n").filter(Boolean)) {
    if (!/^(:root\{color-scheme:light dark\}|@media \(prefers-color-scheme:dark\)\{|\.[a-z]\{(?:(?:color|background):#[0-9A-F]{6} !important;?)+\}|\})$/.test(l)) {
      found.push(`style line ${l}`);
    }
  }
  const outsideStyle = body.replace(/<style>[\s\S]*?<\/style>/, "");
  for (const run of outsideStyle.match(/\{[^}]*\}/g) ?? []) if (run !== "{$OHMAIL_ORIGIN}") found.push(`brace run ${run}`);
  if (/TrafficFlow|ohmail\.app/i.test(body)) found.push("names the company or links to ohmail.app");
  return found;
}

const PAGES: Array<[string, () => Page, number]> = [
  ["the self-host 421", () => pageOf(rd("deploy/selfhost/proxy/Caddyfile"), /^http:\/\/:\{\$OHMAIL_FRONT_DOOR_PORT:80\} \{$/m), 421],
  ["Umbrel, starting (the committed placeholder)", () => pageOf(rd("deploy/umbrel/ohmail/data/caddy/etc/Caddyfile"), /^:8099 \{$/m), 200],
  ["Umbrel, no origin set yet (the hook's render)", () => pageOf(unconfiguredUmbrel(), /^:8099 \{$/m), 200],
];

describe("the server's own pages", () => {
  for (const [name, page, status] of PAGES) {
    it(`${name}: its status, a typed html page, a policy that loads nothing, never stored`, () => {
      const p = page();
      expect(p.status).toBe(status);
      expect(p.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(p.headers.get("Content-Security-Policy")).toBe(status === 421 ? `${POLICY}; frame-ancestors 'none'` : POLICY);
      expect(p.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(p.headers.get("Cache-Control")).toBe("no-store");
      expect(p.headers.has("Strict-Transport-Security")).toBe(false);
    });

    it(`${name}: allow-listed markup, one dark block, nothing fetched and nothing to press`, () => {
      const p = page();
      expect(problems(p.body)).toEqual([]);
      const doc = new JSDOM(p.body).window.document;
      expect(doc.documentElement.getAttribute("lang")).toBe("en");
      expect(doc.querySelector("h1")?.textContent).toMatch(/\.$/);
    });
  }

  it("the 421 names the origin once, as words, and nothing of the request; no product name", () => {
    const p = PAGES[0]![1]();
    expect(p.body.split("{$OHMAIL_ORIGIN}")).toHaveLength(2);
    const doc = new JSDOM(p.body.replace("{$OHMAIL_ORIGIN}", "https://mail.example.com")).window.document;
    expect(doc.querySelector("p")?.textContent).toBe("Open it at https://mail.example.com.");
    expect(p.body.replace("{$OHMAIL_ORIGIN}", "")).not.toMatch(/ohmail/i);
    expect(p.body).not.toMatch(/\{(http|header|query|uri|path|host|remote)/);
  });

  it("/version above the 421 still answers through the web container", () => {
    const door = rd("deploy/selfhost/proxy/Caddyfile").split(/^http:\/\/:\{\$OHMAIL_FRONT_DOOR_PORT:80\} \{$/m)[1]!;
    expect(door.indexOf("handle /version {")).toBeGreaterThanOrEqual(0);
    expect(door.indexOf("handle /version {")).toBeLessThan(door.indexOf("respond `"));
    expect(door).toMatch(/handle \/version \{[\s\S]*?reverse_proxy web:3000\n\t\}/);
  });

  it("the guards bite: each planted page is refused", () => {
    const base = PAGES[0]![1]().body;
    for (const [what, html] of [
      ["a picture", base.replace("<h1 ", `<img src="https://evil.example/x.png"><h1 `)],
      ["a link", base.replace("</head>", `<link rel="stylesheet" href="https://evil.example/a.css"></head>`)],
      ["a script", base.replace("</body>", "<script>1</script></body>")],
      ["an anchor", base.replace("Open it at", `<a href="https://evil.example/">x</a> Open it at`)],
      ["url( in the block", base.replace(".g{background:#0E0D0C !important}", ".g{background:url(https://evil.example/x)}")],
      ["an import", base.replace("@media", "@import 'https://evil.example/a.css';\n@media")],
      ["a request placeholder", base.replace("Open it at", "Opened as {http.request.host}. Open it at")],
      ["the company", base.replace("Open it at", "TrafficFlow GmbH. Open it at")],
      ["a second style", base.replace("</head>", "<style>.x{color:#000000}</style></head>")],
    ] as const) {
      expect(html, what).not.toBe(base);
      expect(problems(html), what).not.toEqual([]);
    }
  });
});

describe("the proxy's entrypoint admits only an origin's characters on the TLS door", () => {
  const resolve = (origin: string | undefined): { out: string; err: string; rc: number | null } => {
    const p = spawnSync("sh", [ENTRYPOINT, "--resolve"], {
      env: { PATH: process.env.PATH ?? "", ...(origin === undefined ? {} : { OHMAIL_ORIGIN: origin }) }, encoding: "utf8",
    });
    return { out: p.stdout.trim(), err: p.stderr.trim(), rc: p.status };
  };
  const REFUSED = "proxy: OHMAIL_ORIGIN is not an http:// or https:// address made of letters, digits, dots, dashes, colons, " +
    "slashes and brackets, so it is not handed to Caddy: write it as https://mail.example.com.";

  it("every origin form the guide names starts, silently", () => {
    for (const v of ["https://mail.example.com", "https://mail.example.com:8443", "http://localhost:3080", "https://mail.example.com/",
      "HTTPS://Mail.Example.com", "https://ohmail.your-tailnet.ts.net", "https://[2001:db8::9]:8443", "https://mäil.example"]) {
      expect(resolve(v), v).toEqual({ out: "", err: "", rc: 0 });
    }
  });

  it("anything else exits 78 before Caddy reads it, and the value is not echoed", () => {
    for (const v of [undefined, "", "<b>", "https://a.example\"", "https://a b", "https://a.example\nx", "{env.HOME}",
      "https://a.example}", "https://a&b.example", "mail.example.com", "javascript:alert(1)", "https://a.example'x", "https://a`b.example", "https://a\\b.example"]) {
      expect(resolve(v), JSON.stringify(v)).toEqual({ out: "", err: REFUSED, rc: 78 });
    }
  });
});
