import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A plain .mjs rig module, deliberately browser-safe and untyped.
import { corpus, corpusFingerprint, FOLDERS, CORPUS_NOW, CORPUS_OWNER } from "./rigs/import-corpus.mjs";

// The test `import-peak-rig.mjs` has cited since the corpus was extracted out of it. It did not
// exist, so the extraction was argued rather than proven (IMPORT-PEAK-RIG-CITES-A-TEST-THAT-DOES-
// NOT-EXIST). The pin below is the fingerprint the INLINE copy produced: read out of git at the
// commit before "fix(client-engine): a first import publishes in groups, not once per page"
// (2026-09-15), which is the commit that moved the corpus, and recomputed against the shared
// module. The Node rig is the store control the browser rig's renderer classes are read by
// SUBTRACTING, so a corpus that moved by one folder would land in the answer.
const INLINE_FINGERPRINT = "fnv1a:5920" + "409f:74003";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("the shared import corpus is the corpus the rig used to carry inline", () => {
  it("fingerprints to the value the pre-extraction inline copy produced", () => {
    expect(corpusFingerprint(corpus())).toBe(INLINE_FINGERPRINT);
  });

  it("is the rig maildir's full message count across its eight folders", () => {
    const messages = corpus();
    expect(messages).toHaveLength(74003);
    expect(FOLDERS.reduce((n: number, f: { count: number }) => n + f.count, 0)).toBe(74003);
    const perFolder = new Map<string, number>();
    for (const m of messages) perFolder.set(m.folder, (perFolder.get(m.folder) ?? 0) + 1);
    for (const f of FOLDERS) expect(perFolder.get(f.name)).toBe(f.count);
  });

  it("arrives oldest-first, the way a since=0 replay does, and reverses on desc", () => {
    const asc = corpus();
    for (let i = 1; i < asc.length; i++) expect(asc[i].date >= asc[i - 1].date).toBe(true);
    const desc = corpus({ order: "desc" });
    expect(desc[0].id).toBe(asc[asc.length - 1].id);
    expect(corpusFingerprint(desc)).not.toBe(INLINE_FINGERPRINT);
  });

  // THE POSITIVE CONTROL for the pin: a fingerprint nothing can move is a pin over nothing. One
  // folder's count moved by one message must change it, which is the property the citation rests on.
  it("moves when the distribution moves by a single message", () => {
    const base = corpus();
    const movedCount = corpusFingerprint(base.slice(0, base.length - 1));
    expect(movedCount).not.toBe(INLINE_FINGERPRINT);
    const movedFolder = base.map((m, i) => (i === 0 ? { ...m, folder: "Archive" } : m));
    expect(corpusFingerprint(movedFolder)).not.toBe(INLINE_FINGERPRINT);
  });

  it("is addressed to a rig domain and pinned to a fixed clock", () => {
    expect(CORPUS_OWNER).toMatch(/@rig\.test$/);
    expect(new Date(CORPUS_NOW).toISOString()).toBe("2026-09-12T10:00:00.000Z");
  });
});

describe("the module both rigs read it from", () => {
  const source = readFileSync(path.join(HERE, "rigs", "import-corpus.mjs"), "utf8");

  // Its own docblock claims "browser-safe by construction: no node: import anywhere in this file",
  // and the browser rig bundles it. A claim in a comment is the claim under test.
  it("imports nothing from node:", () => {
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(["']node:/);
  });

  // The browser rig is the maintainers' and is not in this repository, so only the Node rig's
  // import is read here.
  it("is the module the Node rig imports, not a copy of it", () => {
    const node = readFileSync(path.join(HERE, "rigs", "import-peak-rig.mjs"), "utf8");
    expect(node).toMatch(/from "\.\/import-corpus\.mjs"/);
  });
});
