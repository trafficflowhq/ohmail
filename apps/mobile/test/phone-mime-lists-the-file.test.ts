/**
 * The phone's standalone engine parses mail with the MIME libraries its bundle carries, and the
 * bundler's substitutions (`aliases.js`) choose those, not the workspace. A plain-text message
 * with one PDF must come out of the phone's parser with the row the server's parser writes, or
 * the phone lists something its store does not hold. `bundleProbe` builds under the artifact's
 * own plugin and alias table, so a change to which library copy the phone carries is read here.
 */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeMime } from "../../../packages/core/src/mime.js";

import { REPO, bundleProbe } from "../scripts/bundle-engine.mjs";

const require_ = createRequire(import.meta.url);

const B = "PHONEMIMEMIXED";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4_000, 0x20)]);
/** Plain text and one PDF, the name as each header spells it. */
const raw = (typeName: string, dispositionName: string): Buffer => Buffer.from([
  "Message-ID: <rechnung-0901@example.test>", "From: Walker <walker@example.test>", "To: Kunde <kunde@example.test>",
  "Subject: Rechnung September", "Date: Tue, 01 Sep 2026 08:00:00 +0200", "MIME-Version: 1.0",
  `Content-Type: multipart/mixed; boundary="${B}"`, "",
  `--${B}`, "Content-Type: text/plain; charset=utf-8", "", "Anbei die Rechnung.", "",
  `--${B}`, `Content-Type: application/pdf; name=${typeName}`,
  `Content-Disposition: attachment; ${dispositionName}`, "Content-Transfer-Encoding: base64", "",
  PDF.toString("base64"), `--${B}--`, "",
].join("\r\n"));
const SHAPES = [
  { name: "Rechnung.pdf", raw: raw('"Rechnung.pdf"', 'filename="Rechnung.pdf"') },
  // RFC 2047 in the type, RFC 2231 in the disposition: decoded by the libraries the bundle picks.
  { name: "Rechnung_März.pdf", raw: raw('"=?utf-8?Q?Rechnung=5FM\x3dC3\x3dA4rz.pdf?="', "filename*=utf-8''Rechnung_M%C3%A4rz.pdf") },
];

type Row = {
  filename: string | null; contentType: string; sizeBytes: number; partId: string | null;
  contentId: string | null; inline: boolean; contentSha256: string | null;
};
type Parsed = { hasAttachments: boolean; attachments: readonly Row[]; textBody: string; ownText?: string };
/** Every field the store writes for a part, and the paperclip. */
const rowsOf = (m: Parsed) => ({
  hasAttachments: m.hasAttachments,
  rows: m.attachments.map((a) => ({
    filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, partId: a.partId,
    contentId: a.contentId, inline: a.inline, contentSha256: a.contentSha256,
  })),
});

let dir = "";
let phone: { parse: (b64: string) => Promise<Parsed> };
beforeAll(async () => {
  // By path: the probe's entry sits under `build/`, and the parser's libraries then resolve from
  // `packages/core`, as they do for the engine.
  const mime = JSON.stringify(join(REPO, "packages", "core", "src", "mime.ts"));
  const probe = await bundleProbe(
    `import { normalizeMime } from ${mime};\n`
    + "export const parse = (b64: string) => normalizeMime(Buffer.from(b64, \"base64\"));\n",
  );
  dir = probe.dir;
  // The one native require on this path is the crypto module; Node's answers it, as in
  // `engine-bundle-loads.test.ts`. Every MIME library is inside the probe.
  const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    return request === "react-native-quick-crypto" ? require_("node:crypto") : original.call(this, request, parent, isMain);
  };
  try {
    phone = require_(probe.bundlePath) as typeof phone;
  } finally { Module._load = original; }
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the phone's own parser lists a plain-text message's PDF", () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: one row, a real file, as the server's parser writes it`, async () => {
      const onPhone = rowsOf(await phone.parse(shape.raw.toString("base64")));
      expect(onPhone).toMatchObject({
        hasAttachments: true,
        rows: [{ filename: shape.name, contentType: "application/pdf", sizeBytes: PDF.length, inline: false, contentId: null }],
      });
      expect(onPhone.rows[0]!.contentSha256, "the phone's parser hashed no bytes").toMatch(/^[0-9a-f]{64}$/);
      expect(onPhone, "the phone's parser and the server's disagree").toEqual(rowsOf(await normalizeMime(shape.raw)));
    });
  }
});

describe("the phone's own parser gives a letter of pictures its words", () => {
  it("multipart/related, html root, no text part: the words and the identity's text are the server's", async () => {
    const related = Buffer.from([
      "Message-ID: <bilder@example.test>", "From: Shop <shop@example.test>", "To: kunde@example.test", "Subject: Herbst",
      "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="R"', "",
      "--R", "Content-Type: text/html; charset=utf-8", "",
      '<style>.a{color:red}</style><table><tr><td>Herbst</td><td>Angebot</td></tr></table><div>Die ganze Woche</div><img src="cid:p@x">',
      "--R", "Content-Type: image/png", "Content-ID: <p@x>", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--R--", "",
    ].join("\r\n"));
    const onPhone = await phone.parse(related.toString("base64"));
    const server = await normalizeMime(related);
    expect({ textBody: onPhone.textBody, ownText: onPhone.ownText }).toEqual({ textBody: "Herbst Angebot\n\nDie ganze Woche", ownText: "" });
    expect({ textBody: onPhone.textBody, ownText: onPhone.ownText }).toEqual({ textBody: server.textBody, ownText: server.ownText });
  });
});
