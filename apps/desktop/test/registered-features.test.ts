import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registeredFeatures } from "../scripts/registered-features.mjs";

let root: string;
const places = "packages/app/src/mail/places.ts";
const browser = "apps/webapp/app/shell/browser-mail.tsx";
const contract = "apps/desktop/src/host-contract.ts";
const reader = `export const BROWSER_READER = mailReader({ look: NONE });
export function browserMailParts() { return { reader: BROWSER_READER }; }
import "../../../../packages/app/src/mail/places";`;

function write(file: string, content: string) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desktop-registration-"));
  write("apps/desktop/index.html", '<script type="module" src="./src/main.tsx"></script>');
  write("apps/desktop/host.html", '<script type="module" src="../paired-page/src/main.tsx"></script>');
  write("apps/desktop/src/main.tsx", 'import "./host-contract"; import "../../webapp/app/shell/browser-mail";');
  write("apps/paired-page/src/main.tsx", 'import "../../webapp/app/shell/browser-mail";');
  write(contract, "export const host = { wires: { suggest: NONE } };");
  write(browser, reader);
  write(places, "const SEATED = { ohbox: ohboxPlace };");
  write("packages/app/src/frame/contract.ts", 'const PLACE_IDS = ["ohbox", "screener"]; const STAGE_IDS = ["firstRun"];');
  write("packages/app/src/mail/supplies.ts", "const supplies = { reader: own.reader };");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("requires the hosted transport for a seated Screener or a supplied suggestion wire", () => {
  const required = () => registeredFeatures(root, "engine").hostedSuggest;
  expect(required()).toBe(false);
  write(places, "const SEATED = { ohbox: ohboxPlace, screener: screenerPlace };");
  expect(required()).toBe(true);
  write(places, "const SEATED = { ohbox: ohboxPlace };");
  write(contract, "export const host = { wires: { suggest: transport } };");
  expect(required()).toBe(true);
});

it("requires the PDF refusal for a reachable PDF import and for an unfamiliar reader", () => {
  const required = () => registeredFeatures(root, "host-client").pdfPreview;
  expect(required()).toBe(false);
  write(browser, reader + '\nexport const load = () => import("pdfjs-dist");');
  expect(required()).toBe(true);
  write(browser, reader.replace("reader: BROWSER_READER", "reader: anotherReader"));
  expect(required()).toBe(true);
  write(browser, reader + '\nimport "./unresolved-reader";');
  expect(required()).toBe(true);
});

it("keeps both positive checks when the registration cannot be read", () => {
  write(places, "const SEATED = { ...somePlaces };");
  expect(registeredFeatures(root, "engine").hostedSuggest).toBe(true);
  expect(registeredFeatures(root, "host-client").pdfPreview).toBe(true);
});
