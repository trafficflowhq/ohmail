/**
 * The registry of states: which states of the app the design reference draws, each under one key.
 *
 * `registry.json` is DERIVED from the design reference's own list of screens and never written by hand.
 * What crosses is a state's key, its screen, its group, what it is drawn in and, for a screen's own
 * states, their label. What the source also carries (where the reference is served, thumbnails, notes,
 * the words of its check lists) is dropped here, by naming what is kept.
 */
import { createHash } from "node:crypto";

/** Address parameters that say how a page is framed or stepped, not which state it is. */
const NOT_THE_STATE = new Set(["bare", "fast", "keys"]);
/** The seven links every screen has: one named state in every theme, scheme and size. */
export const LINKS = ["desktop", "phone", "fold", "landscape", "ohmarchy", "dark", "ohmarchy_dark"];

/**
 * A state's key: its address's query with the parameters sorted and the framing ones left out.
 * @param {string} address a whole address, or a query string
 */
export function keyOf(address) {
  const at = address.indexOf("?");
  const query = /^[a-z]+:\/\//i.test(address) || at >= 0 ? (at >= 0 ? address.slice(at + 1) : "") : address;
  const pairs = [...new URLSearchParams(query.split("#")[0])].filter(([k]) => !NOT_THE_STATE.has(k));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** The file a state's picture and data file are stored under: no slug and no `&` in a path. @param {string} key */
export function fileOf(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** What a picture is checked against to tell "older than its state". @param {object} entry a registry state */
export function stateHash(entry) {
  const { key, screen, group, label, kind, link, variant } = entry;
  return createHash("sha256").update(JSON.stringify([key, screen, group, label, kind, link ?? null, variant.device, variant.face, variant.scheme])).digest("hex").slice(0, 16);
}

const label = (s) => String(s ?? "").replace(/,?\s*\bFB-\d+\b/g, "").replace(/\s+/g, " ").trim();

/**
 * @param {any} source the design reference's list of screens, parsed
 * @param {{ studioTag: string, studioCommit: string }} at
 * @returns {import("./registry.d.mts").Registry}
 */
export function deriveRegistry(source, at) {
  /** @type {Map<string, import("./registry.d.mts").RegisteredState>} */
  const byKey = new Map();
  const rank = { state: 0, variant: 1, also: 2 };
  const screens = source.screens.map((/** @type {any} */ s) => ({ id: String(s.id), group: label(s.group), title: label(s.title) }));
  const known = new Map(screens.map((/** @type {any} */ s) => [s.id, s]));

  /** @param {string} address @param {{ group: string, label: string, kind: "state"|"variant"|"also", link?: string }} what */
  const add = (address, what) => {
    const key = keyOf(address);
    const q = new URLSearchParams(key);
    const screen = q.get("screen") ?? "";
    if (!known.has(screen)) throw new Error(`registry: an address names the screen "${screen}", which is not a registered screen`);
    const scheme = q.get("scheme") === "dark" ? "dark" : "light";
    const entry = { key, screen, group: what.group, label: what.label, kind: what.kind, variant: { device: q.get("device") ?? "desktop", face: q.get("face") ?? "paper", scheme } };
    const had = byKey.get(key);
    if (!had) byKey.set(key, entry);
    else if (rank[what.kind] < rank[had.kind]) byKey.set(key, { ...entry, ...(had.link ? { link: had.link } : {}) });
    const kept = /** @type {import("./registry.d.mts").RegisteredState} */ (byKey.get(key));
    if (what.link && !kept.link) kept.link = what.link;
  };

  for (const s of source.screens) {
    const group = label(s.group);
    for (const st of s.states ?? []) add(st.url, { group, label: label(st.label), kind: "state" });
    for (const name of LINKS) if (s.links?.[name]) add(s.links[name], { group, label: `${label(s.title)}, ${name.replace("_", " ")}`, kind: "variant", link: name });
  }
  /* The lists beside the screens are the reference's own check lists: their titles and labels are its
     notes, written for whoever keeps it. Such a state crosses with its key and its group and no words. */
  for (const a of source.also ?? []) {
    for (const st of a.states ?? []) add(st.url, { group: label(a.group), label: "", kind: "also" });
  }
  for (const o of source.ohcal ?? []) {
    for (const st of o.in_app ?? []) add(st.url, { group: "Calendar", label: "", kind: "also" });
  }

  return { studioTag: at.studioTag, studioCommit: at.studioCommit, screens, states: [...byKey.values()] };
}

/** `registry.json` as text: one state a line, so a later tag's diff reads state by state. @param {import("./registry.d.mts").Registry} registry */
export function registryText(registry) {
  const head = `{\n"studioTag": ${JSON.stringify(registry.studioTag)},\n"studioCommit": ${JSON.stringify(registry.studioCommit)},\n`;
  const rows = (/** @type {unknown[]} */ list) => list.map((r) => JSON.stringify(r)).join(",\n");
  return `${head}"screens": [\n${rows(registry.screens)}\n],\n"states": [\n${rows(registry.states)}\n]\n}\n`;
}
