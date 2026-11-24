/**
 * Two libraries leave the phone's engine through `apps/sidecar/src/phone/aliases.js`: the zip
 * archiver (only the download-all routes build an archive, and the phone's app never asks for
 * one) and sanitize-html's CSS parser (the outbound policy matches complete style values
 * with parsing disabled). This file reads both out of the artifact's
 * graph, and drives the paths that STAY through a bundle built under the same table: outbound
 * sanitizing, which must answer exactly what the workspace's copy answers, and the attachment
 * byte check the single-attachment download runs.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sanitizeOutboundHtml } from "../../../packages/services/src/outbound-html.js";
import { REPO, buildPhoneEngine, bundleProbe } from "../scripts/bundle-engine.mjs";

const require_ = createRequire(import.meta.url);
const LEFT_OUT = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(jszip|postcss|pako|source-map-js)\//;

type Fetched = { contentType: string; filename: string | null; body: Uint8Array };
type Probe = {
  sanitize: (html: string) => string;
  verifiedPart: (row: { id: string; partId: string | null; contentSha256: string | null }, f: Fetched) => Fetched;
  makeZip: () => unknown;
  parseCss: (css: string) => unknown;
};

describe("the artifact carries neither library", () => {
  it("no zip, deflate, CSS or source-map module is an input of the phone engine, and both shims are", async () => {
    const { inputs } = await buildPhoneEngine({ write: false });
    expect(inputs.filter((p: string) => LEFT_OUT.test(p))).toEqual([]);
    expect(inputs.filter((p: string) => /shims\/(jszip|postcss)\.js$/.test(p)).sort())
      .toEqual(["apps/mobile/src/engine/shims/jszip.js", "apps/mobile/src/engine/shims/postcss.js"]);
    // The modules that import them are still in, so the shims answer a real importer.
    expect(inputs.some((p: string) => /services\/(dist|src)\/attachments-service\.(js|ts)$/.test(p))).toBe(true);
    expect(inputs.some((p: string) => /sanitize-html\/index\.js$/.test(p))).toBe(true);
  });
});

describe("on a bundle built under the same table", () => {
  let dir = "";
  let phone: Probe;
  let probeInputs: string[] = [];
  beforeAll(async () => {
    const src = (f: string) => JSON.stringify(join(REPO, "packages", "services", "src", f));
    const probe = await bundleProbe(
      `import { sanitizeOutboundHtml } from ${src("outbound-html.ts")};\n`
      + `import { verifiedPart } from ${src("attachments-service.ts")};\n`
      + "import JSZip from \"jszip\";\nimport { parse } from \"postcss\";\n"
      + "export const sanitize = sanitizeOutboundHtml;\nexport { verifiedPart };\n"
      + "export const makeZip = () => new JSZip();\nexport const parseCss = (css: string) => parse(css);\n",
    );
    dir = probe.dir;
    probeInputs = Object.keys((probe.metafile as { inputs: Record<string, unknown> }).inputs);
    // The one native require on these paths is the crypto module; Node's answers it.
    const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
    const original = Module._load;
    Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
      return request === "react-native-quick-crypto" ? require_("node:crypto") : original.call(this, request, parent, isMain);
    };
    try {
      phone = require_(probe.bundlePath) as Probe;
    } finally { Module._load = original; }
  }, 120_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the probe is built under the same table", () => {
    expect(probeInputs.filter((p) => LEFT_OUT.test(p))).toEqual([]);
  });

  it("a zip or a CSS parse on the phone refuses with a sentence", () => {
    expect(() => phone.makeZip()).toThrow(/zip is not available in this app/);
    expect(() => phone.parseCss("p { color: red }")).toThrow(/CSS parsing is not available/);
  });

  describe("the paths that stay answer as the workspace's copies do", () => {
    const CORPUS = [
      "<p style=\"color:red\" onclick=\"x()\">Hi <a href=\"https://example.test/\" style=\"font-weight:bold\">link</a></p>",
      "<div style=\"background:url(javascript:alert(1))\">body</div>",
      "<a href=\"javascript:alert(1)\">x</a><a href=\"//evil.example/x\">y</a>",
      "<script>evil()</script><style>p { color: red }</style><b>kept</b> text",
    ];
    for (const html of CORPUS) {
      it(`sanitizes ${JSON.stringify(html.slice(0, 40))} exactly as the workspace does`, () => {
        const onPhone = phone.sanitize(html);
        expect(onPhone).toBe(sanitizeOutboundHtml(html));
        expect(onPhone).not.toMatch(/style=|javascript:|<script/);
      });
    }

    it("keeps the exact saved paragraph and list styles on the phone", () => {
      const html = '<p style="margin:0">Words</p><ol style="margin-top:0;margin-bottom:0"><li>Item</li></ol>';
      expect(phone.sanitize(html)).toBe(html);
      expect(sanitizeOutboundHtml(html)).toBe(html);
    });

    it("the single-attachment byte check serves the row's file and refuses another part", () => {
      const body = new TextEncoder().encode("%PDF-1.4 the row's own file");
      const fetched = { contentType: "application/pdf", filename: "Rechnung.pdf", body };
      const sha = createHash("sha256").update(body).digest("hex");
      expect(phone.verifiedPart({ id: "a1", partId: "2", contentSha256: sha }, fetched)).toBe(fetched);
      expect(() => phone.verifiedPart({ id: "a1", partId: "2", contentSha256: "0".repeat(64) }, fetched))
        .toThrow(/could not be verified/);
    });
  });
});
