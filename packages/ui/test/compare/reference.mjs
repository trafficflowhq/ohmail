/**
 * What the kit's reference files are named by and checked against. No browser and no file is touched
 * here, so the suite's own tests, the comparison run and the capture tool all read the same rules.
 */
import { createHash } from "node:crypto";

const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");

/** Every look a state can be drawn in, as `<face>-<scheme>-<device>`: two faces, two schemes, four sizes. */
export const LOOKS = ["paper", "ohmarchy"].flatMap((face) =>
  ["light", "dark"].flatMap((scheme) =>
    ["desktop", "phone", "fold", "foldl"].map((device) => `${face}-${scheme}-${device}`),
  ),
);
/** The look a state is drawn in when its row names none. */
export const BASELINE = "paper-light-desktop";

/** @param {{ component: string, state: string }} row */
export const stateKey = (row) => `${row.component}/${row.state}`;
/** The looks a row of `states.json` is compared in: all of them for a component's rest state. @param {{ looks?: "all" | string[] }} row */
export const looksOf = (row) => (row.looks === "all" ? LOOKS : (row.looks ?? [BASELINE]));
/** A reference's key: `<Component>/<state>@<look>`, also its data file's path without the extension. @param {{ component: string, state: string }} row @param {string} look */
export const referenceKey = (row, look) => `${stateKey(row)}@${look}`;

/** What a picture's row is checked against to tell "older than its state". @param {{ component: string, state: string, looks?: "all" | string[] }} row */
export const stateHash = (row) =>
  sha256(JSON.stringify([row.component, row.state, row.looks ?? null])).slice(0, 16);
/** The name a picture carries inside its archive: no slash and no `@` in an entry. @param {string} key */
export const fileOf = (key) => sha256(key).slice(0, 16);

/**
 * What may never stand in a reference file of this repository: a path or a page of the design
 * reference, a host, an address of a machine, or a mail address outside the invented world.
 */
export const PRIVATE =
  /simulator\/|system\/|\.html|redesign-|\b\d{1,3}(?:\.\d{1,3}){3}\b|\blocalhost\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b|@(?![a-z0-9.-]*\.example\b)[a-z0-9-]+\.[a-z]{2,}/i;
