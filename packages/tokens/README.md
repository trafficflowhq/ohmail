# @ohmail/tokens

Every value of ohmail's design: colour in both schemes, type, space, radius, rings, motion, for the
Paper face and the Ohmarchy face. A view never writes a value; it reads a token.

The package holds two generations side by side while the screens are rebuilt.

## The design (new)

One source, written by hand, and what a script makes of it.

| Path | What it is |
|---|---|
| `source/tokens.json` | The values, as flat maps of token name to CSS value, one map per block: a face, a scheme, a device, an accent. `var()` is the only reference. A dark or Ohmarchy block names only what differs. |
| `source/motion.json` | The motion tokens (times, curves, shapes, stagger) and the set they become under reduced motion. |
| `source/fonts.json` | The typefaces: each family's `@font-face` descriptors, its files with a sha256 each, its licence and where it comes from. |
| `fonts/` | The font files, the licence text of each family, and `FONTS.md` (**generated**). |
| `source/declared.tsv` | What the comparison with the design sheet may differ in, each row with its reason. |
| `scripts/generate-design.mjs` | Writes `src/design/` from the source. No dependency. |
| `src/design/tokens.css` | **Generated.** One rule per block on the root's attributes: `data-scheme`, `data-face`, `data-accent`, `data-touch`, `data-device`, `data-product`. A document that stamps no scheme follows the system's. |
| `src/design/motion.css` | **Generated.** The motion tokens; reduced by `data-rm="1"` or by the system's own setting. |
| `src/design/tokens.ts` | **Generated.** The same values resolved for every situation, typed: `design`, `motion`, `TokenName`, `MotionRole`, and `v("ink")` for `var(--ink)`. |
| `src/design/tokens.json` | **Generated.** That data for a reader that is not TypeScript. |
| `src/design/fonts.css` | **Generated.** One `@font-face` per font file, its source a relative path into `fonts/`. A shell imports it once; its bundler emits the files, so the page asks no host for a font. |
| `src/design/fonts.ts` | **Generated.** The same list for a shell that copies the files itself: `fonts`, `fontFiles`, `fontLicenceFiles`. |
| `omarchy/design-slots.ts` | A live Omarchy theme, mapped by the law in `omarchy/mapping.js`, renamed to the design's slots. A few colours of the face do not follow a theme yet; `test/design-omarchy-slots.test.ts` names them. |
| `scripts/compare-sheet.mjs` | Compares what ships with a design sheet, value by value. |

Imports: `@ohmail/tokens/design.css`, `@ohmail/tokens/design/motion.css`, `@ohmail/tokens/design/fonts.css`,
`@ohmail/tokens/design`, `@ohmail/tokens/design/fonts` and `@ohmail/tokens/design/tokens.json`.

The fonts are under the SIL Open Font License, not under this package's licence (`fonts/FONTS.md`, and
`COPYRIGHT` at the root). Whatever copies a font file out of `fonts/` copies its family's licence text with it;
a copy of `src/` alone has no fonts, and `fonts.css` then points at nothing.

### Changing a value

Edit `source/`, then:

```bash
node packages/tokens/scripts/generate-design.mjs
```

and commit the source with the generated files. The generated files are committed because the package is
read as source, without a build step. A hand edit of one fails `test/design-generated-identity.test.ts`.

The generator refuses a source it cannot emit whole, and writes nothing: a token named in a face, scheme or
device block that the default block (`faces.paper.light`, `calendar.paper.light`) does not name, a reference
to a token that does not exist, a part that is not a block of values, or a value that holds an address.

### Comparing with the sheet

The design sheet these values were written from is not part of this repository. With a copy of its data
(`tokens.json`, `icons.json`) and of the two stylesheets it is authored in (`tokens.css`, `motion.css`) in a
directory:

```bash
node packages/tokens/scripts/compare-sheet.mjs --sheet <dir> [--product <checkout>] [--out findings.tsv]
```

It reads the data, every value each side resolves for a face, a scheme and a device, and then the
stylesheets, every declaration of `src/design/*.css` against the sheet's rule at the same selector. The
second pass is where the values the sheet's data does not carry are held: reduced motion, and the blocks
its data resolves no situation for.

It exits 0 when nothing differs that `source/declared.tsv` does not name, 1 on a difference or on a declared
row that matched nothing, and 2 when one of the four files is missing. There is no default sheet. The icons
it compares are `packages/ui/src/icons/icons.json`.

A row of `declared.tsv` names one token, or with `*` a whole part or rule that one side leaves out. It never
stands for the tokens of a part both sides have.

## The old stylesheets

`src/tokens.css`, `src/faces.css`, `src/ohmarchy.css`, `src/ohmarchy.json`, `src/tokens.ts` and the package's
main entry are what today's views read. They are not edited for the new design and they leave with the last
old view. `scripts/generate-ohmarchy.mjs` writes the two `ohmarchy` files from the law.

The two generations declare some of the same names (`--ink`, `--focus`, `--r-pill`) with different values, so
one page loads one of them, never both. `test/design-not-yet-imported.test.ts` holds that, and lists who may
import the new design.

## The Omarchy law

`omarchy/mapping.js` maps a theme's palette to colours with their contrast floors; `omarchy/` beside it reads
a theme and the system's settings. `spec/` and `omarchy/fixtures/` pin it. Both generations use it unchanged.
