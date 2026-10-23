/* @reads: packages/client-engine/src/html-tree-budget.ts
   The shared tree counter the frame counts with, read as source for its platform-branch check. */
/**
 * ═══ THE FRAME'S LOCKDOWN IS WIRED, NOT ASSUMED ══════════════════════════════════════════════
 *
 * There is no React Native renderer in this workspace (`action-bar-fits.test.ts` records the
 * same absence), so the frame's props are held where they are real: the component source. Each
 * case names the wiring whose absence is a measured bypass — JS on is script execution, a
 * narrow originWhitelist is the library's own `Linking.openURL` escape (read in
 * `WebViewShared.tsx`), a missing polyfill import is a blank box on every device.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const FRAME = read("../src/ui/MailBodyFrame.tsx");
const READER = read("../src/ui/MessageReader.tsx");
const LAYOUT = read("../app/_layout.tsx");
const DOC = read("../src/mail/mail-document.ts");
const TREE = read("../src/mail/frame-tree.ts");
const BUDGET = read("../src/mail/frame-budget.ts");
const COUNTER = read("../../../packages/client-engine/src/html-tree-budget.ts");
const LENGTH = read("../src/mail/frame-length.ts");
const CEILING = read("../src/mail/frame-ceiling.ts");
const CEILING_NATIVE = read("../src/mail/frame-ceiling-native.ts");

describe("the WebView is the web iframe's posture, or stricter", () => {
  it("JavaScript is OFF at the engine level", () => {
    expect(FRAME).toContain("javaScriptEnabled={false}");
  });
  it("the whitelist admits everything SO THAT the handler is the only gate", () => {
    expect(FRAME).toContain("originWhitelist={ALL_ORIGINS}");
    expect(FRAME).toContain('["*"]');
  });
  it("every navigation goes through the one decision", () => {
    expect(FRAME).toContain("onShouldStartLoadWithRequest");
    expect(FRAME).toContain("frameNavDecision(req.url, sanitized.links)");
    expect(FRAME).toContain('return d.kind === "load"');
  });
  it("the document is built html, never a URL source", () => {
    expect(FRAME).toContain("source={{ html: doc }}");
    expect(FRAME).not.toContain("source={{ uri");
  });
  it("the document's CSP admits data: images and nothing else", () => {
    expect(DOC).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  });
  it("a link opens only from the confirm sheet", () => {
    // CODE lines only — the header docblock names the library's opener while describing it.
    const code = FRAME.split("\n").filter((l) => {
      const s = l.trimStart();
      return !s.startsWith("*") && !s.startsWith("//") && !s.startsWith("/*");
    });
    const opens = code.filter((l) => l.includes("Linking.openURL")).length;
    expect(opens).toBe(1);
    expect(FRAME).toContain("Copy.mailOpenLinkTitle");
  });
});

describe("the reader mounts the frame and keeps the text fallback honest", () => {
  it("html mail takes the frame; 'Show as text' is this reading's own choice", () => {
    expect(READER).toContain("<MailBodyFrame m={m} onShowAsText=");
    expect(READER).toContain("Copy.mailShowOriginal");
  });
  it("a tile press opens the bytes and each refusal renders its sentence", () => {
    expect(READER).toContain("openAttachmentBytes(m.id, id)");
    expect(READER).toContain("shareAttachmentBytes(got.base64, got.mime, got.filename)");
    for (const key of ["attachmentTooLarge", "attachmentShareRefused", "attachmentEmbedded"]) {
      expect(READER, key).toContain(`Copy.${key}`);
    }
    // A failed fetch names the side that failed (`attachment-fault-note.ts`), not one sentence for all.
    expect(READER).toContain("attachmentFaultNote(note.fault)");
  });
});

describe("the device prerequisites are installed where they must be", () => {
  it("the Blob.arrayBuffer polyfill is the app entry's FIRST import", () => {
    const imports = LAYOUT.split("\n").filter((l) => l.trimStart().startsWith("import "));
    expect(imports[0]).toContain("polyfills/blob-arraybuffer");
  });
  it("the engine ask and the consent fetch are the frame's only fetching effects", () => {
    expect(FRAME).toContain("loadInlineImages(m.id, sanitized.cids)");
    expect(FRAME).toContain("fetchRemoteImages(route, m.id, urls, { consented, budget: log.budget })");
    expect(FRAME).toContain("const route = w.images;");
    expect(FRAME).toContain("imagesSeenBy(route)");
  });
});

describe("the frame is mounted only over a counted tree (`src/mail/frame-tree.ts`)", () => {
  /** Code lines only: the header docblock names the library while describing it. */
  const code = (src: string): string => src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
  }).join("\n");

  it("the WebView mounts only a counted document, a same-height View standing in until there is one", () => {
    const at = FRAME.indexOf("{doc !== null ? (");
    const web = FRAME.indexOf("<WebView", at);
    const stand = FRAME.indexOf("<View style={{ height, backgroundColor: t.c.canvas }} />", web);
    expect(at).toBeGreaterThan(-1);
    expect(web).toBeGreaterThan(at);
    expect(stand).toBeGreaterThan(web);
    expect(code(FRAME).split("<WebView").length - 1).toBe(1);
  });

  it("a mailto the frame is asked to open goes to ohmail's composer, from inside the gated frame", () => {
    // Two rows met in this handler at one landing: the tree bound's gate and the mailto press.
    const at = FRAME.indexOf("{doc !== null ? (");
    const nav = FRAME.indexOf(
      'if (d.kind === "compose") router.push({ pathname: "/compose", params: { mailto: d.url } });', at);
    expect(at).toBeGreaterThan(-1);
    expect(nav, "the frame's link handler no longer opens a mailto in the composer").toBeGreaterThan(at);
  });

  it("the counted document is the one handed to the WebView, and a drawn one only ever came from a fitted count", () => {
    expect(FRAME).toContain("const current = useMemo(() => (tooLong ? null : buildPhoneMailDocument(sanitized.html, theme)), [tooLong, sanitized.html, theme]);");
    expect(FRAME).toMatch(/current === null \? planFrameLength\(drawnChars \?\? 0, ceiling\) : planFrameCount\(current, sanitized\.oversize === true, ceiling\)/);
    expect(FRAME).toContain("const kept = drawn !== null && drawn.id === frameId && drawn.html === html ? drawn.doc : null;");
    expect(FRAME).toContain('const shows = frameShows(reading, current, kept, sanitized.oversize === true, barePlan === null ? "none" : bareReading);');
    expect(FRAME).toContain('const doc = shows.show === "frame" ? shows.doc : null;');
    expect(FRAME).toContain("if (count.reading.fits) setDrawn({ id, html, doc: plan.key });");
    expect(code(FRAME).split("buildPhoneMailDocument(").length - 1).toBe(2);
  });

  it("the pictures are written only into a document whose length was read inside the ceiling first", () => {
    expect(FRAME).toContain("const bare = useMemo(() => (folding ? folded : sanitizeMailHtmlPhone(html, {})), [folding, folded, html]);");
    expect(FRAME).toMatch(/pictured \? drawnLength\(html, pictures, bare, theme\) : null/);
    expect(FRAME).toContain("const tooLong = drawnChars !== null && drawnChars > ceiling;");
    expect(FRAME).toContain("(pictured && !tooLong ? sanitizeMailHtmlPhone(html, pictures) : bare)");
    // The bare document, the pictured one, and the picture-free fold reading (`{ fold: true }`).
    expect(FRAME).toContain("const folded = useMemo(() => sanitizeMailHtmlPhone(html, { fold: true }), [html]);");
    expect(code(FRAME).split("sanitizeMailHtmlPhone(").length - 1).toBe(3);
    expect(code(FRAME).split("drawnLength(").length - 1).toBe(1);
  });

  it("the length ceiling is this phone's, read once and handed to both the length read and the count", () => {
    expect(FRAME).toContain('import { phoneFrameCeiling } from "../mail/frame-ceiling-native";');
    expect(FRAME).toContain("const ceiling = useMemo(() => phoneFrameCeiling(), []);");
    expect(code(FRAME)).not.toContain("PHONE_FRAME_MAX_CHARS");
    expect(code(FRAME).split("phoneFrameCeiling(").length - 1).toBe(1);
    expect(CEILING_NATIVE).toContain('requireOptionalNativeModule<HeapReaders>("OhmailPosture")');
    expect(CEILING_NATIVE).toContain("ceiling = phoneFrameMaxChars(deviceHeapOf(mod));");
    expect(code(CEILING_NATIVE)).toMatch(/try \{\s*mod = requireOptionalNativeModule[^;]*;\s*\} catch \{\s*mod = null;\s*\}/);
  });

  it("a refused reading renders the text part with the oversize sentence, unless a fitted document is kept", () => {
    // …and a document too tall to draw as one page (`src/mail/frame-height.ts`) takes the same path.
    expect(FRAME).toContain('if (shows.show === "text" || sized.text !== null) {');
    expect(FRAME).toMatch(/const lead = shows\.show === "frame" && shows\.withheld\s*\? Copy\.mailImagesTooLarge/);
  });

  it("one count per mounted document, started once and cancelled on cleanup, its reading for that document", () => {
    expect(code(FRAME).split("startFrameCount(").length - 1).toBe(1);
    expect(FRAME).toMatch(/return \(\) => \{\s*alive = false;\s*cancel\(\);\s*\};\s*\}, \[plan, id, html, setDrawn\]\);/);
    expect(FRAME).toContain("return plan === null ? null : frameReadingOf(plan, counted);");
    expect(FRAME).toContain("const reading = useFrameCount(plan, frameId, html, setDrawn);");
  });

  it("a pictured state refused with nothing kept counts the bare document, never the text part for its pictures' sake", () => {
    expect(FRAME).toContain("const needBare = pictured && kept === null && reading !== null && !reading.fits;");
    expect(FRAME).toContain("(needBare ? planFrameCount(buildPhoneMailDocument(bare.html, theme), bare.oversize === true, ceiling) : null)");
    expect(FRAME).toContain("const bareReading = useFrameCount(barePlan, frameId, html, setDrawn);");
    expect(code(FRAME).split("useFrameCount(").length - 1).toBe(3);
  });

  it("no platform branch in the count's modules: Android and iOS count alike", () => {
    for (const [name, src] of [["frame-tree.ts", TREE], ["frame-budget.ts", BUDGET], ["html-tree-budget.ts", COUNTER], ["frame-length.ts", LENGTH], ["frame-ceiling.ts", CEILING], ["frame-ceiling-native.ts", CEILING_NATIVE]] as const) {
      expect(src, name).not.toMatch(/\bPlatform\b/);
    }
  });
});
