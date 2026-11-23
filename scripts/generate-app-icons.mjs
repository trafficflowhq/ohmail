// Requires npm ci and rsvg-convert (librsvg2-bin on Debian/Ubuntu, librsvg on macOS).
// Run: node scripts/generate-app-icons.mjs [--store-dir <graphics directory>]
// Edit the mark beside its font licence in packages/tokens/fonts/app-icon-mark.svg.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { design } from "../packages/tokens/src/design/tokens.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const { ink, sheet, hot } = design.faces.paper.light;
const cobalt = design.accents.cobalt.paper.light.hot;
const darkPaper = design.faces.paper.dark;
const source = readFileSync(join(root, "packages/tokens/fonts/app-icon-mark.svg"), "utf8");
const marks = {
  mail: { width: 1374, height: 714, dot: hot },
  cal: { width: 1559, height: 1520, dot: cobalt },
};
const canvas = 1024;
const number = (value) => +value.toFixed(5);
const fit = (size) => size <= 32 ? 0.84 : size < 128 ? 0.74 : 0.64;

function mark({ width = 0.64, product = "mail", side = canvas, inset = 0, shift = 0.012, mono = false, dark = false } = {}) {
  const glyphs = marks[product];
  const scale = width * side / glyphs.width;
  const x = inset + side * (0.5 + shift - width / 2);
  const y = inset + (side - glyphs.height * scale) / 2;
  const letters = mono ? "#000000" : dark ? darkPaper.ink : ink;
  const dot = mono ? letters : dark ? darkPaper.hot : glyphs.dot;
  const body = source.match(new RegExp(`<g id="${product}">([\\s\\S]*?)</g>`))[1]
    .trim().replace("currentColor", letters).replace("var(--dot)", dot);
  return `<g transform="translate(${number(x)} ${number(y)}) scale(${number(scale)})">${body}</g>`;
}

function svg(size, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024" role="img" aria-label="ohmail">
${body}
</svg>
`;
}

function square(inset, side, radius, paint) {
  return `<rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}" ${paint}/>`;
}

// A fifth-power superellipse, sampled from the middle of each edge to each diagonal.
function squircle(inset, side, paint) {
  const half = side / 2;
  const center = inset + half;
  const diagonal = 0.5 ** (1 / 5);
  const octant = Array.from({ length: 33 }, (_, i) => {
    const x = diagonal * i / 32;
    return [x, (1 - x ** 5) ** (1 / 5)];
  });
  const quadrant = [...octant, ...octant.slice(0, -1).reverse().map(([x, y]) => [y, x])];
  const points = [];
  for (let turn = 0; turn < 4; turn++) {
    for (const [x, y] of quadrant.slice(0, -1)) {
      const [a, b] = [[x, y], [y, -x], [-x, -y], [-y, x]][turn];
      points.push(`${number(center + a * half)},${number(center + b * half)}`);
    }
  }
  return `<polygon points="${points.join(" ")}" ${paint}/>`;
}

function tile(size, shape, { inset = 0, side = canvas - 2 * inset, edge = Math.max(side / 128, canvas / size), shadow = false, width = fit(size) } = {}) {
  const fill = shape(inset, side, `fill="${sheet}"`);
  const border = shape(inset + edge / 2, side - edge,
    `fill="none" stroke="${ink}" stroke-opacity="0.14" stroke-width="${edge}"`);
  const shade = shadow ? `<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
<feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/>
<feComponentTransfer><feFuncA type="linear" slope="0.32"/></feComponentTransfer>
</filter></defs>
${shape(inset, side, 'fill="#000000" filter="url(#shadow)"')}
` : "";
  return shade + fill + "\n" + border + "\n" + mark({ width, inset, side });
}

const round = (inset, side, paint) => square(inset, side, canvas * 0.2 - inset, paint);
const flat = (options) => square(0, canvas, 0, `fill="${sheet}"`) + (options ? mark(options) : "");
const mac = (size) => tile(size, squircle, size >= 128 ? { inset: 100, shadow: true } : {});

function png(size, body, rgb = false) {
  const bytes = execFileSync("rsvg-convert", { input: svg(size, body) });
  // Keep the original channel format for each asset, including opaque iOS files.
  const colorType = rgb ? 2 : 6;
  return bytes[25] === colorType ? bytes : PNG.sync.write(PNG.sync.read(bytes), { colorType });
}

function ico(sizes, widthAtSize = fit) {
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const images = [];
  let offset = header.length;
  for (const [i, size] of sizes.entries()) {
    const data = png(size, tile(size, round, { width: widthAtSize(size) }));
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = size % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
    images.push(data);
  }
  return Buffer.concat([header, ...images]);
}

function icnsChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

// The legacy 16/32 px slots take planar ARGB with run-length encoding.
// Literal packets are sufficient for these two small images.
function icnsArgb(size) {
  const pixels = PNG.sync.read(png(size, mac(size))).data;
  const packets = [Buffer.from("ARGB")];
  for (const channel of [3, 0, 1, 2]) {
    for (let start = 0; start < size * size; start += 128) {
      const length = Math.min(128, size * size - start);
      const packet = Buffer.alloc(length + 1);
      packet[0] = length - 1;
      for (let i = 0; i < length; i++) packet[i + 1] = pixels[4 * (start + i) + channel];
      packets.push(packet);
    }
  }
  return Buffer.concat(packets);
}

function icns() {
  const sizes = { ic11: 32, ic12: 64, ic07: 128, ic08: 256, ic13: 256, ic09: 512, ic14: 512, ic10: 1024 };
  const parts = [icnsChunk("ic04", icnsArgb(16)), icnsChunk("ic05", icnsArgb(32))];
  for (const [type, size] of Object.entries(sizes)) {
    parts.push(icnsChunk(type, png(size, mac(size))));
  }
  return icnsChunk("icns", Buffer.concat(parts));
}

const [option, storeDir, ...extra] = process.argv.slice(2);
if (option !== undefined && (option !== "--store-dir" || !storeDir || extra.length)) {
  throw new Error("Usage: node scripts/generate-app-icons.mjs [--store-dir <graphics directory>]");
}

const writePng = (file, size, body, rgb) => writeFileSync(resolve(root, file), png(size, body, rgb));
const mobile = "apps/mobile/assets";
const web = "apps/webapp/public";
const desktop = "apps/desktop/src-tauri/icons";
const adaptive = { width: 0.43 };
const calAdaptive = { product: "cal", width: 0.38667, shift: 0.008 };

writePng(`${mobile}/icon.png`, 1024, tile(1024, squircle));
writePng(`${mobile}/icon-ios.png`, 1024, flat({}), true);
writePng(`${mobile}/android-icon-foreground.png`, 1024, mark(adaptive));
writePng(`${mobile}/android-icon-monochrome.png`, 1024, mark({ ...adaptive, mono: true }));
writePng(`${mobile}/splash-icon.png`, 1024, mark({ width: 0.58 }));
writePng(`${mobile}/splash-icon-dark.png`, 1024, mark({ width: 0.58, dark: true }));
writePng(`${mobile}/favicon.png`, 192, tile(192, round));
writePng(`${mobile}/ohcal/icon-ios.png`, 1024, flat({ product: "cal", width: 0.58 }), true);
writePng(`${mobile}/ohcal/android-icon-background.png`, 1024, flat(), true);
writePng(`${mobile}/ohcal/android-icon-foreground.png`, 1024, mark(calAdaptive));
writePng(`${mobile}/ohcal/android-icon-monochrome.png`, 1024, mark({ ...calAdaptive, mono: true }));

for (const [file, size] of Object.entries({ "32x32": 32, "64x64": 64, "128x128": 128, "128x128@2x": 256, icon: 512 })) {
  writePng(`${desktop}/${file}.png`, size, tile(size, round));
}
writeFileSync(join(root, desktop, "icon.icns"), icns());
writeFileSync(join(root, desktop, "icon.ico"), ico([32, 16, 24, 48, 64, 256]));

writeFileSync(join(root, web, "favicon.svg"), svg(canvas, tile(32, round)));
writeFileSync(join(root, web, "favicon.ico"), ico([16, 32, 48], () => 0.84));
writePng(`${web}/apple-touch-icon.png`, 180, flat({}), true);
for (const size of [192, 512]) {
  writePng(`${web}/icon-${size}.png`, size, tile(size, round));
  writePng(`${web}/maskable-${size}.png`, size, flat({ width: 0.5 }), true);
}
writePng("docs/ohmail-icon.png", 256, tile(256, squircle));

if (storeDir) {
  mkdirSync(resolve(storeDir), { recursive: true });
  writePng(resolve(storeDir, "app-icon-512.png"), 512, flat({}));
  writePng(resolve(storeDir, "app-store-icon-1024.png"), 1024, flat({}), true);
}
