/**
 * THE OHMARCHY FACE ON THE PHONE — the tokens, the generation that produced them, the two
 * scopes that pick one, and the arm this platform deliberately does not have.
 *
 * OHMARCHY-PLAN.md §3a is the spec; OHMARCHY-CONTRACT.md names the axes. The webapp's one-UI
 * census does not govern this app (the contract says so, because this app has its own theming
 * machinery), so the structural guarantees the census gives over there have to be held here, by
 * behaviour. Four of them, and each has a mutation named beside it:
 *
 *  · **THE FACE IS THE WEB'S FACE.** Every shipped value is the tokens package's ohmarchy JSON
 *    — the same generated set the browser and desktop wear — projected onto React Native's
 *    shapes. Nothing is hand-picked, and the generation is re-run in-process and diffed, so a
 *    hand edit of `src/theme/ohmarchy.ts` cannot survive this file.
 *  · **PAPER IS UNTOUCHED.** Adding a face may not move a single paper value. Held by
 *    byte-comparison against the authored palette and the transcribed lift ladder, which is the
 *    mobile twin of `packages/tokens/test/faces-paper-purity.test.ts`.
 *  · **THE SCOPE LAW.** Device pin beats the account; the account beats nothing; nothing is
 *    paper. `resolveFace` is the whole of it.
 *  · **NO DETECTION ARM.** The web defaults a Linux DESKTOP to ohmarchy (plan §12, Option B).
 *    A phone gets no such default, and the scan below keeps one from arriving quietly: every
 *    Android phone reports a Linux kernel, so the web's arm ported here would flip the whole
 *    Android install to a tiling desktop face nobody asked for. Stated as the judgment it is in
 *    `src/theme/face.ts`.
 *
 * MUTATIONS RUN AND RESTORED (each named at its own test):
 *  · `paletteOf` ignoring its `face` argument → the swap tests go red;
 *  · a hand edit of one generated hex → the regeneration diff goes red;
 *  · `resolveFace` returning `account ?? pin ?? "paper"` → the pin-outranks test goes red;
 *  · `lift()` dropping its `face` argument → the ladder test goes red;
 *  · the radius ratio snapping to the band value → the derivation test goes red.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import {
  DEFAULT_FACE,
  accountGovernsFace,
  accountWideOffered,
  faceOf,
  resolveFace,
  teachOf,
  type FaceName,
} from "../src/theme/face";
import { lift, liftUp, liftLayers } from "../src/theme/lift";
import { ohmarchyEasing, ohmarchyLift, ohmarchyPalettes, ohmarchyRadius } from "../src/theme/ohmarchy";
import { css } from "../src/theme/oklch";
import { authored, paletteOf, palettes, type SchemeName } from "../src/theme/palette";
import { motion, radius } from "../src/theme/tokens";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const SCHEMES: SchemeName[] = ["light", "dark"];

/**
 * The generator, imported for its RENDERER alone. It guards its own side effects on being the
 * entry point, so importing it writes nothing — which is the whole reason the diff below can
 * observe a hand edit instead of silently repairing one. Imported by runtime path (the
 * `.mjs` is outside this app's tsconfig `include`), exactly as
 * `packages/tokens/test/ohmarchy-regeneration.test.ts` imports mapping.js.
 */
const GEN = (await import(here("../scripts/generate-ohmarchy.mjs"))) as {
  FACE_JSON: string;
  FACE_MODULE: string;
  renderOhmarchyModule: (face: unknown) => string;
};

/** The shipping web face — this projection's single source. */
const web = JSON.parse(readFileSync(GEN.FACE_JSON, "utf8")) as Record<
  string,
  Record<string, string>
>;
const slot = (scheme: SchemeName, name: string): string => web[`ohmarchy-${scheme}`]![name]!;

/* ─────────────────────────────────────────── the generation, and its committed output */

describe("the face is GENERATED from the web face, and the committed file proves it", () => {
  it("re-running the generation in-process reproduces src/theme/ohmarchy.ts byte for byte", () => {
    /* THE HAND-EDIT GATE. Mutation: change one hex in the committed module (`--accent`'s
       #7aa2f7 → #7aa2f8) → this fails with the two texts differing. The generator is imported
       for its RENDERER only; it writes nothing on import (it guards its side effects on being
       the entry point), which is what lets this compare rather than overwrite. */
    const committed = readFileSync(GEN.FACE_MODULE, "utf8");
    expect(GEN.renderOhmarchyModule(web)).toBe(committed);
  });

  it("the source really is the web face — the committed module names no value of its own", () => {
    /* Independent of the generator: every colour the module ships is read back out of
       ohmarchy.json here, so a generator that quietly substituted a value would still be
       caught. The ten tag hues are the tokens' wheel; three keep the prototype's CSS slot names
       (pottery / buch / privat), the correspondence the paper side already pins. The
       glass pair is the one DERIVED entry — paper's alphas over this face's own float and ink
       (`palette.ts#glassAuthored` is the rule's source) — so its expectation derives it here a
       second time, from the slots, never from the module under test. */
    const rgbaOf = (hex: string, a: number) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };
    for (const scheme of SCHEMES) {
      const p = ohmarchyPalettes[scheme];
      expect(p).toEqual({
        scheme,
        glass: rgbaOf(slot(scheme, "--float"), scheme === "light" ? 0.8 : 0.78),
        glassBrd: rgbaOf(slot(scheme, "--ink"), 0.1),
        glassFlat: rgbaOf(slot(scheme, "--float"), 0.94),
        canvas: slot(scheme, "--canvas"),
        panel: slot(scheme, "--panel"),
        float: slot(scheme, "--float"),
        ink: slot(scheme, "--ink"),
        ink2: slot(scheme, "--ink2"),
        ink3: slot(scheme, "--ink3"),
        hair: slot(scheme, "--hair"),
        hairSoft: slot(scheme, "--hair-soft"),
        tint: slot(scheme, "--tint"),
        tint2: slot(scheme, "--tint2"),
        accent: slot(scheme, "--accent"),
        accentInk: slot(scheme, "--accent-ink"),
        accentSoft: slot(scheme, "--accent-soft"),
        accentHair: slot(scheme, "--accent-hair"),
        onAccent: slot(scheme, "--on-accent"),
        scrim: slot(scheme, "--scrim"),
        unreadWash: slot(scheme, "--unread-wash"),
        markRead: Number(slot(scheme, "--mark-read")),
        markMine: Number(slot(scheme, "--mark-mine")),
        tag: {
          moss: { ink: slot(scheme, "--tg-pottery-ink"), bg: slot(scheme, "--tg-pottery-bg") },
          ochre: { ink: slot(scheme, "--tg-buch-ink"), bg: slot(scheme, "--tg-buch-bg") },
          rosewood: { ink: slot(scheme, "--tg-privat-ink"), bg: slot(scheme, "--tg-privat-bg") },
          ...Object.fromEntries(
            ["olive", "verdigris", "denim", "indigo", "iris", "mulberry", "heather"].map((h) => [
              h, { ink: slot(scheme, `--tg-${h}-ink`), bg: slot(scheme, `--tg-${h}-bg`) },
            ]),
          ),
        },
      });
    }
  });

  it("REACT NATIVE'S OWN PARSER accepts every shipped colour, palette and lift alike", () => {
    /**
     * THE ONE THING THIS PROJECTION COULD GET WRONG SILENTLY. A colour React Native cannot read
     * renders as *nothing* on the device and throws nowhere — no test that only compares strings
     * would see it, and the face would simply be invisible on a phone. The web face is authored
     * for a browser, which reads `oklch()`, `hsl()` and named colours that RN does not.
     *
     * So the check is not a regex of what this file believes RN accepts: it is
     * `@react-native/normalize-colors`, the exact module `processColor` uses at runtime, resolved
     * from the installed `react-native` so it is that version's parser and not a guess. `null` is
     * its "I cannot read this", which is precisely the failure mode being ruled out.
     *
     * Mutation: put `oklch(0.5 0.1 60)` into one generated slot → red here, green everywhere else
     * in this file.
     */
    const req = createRequire(require.resolve("react-native/package.json"));
    const normalize = req("@react-native/normalize-colors") as (c: string) => number | null;
    // Not vacuous: the parser really does refuse what a browser would take.
    expect(normalize("#7aa2f7")).not.toBeNull();
    expect(normalize("oklch(0.5 0.1 60)")).toBeNull();

    for (const scheme of SCHEMES) {
      const p = ohmarchyPalettes[scheme];
      const values: [string, string][] = [
        ...Object.entries(p)
          .filter(([k, v]) => k !== "scheme" && k !== "tag" && typeof v === "string")
          .map(([k, v]) => [k, v as string] as [string, string]),
        ...Object.entries(p.tag).flatMap(([hue, t]): [string, string][] => [
          [`tag.${hue}.ink`, t.ink],
          [`tag.${hue}.bg`, t.bg],
        ]),
        ...Object.entries(ohmarchyLift[scheme]).flatMap(([level, layers]): [string, string][] =>
          layers.map((l, i) => [`lift.${level}[${i}]`, l.color] as [string, string]),
        ),
      ];
      // 17 colour slots + the three derived glass values + 10 tag hues × 2 + 6 lift levels × 1 flat ring each
      // (the two mark opacities are numbers, not colours).
      expect(values.length).toBe(46);
      for (const [key, value] of values) {
        expect(normalize(value), `${scheme}.${key} = ${value}`).not.toBeNull();
      }
    }
  });
});

/* ────────────────────────────────────────────────────── the four projections, by behaviour */

describe("colour: the face picks the palette, the scheme picks within it", () => {
  it("paletteOf answers the ohmarchy set for ohmarchy and the paper set for paper", () => {
    /* Mutation: make `paletteOf` ignore its second argument → both halves fail. */
    for (const scheme of SCHEMES) {
      expect(paletteOf(scheme, "ohmarchy")).toBe(ohmarchyPalettes[scheme]);
      expect(paletteOf(scheme, "paper")).toBe(palettes[scheme]);
      // …and an omitted face is paper, which is what keeps every existing caller unchanged.
      expect(paletteOf(scheme)).toBe(palettes[scheme]);
    }
  });

  it("the two faces really differ — the swap is not a no-op dressed as one", () => {
    for (const scheme of SCHEMES) {
      expect(paletteOf(scheme, "ohmarchy").canvas).not.toBe(paletteOf(scheme, "paper").canvas);
      expect(paletteOf(scheme, "ohmarchy").accent).not.toBe(paletteOf(scheme, "paper").accent);
    }
  });

  it("PAPER IS UNTOUCHED — every authored value still resolves to what it always did", () => {
    /* The mobile twin of faces-paper-purity: a face may not move a paper value. Re-derived
       from `authored` rather than compared against a transcript, so this cannot be satisfied by
       editing a copy of the answer. */
    for (const scheme of SCHEMES) {
      const p = paletteOf(scheme, "paper");
      const a = authored[scheme]!;
      expect(p.canvas).toBe(css(a.canvas!));
      expect(p.ink).toBe(css(a.ink!));
      expect(p.accent).toBe(css(a.accent!));
      expect(p.hair).toBe(css(a.hair!));
      expect(p.tag.moss.ink).toBe(css(a.tagMossInk!));
    }
  });
});

describe("radius: the ladder collapses through faces.css's own ratio rule", () => {
  it("every ohmarchy radius is 0, because the face's whole radius ladder is 0", () => {
    for (const band of ["--r-ctl", "--r-card", "--r-overlay", "--r-pill"]) {
      expect(slot("dark", band), `${band} is the derivation's input`).toBe("0");
    }
    for (const key of Object.keys(radius) as (keyof typeof radius)[]) {
      expect(ohmarchyRadius[key], `ohmarchyRadius.${key}`).toBe(0);
    }
  });

  it("the paper ladder is unmoved, off-band values included", () => {
    // `menuItem` 11 and `reader` 28 are the off-band pair the ratio rule exists for: they sit
    // between / past the bands and must keep their exact paper number under paper.
    expect(radius.menuItem).toBe(11);
    expect(radius.reader).toBe(28);
    expect(radius.pill).toBe(999);
  });

  it("the derivation is a RATIO, not a snap — a non-zero band would scale, not flatten", () => {
    /* THE MUTATION THIS NAMES: `generate-ohmarchy.mjs` snapping each key to its band value
       (`bandValue[band]` instead of `paper/PAPER_BAND × bandValue`) is invisible against a face
       whose bands are all 0 — every key is 0 either way. So the rule is checked on its own
       terms here, against the generator's own arithmetic, with a band that is NOT zero. */
    const ratio = (paper: number, paperBand: number, faceBand: number) =>
      (paper / paperBand) * faceBand;
    expect(ratio(11, 14, 4)).toBeCloseTo(3.14, 2); // menuItem under a --r-card: 4px face
    expect(ratio(14, 14, 4)).toBe(4); // an ON-band key does land on the band value
    expect(ratio(11, 14, 0)).toBe(0); // …and every key still collapses under ohmarchy's 0
  });
});

describe("lift: ohmarchy reads its structure from rings, paper from layered shadows", () => {
  it("the ohmarchy ladder is the generated ring, and lift() serves it under that face", () => {
    /* Mutation: drop the `face` argument from `lift()` → this fails, because the paper ladder's
       l0 is a three-layer warm stack and ohmarchy's is a single ring. */
    for (const scheme of SCHEMES) {
      const style = lift(scheme, "l0", "ohmarchy");
      expect(style.boxShadow).toEqual(ohmarchyLift[scheme].l0);
      expect(ohmarchyLift[scheme].l0).toHaveLength(1);
      expect(ohmarchyLift[scheme].l0[0]!.blurRadius).toBe(0);
      expect(ohmarchyLift[scheme].l0[0]!.spreadDistance).toBe(1);
    }
  });

  it("PAPER'S ladder is untouched — same layers, offsets, blurs, spreads and colours", () => {
    for (const scheme of SCHEMES) {
      for (const level of ["l0", "l1", "l2", "l3", "barEdge", "sheetEdge"] as const) {
        const want = liftLayers(scheme, level).map((l) => ({
          offsetX: l.x, offsetY: l.y, blurRadius: l.blur, spreadDistance: l.spread, color: css(l.color),
        }));
        expect(lift(scheme, level).boxShadow, `${scheme} ${level} default`).toEqual(want);
        expect(lift(scheme, level, "paper").boxShadow, `${scheme} ${level} paper`).toEqual(want);
      }
      // Paper's negative spreads — the thing the retired macOS port had to drop — survive.
      expect(liftLayers(scheme, "l3").some((l) => l.spread < 0)).toBe(true);
    }
  });

  it("liftUp mirrors the FACE's own ladder, not paper's", () => {
    for (const scheme of SCHEMES) {
      const up = liftUp(scheme, "barEdge", "ohmarchy").boxShadow as unknown as
        readonly { offsetY: number }[];
      const down = ohmarchyLift[scheme].barEdge;
      expect(up.map((l) => l.offsetY)).toEqual(down.map((l) => -l.offsetY));
      // The bar edge really has a vertical offset, so the flip is observable at all.
      expect(down[0]!.offsetY).not.toBe(0);
    }
  });

  it("sheetEdge is the bar edge mirrored — a derivation, since the face names no slot for it", () => {
    for (const scheme of SCHEMES) {
      const bar = ohmarchyLift[scheme].barEdge;
      expect(ohmarchyLift[scheme].sheetEdge).toEqual(bar.map((l) => ({ ...l, offsetY: -l.offsetY })));
    }
  });
});

describe("motion: the face moves the easing curves and nothing about the durations", () => {
  it("the curves are the generated ones, and they are not paper's", () => {
    expect(`cubic-bezier(${ohmarchyEasing.spring.join(",")})`).toBe(slot("dark", "--spring"));
    expect(`cubic-bezier(${ohmarchyEasing.swift.join(",")})`).toBe(slot("dark", "--swift"));
    expect([...ohmarchyEasing.spring]).not.toEqual([...motion.easing.spring]);
  });

  it("no duration is faced — a face changes how a transition eases, never how long it takes", () => {
    // The generated set carries no duration slot at all, which is the structural half; this
    // states the consequence, because `ms()` reads `motion.duration` directly.
    for (const scheme of SCHEMES) {
      expect(Object.keys(web[`ohmarchy-${scheme}`]!).some((k) => /duration/i.test(k))).toBe(false);
    }
    expect(motion.duration.instant).toBe(150);
  });
});

/* ───────────────────────────────────────────────────────────────────── the scope law */

describe("the two scopes: device pin beats account, account beats nothing", () => {
  const cases: [FaceName | null, FaceName | null, FaceName][] = [
    [null, null, "paper"],
    [null, "ohmarchy", "ohmarchy"],
    [null, "paper", "paper"],
    ["ohmarchy", null, "ohmarchy"],
    ["paper", null, "paper"],
    // THE ORDER, both directions: the pin wins whichever way the two disagree.
    ["paper", "ohmarchy", "paper"],
    ["ohmarchy", "paper", "ohmarchy"],
  ];
  for (const [pin, account, want] of cases) {
    it(`pin ${String(pin)} · account ${String(account)} → ${want}`, () => {
      /* Mutation: `account ?? pin ?? "paper"` → the last two rows fail. */
      expect(resolveFace(pin, account)).toBe(want);
    });
  }

  it("paper is the resting face, and it is the default the provider takes", () => {
    expect(DEFAULT_FACE).toBe("paper");
    expect(resolveFace(null, null)).toBe(DEFAULT_FACE);
  });

  it('"applies on all your devices" may only be claimed when the account really governs', () => {
    // Both halves required, exactly the webapp FaceRow's rule.
    expect(accountGovernsFace("ohmarchy", null, "ohmarchy")).toBe(true);
    expect(accountGovernsFace("ohmarchy", "ohmarchy", "ohmarchy")).toBe(false); // a pin still pins
    expect(accountGovernsFace("paper", null, null)).toBe(false); // no account choice to govern by
    expect(accountGovernsFace("paper", "paper", "ohmarchy")).toBe(false);
  });

  it("the ACCOUNT-WIDE press is withheld until the account's face has been READ", () => {
    /**
     * Review-caught, and the defect it closes is a data loss rather than a cosmetic one. Before a
     * session's `GET /consent` succeeds, `account` is null — indistinguishable from "the account
     * has no preference" — so with no device pin the control shows paper. A press then PATCHes
     * PAPER over an ohmarchy the account really holds, because its read was slow or failed.
     *
     * Mutation: `return !accountGovernsFace(face, pin, account)` (drop the `accountKnown &&`) →
     * the first row goes red. The rows after it are what stop the fix from being "never offer it".
     */
    // THE DEFECT ROW: nothing read, nothing pinned, so the control shows paper — no press.
    expect(accountWideOffered(false, "paper", null, null)).toBe(false);
    // …and it stays withheld while unread even when this device HAS pinned a face.
    expect(accountWideOffered(false, "ohmarchy", "ohmarchy", null)).toBe(false);
    // Once read: an account with no preference is a real answer, and the press is offered.
    expect(accountWideOffered(true, "ohmarchy", "ohmarchy", null)).toBe(true);
    expect(accountWideOffered(true, "paper", null, null)).toBe(true);
    // A pin that disagrees with a known account face is exactly what the press is for.
    expect(accountWideOffered(true, "paper", "paper", "ohmarchy")).toBe(true);
    // …and there is nothing to offer once the account already governs this device.
    expect(accountWideOffered(true, "ohmarchy", null, "ohmarchy")).toBe(false);
  });

  it("the world layer's `known` is set by ADOPTION alone — the pane's gate has one source", () => {
    /* The structural half of the rule above: `known` may not be set anywhere but in the face
       scope's `adopt` callback, because adoption is the only path a trustworthy value takes (the
       17 ordering cases in face-scope.test.ts are what make that true). A `setAccountFaceKnown`
       anywhere else — on a read being ISSUED, on a session going live — would re-open the
       conflation this gate exists to close. */
    const world = readFileSync(here("../src/state/world.tsx"), "utf8");
    const sets = [...world.matchAll(/setAccountFaceKnown\((true|false)\)/g)].map((m) => m[1]);
    expect(sets, "one true (in adopt) and one false (the session reset), and no other").toEqual([
      "true",
      "false",
    ]);
    // …and the true one really sits in the adopt callback, beside the value it qualifies.
    expect(world).toMatch(/setAccountFace\(face\);[\s\S]{0,200}setAccountFaceKnown\(true\)/);
  });

  it("teach is the face's own switch — 1 loud, 0 calm", () => {
    expect(teachOf("ohmarchy")).toBe(1);
    expect(teachOf("paper")).toBe(0);
  });

  it("faceOf keeps only a face this build can draw", () => {
    expect(faceOf("ohmarchy")).toBe("ohmarchy");
    expect(faceOf("paper")).toBe("paper");
    // A future face, a typo, a wrong type: all "no preference", never a crash and never a guess.
    for (const bad of ["tokyo-night", "", null, undefined, 1, {}, ["paper"]]) {
      expect(faceOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

/* ──────────────────────────────────────────── no detection arm, and the copy is the product's */

describe("a phone has no Linux-detection arm (a judgment, and it stays made)", () => {
  it("no shipped source detects a platform to choose a face with", () => {
    /**
     * The web provider's third input is `navigator.platform =~ /Linux/` minus Android/CrOS
     * (plan §12). Ported here it would be catastrophic rather than merely wrong: EVERY Android
     * phone reports a Linux kernel, so the whole Android install would open in a tiling desktop
     * face nobody asked for — and the offer the arm exists to make ("go full ohmarchy on all
     * your devices") is a desktop-door offer to somebody already running that window manager.
     *
     * So the scan is over the face's own decision, not over `Platform` in general: this app
     * legitimately branches on platform elsewhere (the pull-to-refresh spinner, the backup
     * rules). What must not exist is a platform read in the same breath as a face.
     */
    const src = readFileSync(here("../src/theme/face.ts"), "utf8");
    for (const pattern of [/navigator/, /Platform\.OS/, /userAgent/]) {
      expect(pattern.test(src), `face.ts must not read the platform: ${pattern}`).toBe(false);
    }
    // …and `resolveFace` takes exactly two inputs, so there is nowhere for a third to hide.
    expect(resolveFace.length).toBe(2);
  });

  it("the face copy is the webapp catalogue's own sentences, byte for byte", () => {
    /* One product, one sentence per decision — the folders copy's rule (folders-parity), and
       the reason it matters here is the same: somebody reads the scope line on a laptop and
       must not meet a paraphrase of it on their phone. */
    const messages = JSON.parse(
      readFileSync(here("../../webapp/messages/en.json"), "utf8"),
    ) as { settings: Record<string, string> };
    const s = messages.settings;
    expect(Copy.face).toBe(s.face);
    expect(Copy.faceHint).toBe(s.faceHint);
    expect(Copy.facePaper).toBe(s.facePaper);
    expect(Copy.faceOhmarchy).toBe(s.faceOhmarchy);
    expect(Copy.faceScopeAll).toBe(s.faceScopeAll);
    expect(Copy.faceScopeDevice).toBe(s.faceScopeDevice);
    expect(Copy.faceApplyAll).toBe(s.faceApplyAll);
    expect(Copy.faceFailed).toBe(s.faceFailed);
    // Not vacuous: the catalogue really has these keys and the hint really names the theme.
    expect(s.faceHint).toContain("Omarchy");
  });

  it("the Settings screen renders the face control from the copy deck, not from a literal", () => {
    // The theme audit (`theme.test.ts`) keeps colour literals out of the screens; this keeps
    // the face's own prose in the one auditable place, which is what the copy deck is for.
    const screen = readFileSync(here("../app/settings.tsx"), "utf8");
    for (const key of ["Copy.face", "Copy.facePaper", "Copy.faceOhmarchy", "Copy.faceApplyAll"]) {
      expect(screen).toContain(key);
    }
    // …and the pane asks the pure rules rather than re-deriving them beside them.
    expect(screen).toContain("accountWideOffered(accountKnown, face, pin, account)");
    expect(screen, "the face labels are catalogue keys, never inline prose").not.toMatch(
      /label:\s*"(paper|ohmarchy)"/,
    );
  });
});
