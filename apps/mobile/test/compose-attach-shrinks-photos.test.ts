/**
 * A NORMAL PHONE PHOTO ATTACHES — shrunk before the cap, as the web shrinks it. Measured at the
 * base: the picker handed over the original (a 12-24 MP photo is commonly over 3 MiB) and the
 * admit rule refused it against the phone's inline cap, where the web would first have fitted it
 * to 2048 px at 0.82 and attached it.
 *
 * The decision is `shrinkPicked` (`src/compose/attach.ts`) over the ONE level table in
 * `@ohmail/client-engine`, which the webapp now re-exports; the re-encode itself is the native
 * twin's (expo-image-manipulator), stood in here by a fake that answers what a manipulator does.
 * The sheet is read to prove the pick shrinks before it admits.
 */
/* @reads: apps/mobile/src/ui/MessageActions.tsx apps/mobile/src/compose/attach-native.ts apps/webapp/app/components/image-quality.ts */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_QUALITY_LEVEL, admitPicked, base64SizeBytes, phoneAttachCap, shrinkPicked,
  type ImageShrink, type PhoneComposeAttachment,
} from "../src/compose/attach";
import { decodePictureQuality, pictureQualityStore } from "../src/state/picture-quality-store";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(APP, rel), "utf8");

const MIB = 1024 * 1024;
/** A base64 string that decodes to `bytes` bytes (no padding when bytes % 3 === 0). */
const b64Of = (bytes: number): string => "A".repeat(Math.ceil(bytes / 3) * 4);

function photo(bytes: number, over: Partial<PhoneComposeAttachment> = {}): PhoneComposeAttachment {
  const contentBase64 = b64Of(bytes);
  return {
    filename: "IMG_2041.JPG", contentType: "image/jpeg", contentBase64,
    sizeBytes: base64SizeBytes(contentBase64), uri: "file:///picked/IMG_2041.JPG", ...over,
  };
}

/** What a manipulator answers for a 12 MP photo fitted to 2048 px: well under a megabyte. */
const asked: Array<{ uri: string; type: string; maxEdge: number; quality: number }> = [];
const shrinkTo = (bytes: number): ImageShrink => async (uri, type, rule) => {
  asked.push({ uri, type, maxEdge: rule.maxEdge, quality: rule.quality });
  return b64Of(bytes);
};

describe("a picked photo is shrunk before the cap, by the web's own table", () => {
  const cap = phoneAttachCap([], "mb-1");

  it("a 4.5 MiB photo the base refused now attaches at the default level", async () => {
    const big = photo(4.5 * 1024 * 1024);
    // THE BASE: the original against the cap — refused.
    expect(admitPicked([], [big], cap).overCap, "the premise: the original is over the cap").toBe(1);
    asked.length = 0;
    const picked = await shrinkPicked([big], DEFAULT_IMAGE_QUALITY_LEVEL, shrinkTo(700 * 1024));
    const admit = admitPicked([], picked, cap);
    expect(admit.overCap).toBe(0);
    expect(admit.next).toHaveLength(1);
    expect(admit.next[0]!.sizeBytes).toBeLessThan(MIB);
    // The web's medium row, asked of the manipulator for this picture.
    expect(asked).toEqual([{ uri: big.uri, type: "image/jpeg", maxEdge: 2048, quality: 0.82 }]);
  });

  it("Original is kept when the person asks for it, and is never re-encoded", async () => {
    asked.length = 0;
    const big = photo(4.5 * MIB);
    const picked = await shrinkPicked([big], "original", shrinkTo(700 * 1024));
    expect(asked).toHaveLength(0);
    expect(picked[0]).toBe(big);
  });

  it("a re-encode that is not smaller is dropped, and a failed one keeps the picked bytes", async () => {
    const small = photo(200 * 1024);
    expect((await shrinkPicked([small], "medium", shrinkTo(300 * 1024)))[0]).toBe(small);
    expect((await shrinkPicked([small], "medium", async () => null))[0]).toBe(small);
    expect((await shrinkPicked([small], "medium", async () => { throw new Error("decode failed"); }))[0]).toBe(small);
  });

  it("only JPEG and PNG are touched — a GIF, a PDF and a file with no source pass as picked", async () => {
    asked.length = 0;
    const gif = photo(MIB, { filename: "a.gif", contentType: "image/gif" });
    const pdf = photo(MIB, { filename: "a.pdf", contentType: "application/pdf" });
    const unsourced = photo(MIB, { uri: undefined });
    const out = await shrinkPicked([gif, pdf, unsourced], "low", shrinkTo(10));
    expect(out).toEqual([gif, pdf, unsourced]);
    expect(asked).toHaveLength(0);
    // `image/jpg` is the same format under a picker's spelling, and comes back as image/jpeg.
    const jpg = photo(MIB, { contentType: "image/jpg" });
    expect((await shrinkPicked([jpg], "low", shrinkTo(1000)))[0]!.contentType).toBe("image/jpeg");
  });

  it("the default is medium, and the stored level decodes only the four names", () => {
    expect(DEFAULT_IMAGE_QUALITY_LEVEL).toBe("medium");
    expect(decodePictureQuality("high")).toBe("high");
    expect(decodePictureQuality("huge")).toBeNull();
    expect(decodePictureQuality(null)).toBeNull();
  });

  it("a boot read that resolves after a press does not publish the pre-press level", async () => {
    let answer: (v: string | null) => void = () => {};
    const kv = {
      get: () => new Promise<string | null>((r) => { answer = r; }),
      set: async () => {}, remove: async () => {},
    };
    const seen: string[] = [];
    const store = pictureQualityStore(kv, (l) => seen.push(l));
    const booting = store.boot();
    store.set("original");
    answer("low");
    await booting;
    expect(seen).toEqual(["original"]);
  });
});

describe("the native module is the version this SDK was built with", () => {
  /* The manipulator ships PREBUILT frameworks compiled against one expo-modules-core. 57.0.20's
     references `BaseModule.willDestroy`, which the installed core does not export, and the iOS
     app died at launch (dyld: symbol missing) on the lane's simulator. The pin is the version the
     installed `expo` bundles, read from its own table. */
  it("pins expo-image-manipulator exactly to the lower bound expo's bundledNativeModules names", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const expoDir = dirname(createRequire(join(APP, "package.json")).resolve("expo/package.json"));
    const bundled = JSON.parse(readFileSync(join(expoDir, "bundledNativeModules.json"), "utf8")) as Record<string, string>;
    const range = bundled["expo-image-manipulator"]!;
    expect(range).toMatch(/^~\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["expo-image-manipulator"]).toBe(range.slice(1));
  });
});

describe("one table, and the sheet shrinks before it admits", () => {
  it("the webapp re-exports the shared table and keeps no second copy of the numbers", () => {
    const web = readFileSync(resolve(APP, "../webapp/app/components/image-quality.ts"), "utf8");
    expect(web).toMatch(/IMAGE_QUALITY_RULES,[\s\S]*?\} from "@ohmail\/client-engine";/);
    expect(web).not.toMatch(/export const IMAGE_QUALITY_RULES/);
    expect(web).not.toMatch(/maxEdge: 2048/);
  });

  it("the pick shrinks at the chosen level and only then admits", () => {
    const sheet = read("src/ui/MessageActions.tsx");
    const pick = sheet.slice(sheet.indexOf("const pick = async ("), sheet.indexOf("const [later, setLater]"));
    const shrinkAt = pick.indexOf("await shrinkPicked(outcome.files, pictureQuality, nativeImageShrink)");
    const admitAt = pick.indexOf("admitPicked(attachments, picked, attachCap)");
    expect(shrinkAt).toBeGreaterThan(0);
    expect(admitAt).toBeGreaterThan(shrinkAt);
  });

  it("the native twin hands the picked file's own source to the shrink", () => {
    const native = read("src/compose/attach-native.ts");
    expect(native).toContain("toAttachment(base64, name, asset.mimeType, asset.uri)");
    expect(native).toContain("toAttachment(base64, asset.name, asset.mimeType, asset.uri)");
    expect(native).toContain("ImageManipulator.manipulate(");
  });
});
