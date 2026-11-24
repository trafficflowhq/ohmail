import { describe, expect, it } from "vitest";
import { HELD_FOLDERS } from "@trafficflow/core/destinations";
import { letterPictures, type EmbeddedPictureSeam, type PictureSeam } from "../../src/reader/letter-seams.js";

/**
 * A LETTER'S PICTURES ARE DECIDED PER LETTER, with its own id. Four letters of one conversation: let in, from a
 * sender not let in yet, from a name that claims a company, and from a company's own unconfirmed address. All hosts
 * are invented.
 */

const WAITING = HELD_FOLDERS[0]!;
const LETTERS = {
  letIn: { id: "m-let-in", folder: "INBOX" },
  waiting: { id: "m-waiting", folder: WAITING },
  claims: { id: "m-claims", folder: "INBOX", senderCheck: { reason: "impersonation", brand: "Bank" } },
  unconfirmed: { id: "m-unconfirmed", folder: "INBOX", senderCheck: { reason: "unverified", brand: "Bank" } },
} as const;

function seam(
  over: Partial<PictureSeam> = {},
): PictureSeam & { consents: string[]; asked: Array<[string, string[]]> } {
  const consents: string[] = [];
  const asked: Array<[string, string[]]> = [];
  return {
    proxyFor: (id) => (url) => `/img?mid=${id}&u=${encodeURIComponent(url)}`,
    consented: () => false,
    consent: (id) => {
      consents.push(id);
    },
    auto: true,
    loadPixels: false,
    resolvedFor: () => new Map(),
    needRemote: (id, urls) => {
      asked.push([id, urls]);
    },
    consents,
    asked,
    ...over,
  };
}

describe("a letter's pictures, with auto on", () => {
  it("each letter's proxy names that letter alone", () => {
    const s = seam();
    for (const letter of Object.values(LETTERS)) {
      const inputs = letterPictures(letter, false, s, "none", true, true);
      expect(inputs.imageProxy!("https://pictures.example/a.png")).toContain(`mid=${letter.id}&`);
      inputs.onRemoteImages?.(["https://pictures.example/b.png"]);
    }
    expect(s.asked.map(([id]) => id)).toEqual(Object.values(LETTERS).map((l) => l.id));
  });

  it("the let-in and the unconfirmed letter load on open; the waiting and the claiming one wait for a press", () => {
    const s = seam();
    const of = (l: (typeof LETTERS)[keyof typeof LETTERS]) => letterPictures(l, false, s, "none", true, true);
    expect(of(LETTERS.letIn).remoteLoaded).toBe(true);
    expect(of(LETTERS.letIn).onLoadRemote).toBeUndefined();
    expect(of(LETTERS.unconfirmed).remoteLoaded).toBe(true);
    for (const held of [LETTERS.waiting, LETTERS.claims]) {
      expect(of(held).remoteLoaded).toBe(false);
      expect(of(held).onLoadRemote).toBeTypeOf("function");
    }
  });

  it("a letter filed where it waits holds its pictures even where it is shown in a let-in place", () => {
    const s = seam();
    expect(
      letterPictures({ id: "m", folder: "INBOX", physicalFolder: WAITING }, false, s, "none", true, true)
        .remoteLoaded,
    ).toBe(false);
  });

  it("a press admits that letter alone", () => {
    const s = seam();
    letterPictures(LETTERS.waiting, false, s, "none", true, true).onLoadRemote!();
    expect(s.consents).toEqual([LETTERS.waiting.id]);
    const after = seam({ consented: (id) => s.consents.includes(id) });
    expect(letterPictures(LETTERS.waiting, false, after, "none", true, true).remoteLoaded).toBe(true);
    expect(letterPictures(LETTERS.claims, false, after, "none", true, true).remoteLoaded).toBe(false);
  });
});

describe("what fails closed", () => {
  it("no seam: nothing loads, no address, no press, not even what the server once loaded", () => {
    for (const letter of Object.values(LETTERS)) {
      const inputs = letterPictures(letter, true, "none", "none", true, true);
      expect(inputs).toMatchObject({ remoteLoaded: false, imageProxy: null, loadTrackingPixels: false });
      expect(inputs.onLoadRemote).toBeUndefined();
      expect(inputs.onRemoteImages).toBeUndefined();
    }
  });

  it("auto off: every letter asks", () => {
    const s = seam({ auto: false });
    for (const letter of Object.values(LETTERS)) {
      const inputs = letterPictures(letter, false, s, "none", true, true);
      expect(inputs.remoteLoaded).toBe(false);
      expect(inputs.onLoadRemote).toBeTypeOf("function");
    }
  });

  it("not read off the presented mirror: auto on, every letter still asks", () => {
    const s = seam();
    for (const letter of Object.values(LETTERS)) {
      const inputs = letterPictures(letter, false, s, "none", true, false);
      expect(inputs.remoteLoaded).toBe(false);
      expect(inputs.onLoadRemote).toBeTypeOf("function");
    }
  });

  it("the pixel switch is the account's: off stays off whatever loads", () => {
    expect(letterPictures(LETTERS.letIn, false, seam(), "none", true, true).loadTrackingPixels).toBe(false);
    expect(
      letterPictures(LETTERS.letIn, false, seam({ loadPixels: true }), "none", true, true).loadTrackingPixels,
    ).toBe(true);
  });

  it("a letter only peeked at asks for no embedded picture", () => {
    const needs: Array<[string, string[]]> = [];
    const embedded: EmbeddedPictureSeam = {
      cidImagesOf: () => new Map(),
      needCidImages: (id, cids) => {
        needs.push([id, cids]);
      },
    };
    expect(letterPictures(LETTERS.letIn, false, seam(), embedded, false, true).onCidImages).toBeUndefined();
    letterPictures(LETTERS.letIn, false, seam(), embedded, true, true).onCidImages!(["logo"]);
    expect(needs).toEqual([[LETTERS.letIn.id, ["logo"]]]);
  });

  it("the letter on screen asks for its embedded pictures first; the others do not", () => {
    const needs: Array<[string, string[], { first?: boolean } | undefined]> = [];
    const embedded: EmbeddedPictureSeam = {
      cidImagesOf: () => new Map(),
      needCidImages: (id, cids, opts) => {
        needs.push([id, cids, opts]);
      },
    };
    letterPictures(LETTERS.letIn, false, seam(), embedded, true, true, true).onCidImages!(["logo"]);
    letterPictures(LETTERS.unconfirmed, false, seam(), embedded, true, true).onCidImages!(["logo"]);
    expect(needs).toEqual([
      [LETTERS.letIn.id, ["logo"], { first: true }],
      [LETTERS.unconfirmed.id, ["logo"], undefined],
    ]);
  });
});
