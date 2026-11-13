/* The typefaces: source/fonts.json checked, and written as src/design/fonts.css and fonts.ts.

   A face is declared by its descriptors and the file that carries it. The files are in fonts/
   beside their licence texts; a stylesheet names them by a relative path and by nothing else,
   so no page that reads it asks any host for a font. */
import { SourceError } from "./design-lib.mjs";

const refuse = (msg) => {
  throw new SourceError(msg);
};

/** Where fonts/ is from src/design/, where the stylesheet is written. */
const FONTS_DIR = "../../fonts/";

const SHAPE = {
  family: /^[A-Za-z][A-Za-z0-9 ]*$/,
  weight: /^[1-9]00( [1-9]00)?$/,
  stretch: /^\d{2,3}%( \d{2,3}%)?$/,
  display: /^(swap|block|fallback|optional)$/,
  file: /^[a-z0-9-]+\.woff2$/,
  unicodeRange: /^U\+[0-9A-Fa-f]{4}(-[0-9A-Fa-f]{4})?(,U\+[0-9A-Fa-f]{4}(-[0-9A-Fa-f]{4})?)*$/,
  sha256: /^[0-9a-f]{64}$/,
  licenceFile: /^OFL-[A-Za-z]+\.txt$/,
  version: /^\d+\.\d+$/,
};
const FAMILY_KEYS = ["family", "weight", "stretch", "display", "files", "licence", "upstream"];

function shaped(value, shape, path) {
  if (typeof value !== "string" || !SHAPE[shape].test(value)) refuse(`${path} is not a ${shape}`);
  return value;
}

/** The families of source/fonts.json, every field checked. Refuses a file two faces name. */
export function fontsOf(fonts) {
  for (const key of Object.keys(fonts)) if (key !== "families") refuse(`fonts "${key}" is not a part of the source`);
  const seen = new Set();
  return (fonts.families ?? []).map((entry, i) => {
    const path = `fonts.families[${i}]`;
    for (const key of Object.keys(entry)) if (!FAMILY_KEYS.includes(key)) refuse(`${path}.${key} is not a part of a family`);
    const files = (entry.files ?? []).map((f, j) => {
      const file = shaped(f.file, "file", `${path}.files[${j}].file`);
      if (seen.has(file)) refuse(`${path}.files[${j}].file: ${file} is named twice`);
      seen.add(file);
      return {
        file,
        unicodeRange: shaped(f.unicodeRange, "unicodeRange", `${path}.files[${j}].unicodeRange`),
        sha256: shaped(f.sha256, "sha256", `${path}.files[${j}].sha256`),
      };
    });
    if (files.length === 0) refuse(`${path} names no file`);
    return {
      family: shaped(entry.family, "family", `${path}.family`),
      weight: shaped(entry.weight, "weight", `${path}.weight`),
      ...(entry.stretch === undefined ? {} : { stretch: shaped(entry.stretch, "stretch", `${path}.stretch`) }),
      display: shaped(entry.display, "display", `${path}.display`),
      files,
      licence: {
        name: entry.licence?.name === "OFL-1.1" ? "OFL-1.1" : refuse(`${path}.licence.name is not a licence this package bundles under`),
        file: shaped(entry.licence?.file, "licenceFile", `${path}.licence.file`),
        copyright: String(entry.licence?.copyright ?? "").startsWith("Copyright ") ? entry.licence.copyright : refuse(`${path}.licence.copyright is missing`),
      },
      upstream: {
        project: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(entry.upstream?.project ?? "") ? entry.upstream.project : refuse(`${path}.upstream.project is not a project page`),
        version: shaped(entry.upstream?.version, "version", `${path}.upstream.version`),
      },
    };
  });
}

/** fonts.css: one @font-face per file, its source a path into fonts/. */
export function fontsCss(families, header) {
  const face = (family, { file, unicodeRange }) =>
    [
      "@font-face{",
      `  font-family: "${family.family}";`,
      "  font-style: normal;",
      `  font-weight: ${family.weight};`,
      ...(family.stretch ? [`  font-stretch: ${family.stretch};`] : []),
      `  font-display: ${family.display};`,
      `  src: url("${FONTS_DIR}${file}") format("woff2");`,
      `  unicode-range: ${unicodeRange};`,
      "}",
    ].join("\n");
  return `${header}\n${families.flatMap((family) => family.files.map((file) => face(family, file))).join("\n")}\n`;
}

/** fonts.ts: the same list for a shell that copies the files itself; the licence texts travel with them. */
export function fontsTs(families, header) {
  const licences = [...new Set(families.map((family) => family.licence.file))];
  /* Where a family comes from is for a person to read (fonts/FONTS.md). No address goes into an app's bundle. */
  const listed = families.map(({ upstream, ...family }) => ({ ...family, version: upstream.version }));
  return `${header}
/** Where the files are, from this module. */
export const fontsDir = ${JSON.stringify(FONTS_DIR)};

/** The bundled typefaces: their descriptors, their files with a sha256 each, their version and licence. */
export const fonts = ${JSON.stringify(listed, null, 2)} as const;

/** Every font file, in fonts/. */
export const fontFiles = ${JSON.stringify(families.flatMap((family) => family.files.map((f) => f.file)))} as const;

/** The licence texts, in fonts/. A copy of a font file is passed on with its licence text. */
export const fontLicenceFiles = ${JSON.stringify(licences)} as const;
`;
}

/** fonts/FONTS.md: what is in the folder, under which licence, from where, with a sha256 per file. */
export function fontsNotice(families) {
  const row = (cells) => `| ${cells.join(" | ")} |`;
  const table = (head, rows) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");
  return `# The typefaces in this folder

GENERATED by packages/tokens/scripts/generate-design.mjs from source/fonts.json. Change the source and run the script.

${families.length} families, each under the SIL Open Font License 1.1, none with a Reserved Font Name. The licence
lets a font be bundled, embedded and passed on with software under any licence, as long as every copy carries
the copyright line and the licence text and the fonts are not sold by themselves. The fonts stay under the
Open Font License; the licence of the code around them does not reach them, and theirs does not reach it.

The licence text of each family is in this folder. A font file copied out of it is copied with that text.

${table(
    ["Family", "Version", "Copyright", "Project", "Licence text"],
    families.map((f) => [f.family, f.upstream.version, f.licence.copyright.replace(/^Copyright /, ""), f.upstream.project, f.licence.file]),
  )}

The files are variable fonts in two subsets each, Latin and Latin Extended.

${table(
    ["File", "Family", "sha256"],
    families.flatMap((f) => f.files.map((file) => [file.file, f.family, `\`${file.sha256}\``])),
  )}
`;
}
