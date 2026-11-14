import fs from "node:fs";
import path from "node:path";
import { PLACES_FILE, readMounted } from "../../../tools/lib/mounted.mjs";
import { makeGraph, makeResolver } from "../../../tools/lib/reach.mjs";
import { entriesAt, readSource } from "../../../tools/lib/source-text.mjs";

/** A single named property in an explicit record. An unfamiliar or spread record proves nothing. */
function recordValue(text, opening, name) {
  const reading = readSource(text);
  const matches = [...reading.code.matchAll(opening)];
  if (matches.length !== 1) return null;
  const at = matches[0].index + matches[0][0].length - 1;
  const entries = entriesAt(reading, text, at);
  if (!entries || entries.some((entry) => entry.spread)) return null;
  const named = entries.filter((entry) => entry.key === name);
  return named.length === 1 ? named[0].value : null;
}

/**
 * Only an actual mounted mail frame can withhold one of the old shell's consumers.
 * Legacy shells and unreadable registrations keep the original positive byte checks.
 */
export function registeredFeatures(root, artifact) {
  const required = { hostedSuggest: true, pdfPreview: true };
  const packages = path.join(root, "packages");
  if (!fs.existsSync(packages)) return required;
  const manifests = {};
  for (const dir of fs.readdirSync(packages, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const folder = `packages/${dir.name}`;
    const manifest = path.join(root, folder, "package.json");
    if (fs.existsSync(manifest)) manifests[folder] = JSON.parse(fs.readFileSync(manifest, "utf8"));
  }
  const present = { has: (file) => fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile() === true };
  const textOf = (file) => present.has(file) ? fs.readFileSync(path.join(root, file), "utf8") : null;
  const resolve = makeResolver(present, manifests);
  const localPackages = new Set(Object.values(manifests).map((manifest) => manifest.name));
  let unresolved = false;
  let importsPdf = false;
  const graph = makeGraph((spec, importer) => {
    if (spec === "pdfjs-dist" || spec.startsWith("pdfjs-dist/")) importsPdf = true;
    const target = resolve(spec, importer);
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!target && (spec.startsWith(".") || spec.startsWith("@/") || localPackages.has(name))) unresolved = true;
    return target;
  }, textOf);
  const document = textOf(artifact === "engine" ? "apps/desktop/index.html" : "apps/desktop/host.html") ?? "";
  const scripts = [...document.matchAll(/<script\s+type="module"\s+src="([^"]+)"\s*>/g)];
  if (scripts.length !== 1) return required;
  const entry = path.posix.join("apps/desktop", scripts[0][1]);
  const reachable = graph.closure([entry]);
  const browserMail = "apps/webapp/app/shell/browser-mail.tsx";
  if (unresolved || !reachable.has(browserMail) || !reachable.has(PLACES_FILE)) return required;
  const { mounted, targets, refusals } = readMounted({ files: [...reachable], textOf });
  if (refusals.length || !mounted.has("reader") || !mounted.has("ohbox")) return required;

  if (artifact === "engine") {
    const host = "apps/desktop/src/host-contract.ts";
    const noSuggest = reachable.has(host) && targets.has("screener") && !mounted.has("screener")
      && recordValue(textOf(host), /\bwires\s*:\s*\{/g, "suggest") === "NONE";
    return { ...required, hostedSuggest: !noSuggest };
  }
  const browser = textOf(browserMail);
  const reader = recordValue(browser, /\bfunction\s+browserMailParts\s*\([^{};]*\)\s*(?::[^{};]+)?\{\s*return\s*\{/g, "reader");
  const look = recordValue(browser, /\bconst\s+BROWSER_READER\s*=\s*mailReader\s*\(\s*\{/g, "look");
  return { ...required, pdfPreview: importsPdf || reader !== "BROWSER_READER" || look !== "NONE" };
}
