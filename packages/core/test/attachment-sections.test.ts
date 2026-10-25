import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeMime } from "../src/mime.js";
import {
  attachmentSections, candidateSections, decodedSectionBytes, enumerateSections, legacyPrediction,
  locateSections, sectionBytes, transferDecoded, type LocatedSection,
} from "../src/mime-sections.js";
import { structureOf } from "../src/adapters/imap-structure.js";
import type { MimeStructure } from "../src/types.js";
import { SECTION_CORPUS, type CorpusEntry } from "./fixtures/attachment-sections/corpus.js";

/**
 * THE SECTION ORACLE, REPLAYED WITH NO SERVER. `oracles/*.json` holds what Dovecot 2.3.21 said
 * about each corpus tree: its BODYSTRUCTURE, the RFC 3501 sections the recorder enumerated itself,
 * and per section the sha of the undecoded `BODY[n]`, the transfer-decoded bytes and the door's
 * download (64-bit prefixes). (a) numbers, (b) cuts and decodes, (c) the ingest match and (d) the
 * door's repair order are each judged against it, tree by tree. Re-record: record-sections.mjs.
 */

interface OracleSection { section: string; kind: string; raw: string | null; served?: string; bytes?: number; decoded?: string; textTransform?: boolean }
interface OracleRecord {
  sourceSha256: string; servedSourceSha256?: string; structure: unknown; sections: OracleSection[];
  mailparser3918?: Array<[string | null, string | null]>;
}
const ORACLES: Record<string, OracleRecord> = Object.assign({}, ...["nested", "generated", "hand"].map((g) =>
  (JSON.parse(readFileSync(join(__dirname, "fixtures/attachment-sections/oracles", `${g}.json`), "utf8")) as { fixtures: Record<string, OracleRecord> }).fixtures));

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const short = (b: Uint8Array): string => sha(b).slice(0, 16);
/** The source as the server holds it: Dovecot served bare LFs back as CRLF, and the oracle says when. */
const served = (e: CorpusEntry): Buffer => ORACLES[e.name]!.servedSourceSha256 === undefined
  ? e.raw : Buffer.from(e.raw.toString("latin1").replace(/\r?\n/g, "\r\n"), "latin1");
const structureFor = (e: CorpusEntry): MimeStructure => structureOf(ORACLES[e.name]!.structure)!;
/** The bytes the oracle says a section's file holds once transfer-decoded. */
const decodedOf = (s: OracleSection): string | undefined => s.decoded ?? s.served;

describe("the corpus and its oracle are the same bytes", () => {
  it("every corpus tree has one oracle record made over exactly its source, and nothing else does", () => {
    expect(SECTION_CORPUS.length).toBeGreaterThan(300);
    expect(Object.keys(ORACLES).sort()).toEqual(SECTION_CORPUS.map((e) => e.name).sort());
    for (const e of SECTION_CORPUS) {
      expect(sha(e.raw), e.name).toBe(ORACLES[e.name]!.sourceSha256);
      const normalized = ORACLES[e.name]!.servedSourceSha256;
      if (normalized !== undefined) expect(sha(served(e)), `${e.name} served`).toBe(normalized);
      expect(structureOf(ORACLES[e.name]!.structure), e.name).toBeDefined();
    }
  });
});

describe("(a) the sections are the server's, by RFC 3501", () => {
  it("enumerateSections equals the oracle's section list on every tree", () => {
    for (const e of SECTION_CORPUS) {
      const got = enumerateSections(structureFor(e))!.map((s) => `${s.section}:${s.kind}`);
      expect(got, e.name).toEqual(ORACLES[e.name]!.sections.map((s) => `${s.section}:${s.kind}`));
    }
  });

  it("CONTROL: an rfc822's single-part body is n.1 in the oracle, not the n imapflow labels it", () => {
    const sections = ORACLES["hand-rfc822-inline-png"]!.sections.map((s) => s.section);
    expect(sections).toEqual(["1", "2", "2.1"]);
  });
});

describe("(b) the locator cuts and decodes what the server serves", () => {
  for (const group of ["nested", "generated", "hand"] as const) {
    it(`${group}: every located section's undecoded and decoded sha equal the oracle's, or the shape refuses`, () => {
      let compared = 0;
      for (const e of SECTION_CORPUS.filter((x) => x.group === group)) {
        const loc = locateSections(served(e), structureFor(e));
        expect(loc.ok, `${e.name}: ${loc.ok ? "located" : loc.why}`).toBe(e.outcome !== "locator_refuses");
        if (!loc.ok) continue;
        const want = new Map(ORACLES[e.name]!.sections.map((s) => [s.section, s]));
        for (const s of loc.sections) {
          const o = want.get(s.section)!;
          const cut = sectionBytes(served(e), s);
          // An ENCODED rfc822's inside reads to Dovecot as a header with no blank line, which it ends
          // with a CRLF when serving `BODY[n]`; its decode, the bytes compared, is unaffected.
          const sealed = s.kind === "rfc822" && !["", "7bit", "8bit", "binary"].includes((s.node.encoding ?? "").toLowerCase());
          const raws = sealed ? [short(cut), short(Buffer.concat([cut, Buffer.from("\r\n")]))] : [short(cut)];
          expect(raws, `${e.name} ${s.section} raw`).toContain(o.raw);
          if (s.kind !== "multipart") expect(short(decodedSectionBytes(served(e), s)), `${e.name} ${s.section} decoded`).toBe(decodedOf(o));
          compared += 1;
        }
        expect([...loc.sections.map((s) => s.section), ...loc.opaque].sort(), e.name).toEqual([...want.keys()].sort());
      }
      expect(compared).toBeGreaterThan(group === "generated" ? 2000 : 20);
    });
  }

  it("an encoded rfc822's inside is opaque and the rest of its message is cut", () => {
    const e = SECTION_CORPUS.find((x) => x.name === "hand-rfc822-base64")!;
    const loc = locateSections(served(e), structureFor(e));
    expect(loc.ok && loc.opaque).toEqual(["2.1"]);
  });

  it("an LF-only source cuts to the same files, a 7bit text file differing only by its line ends", () => {
    const e = SECTION_CORPUS.find((x) => x.name === "hand-lf-only")!;
    const loc = locateSections(e.raw, structureFor(e));
    if (!loc.ok) throw new Error(loc.why);
    const byName = new Map(loc.sections.map((s) => [s.section, s]));
    const o = new Map(ORACLES[e.name]!.sections.map((s) => [s.section, s]));
    expect(short(decodedSectionBytes(e.raw, byName.get("2")!))).toBe(decodedOf(o.get("2")!));
    expect(Buffer.from(decodedSectionBytes(e.raw, byName.get("3")!)).toString()).toBe("one\ntwo\n");
  });

  it("CONTROL: a structure whose boundary the source does not carry refuses rather than cutting", () => {
    const e = SECTION_CORPUS.find((x) => x.name === "nested-f2")!;
    const s = structureFor(e);
    const wrong: MimeStructure = { ...s, params: { ...s.params, boundary: "not-the-boundary" } };
    expect(locateSections(served(e), wrong)).toEqual({ ok: false, why: "no_close" });
  });
});

describe("(c) ingest stores the section whose bytes are the file", () => {
  it("every file is matched to the oracle's own section for its bytes, or truly has none", async () => {
    let matched = 0;
    let refused = 0;
    const absent: string[] = [];
    for (const e of SECTION_CORPUS) {
      const files = (await normalizeMime(served(e))).attachments;
      const got = attachmentSections(served(e), structureFor(e), files);
      const oracle = new Map(ORACLES[e.name]!.sections.map((s) => [s.section, s]));
      if (e.outcome === "locator_refuses") {
        expect(got.every((m) => !m.matched && m.reason === "locator_failed"), e.name).toBe(true);
        refused += got.length;
        continue;
      }
      got.forEach((m, i) => {
        const want = files[i]!.contentSha256!.slice(0, 16);
        if (!m.matched) {
          // Never a false "no equal section": the oracle holds no section with these bytes either.
          expect(m.reason, `${e.name} file ${i}`).toBe("no_equal_sha");
          expect([...oracle.values()].some((s) => s.kind !== "multipart" && decodedOf(s) === want), `${e.name} file ${i}`).toBe(false);
          absent.push(e.name);
          return;
        }
        expect(decodedOf(oracle.get(m.section)!), `${e.name} ${m.section}`).toBe(want);
        matched += 1;
      });
      expect(new Set(got.map((m) => (m.matched ? m.section : ""))).size, `${e.name} distinct`).toBe(got.length);
    }
    expect(absent).toEqual(SECTION_CORPUS.filter((e) => e.outcome === "mailparser_differs").map((e) => e.name));
    expect(matched).toBeGreaterThan(1300);
    expect(refused).toBeGreaterThan(0);
  });

  it("CONTROL: a file whose bytes no section holds is unmatched and keeps its hint", async () => {
    const e = SECTION_CORPUS.find((x) => x.name === "nested-f2")!;
    const files = (await normalizeMime(served(e))).attachments.map((a) => ({ ...a, contentSha256: sha(Buffer.from("not in this message")) }));
    expect(attachmentSections(served(e), structureFor(e), files).map((m) => (m.matched ? m.section : m.reason)))
      .toEqual(files.map(() => "no_equal_sha"));
    expect(attachmentSections(served(e), undefined, files).map((m) => (m.matched ? "" : m.reason))).toEqual(files.map(() => "no_structure"));
  });

  it("the same picture twice takes both sections, mailparser's id deciding which is which", async () => {
    const e = SECTION_CORPUS.find((x) => x.name === "hand-same-logo-twice")!;
    const files = (await normalizeMime(served(e))).attachments;
    expect(attachmentSections(served(e), structureFor(e), files).map((m) => (m.matched ? m.section : ""))).toEqual(["2", "3"]);
  });
});

describe("(d) the door's order reaches an older row's file within three downloads", () => {
  it("for the id 3.9.18 stored and the id 3.9.32 stored, on every tree", async () => {
    const counts = { direct: 0, repaired3918: 0, repaired3932: 0, missed: [] as string[], unverifiable: new Set<string>() };
    for (const e of SECTION_CORPUS.filter((x) => x.outcome !== "locator_refuses")) {
      const structure = structureFor(e);
      const files = (await normalizeMime(served(e))).attachments;
      const oracle = new Map(ORACLES[e.name]!.sections.filter((s) => s.kind !== "multipart").map((s) => [s.section, s.served]));
      const legacy = [...(ORACLES[e.name]!.mailparser3918 ?? [])];
      for (const a of files) {
        const want = a.contentSha256!.slice(0, 16);
        // No section the door can download hashes to the stored sha: the gate refuses, whatever the order.
        if (![...oracle.values()].includes(want)) { counts.unverifiable.add(e.name); continue; }
        const li = legacy.findIndex(([h]) => h === want);
        const old = li >= 0 ? legacy.splice(li, 1)[0]![1] : a.partId;
        for (const [label, stored] of [["3918", old], ["3932", a.partId]] as const) {
          const first = stored ?? "1";
          if (oracle.get(first) === want) { counts.direct += 1; continue; }
          const tries = candidateSections(structure, { partId: stored, contentType: a.contentType, filename: a.filename }).slice(0, 3);
          if (tries.some((s) => oracle.get(s) === want)) counts[label === "3918" ? "repaired3918" : "repaired3932"] += 1;
          else counts.missed.push(`${e.name} ${label} stored=${stored}`);
        }
      }
    }
    expect(counts.missed).toEqual([]);
    expect([...counts.unverifiable]).toEqual(SECTION_CORPUS
      .filter((e) => e.outcome === "mailparser_differs" || e.outcome === "door_decodes_otherwise").map((e) => e.name));
    expect(counts.repaired3918).toBeGreaterThan(300);
    expect(counts.repaired3932).toBeGreaterThan(10);
  });

  it("the 3.9.18 replay predicts exactly what 3.9.18 stored, over every tree", async () => {
    let compared = 0;
    for (const e of SECTION_CORPUS) {
      const structure = structureFor(e);
      const sections = enumerateSections(structure)!.filter((s) => s.kind !== "multipart");
      const predicted = legacyPrediction(structure);
      const oracle = new Map(ORACLES[e.name]!.sections.map((s) => [s.section, s]));
      const taken = new Set<string>();
      for (const [h, partId] of ORACLES[e.name]!.mailparser3918 ?? []) {
        const at = sections.find((s) => !taken.has(s.section) && decodedOf(oracle.get(s.section)!) === h);
        if (at === undefined || e.outcome === "locator_refuses") continue;
        taken.add(at.section);
        expect(predicted.get(at.node) ?? null, `${e.name} ${at.section}`).toBe(partId);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(1300);
  });
});

describe("the decoders are mailparser's own", () => {
  /* mailparser 3.9.32 decodes through @zone-eu/mailsplit with libbase64 1.3.1 and libqp 2.1.2; the
     ports must answer byte for byte what those copies answer, fed as mailsplit feeds them: one
     chunk for a part ending at a delimiter, two for a body ending the source without a line end. */
  const fromMailparser = createRequire(createRequire(import.meta.url).resolve("mailparser"));
  const mailsplit = createRequire(fromMailparser.resolve("@zone-eu/mailsplit"));
  const libbase64 = mailsplit("libbase64") as { Decoder: new () => import("node:stream").Transform };
  const libqp = mailsplit("libqp") as { decode: (b: Buffer) => Buffer };
  const throughDecoder = async (chunks: Buffer[]): Promise<Buffer> => {
    const d = new libbase64.Decoder();
    const out: Buffer[] = [];
    d.on("data", (c: Buffer) => out.push(c));
    const done = new Promise((r) => d.on("end", r));
    for (const c of chunks) d.write(c);
    d.end();
    await done;
    return Buffer.concat(out);
  };
  const leafAt = (encoding: string, end: number): LocatedSection => ({ section: "1", kind: "leaf", start: 0, end,
    node: { type: "application/octet-stream", encoding, params: {}, id: null, disposition: null, size: null, children: [] } });
  /** The body inside a source that continues past it (a delimiter follows): one chunk. */
  const insideSource = (encoding: string, body: Buffer): Buffer =>
    Buffer.from(decodedSectionBytes(Buffer.concat([body, Buffer.from("\r\n--B--\r\n")]), leafAt(encoding, body.length)));
  /** The body ending the source with no line end: mailsplit's two chunks. */
  const endingSource = (encoding: string, body: Buffer): Buffer => Buffer.from(decodedSectionBytes(body, leafAt(encoding, body.length)));
  const SAMPLES = [
    "aGVsbG8gd29ybGQ=\r\n", "aGVs\r\nbG8=\r\nd29y\r\nbGQ=\r\n", "aGVsbG8gd29ybGQ", "aGVsbG8=d29ybGQ=\r\n",
    "  aGVs bG8g\td29y bGQ=  \r\n", "@@!!aGVsbG8$$\r\n", "\u00c1\u00e1GVsbG8=", "=", "", "aGVs\r\nbG8=d29y\r\nbGQ",
  ].map((x) => Buffer.from(x, "latin1"));

  it("pins the copies it is compared with", () => {
    expect((mailsplit("libbase64/package.json") as { version: string }).version).toBe("1.3.1");
    expect((mailsplit("libqp/package.json") as { version: string }).version).toBe("2.1.2");
  });

  it("base64: the port equals libbase64's Decoder in one chunk and in mailsplit's two", async () => {
    for (const s of SAMPLES) {
      const label = JSON.stringify(s.toString("latin1"));
      expect(insideSource("base64", s).toString("hex"), label).toBe((await throughDecoder([s])).toString("hex"));
      const lastNl = s.lastIndexOf(0x0a);
      const tail = s[s.length - 1] === 0x0a ? Buffer.concat([s, Buffer.from("QQ")]) : s;
      const nl = tail.lastIndexOf(0x0a);
      const chunks = nl >= 0 ? [tail.subarray(0, nl + 1), tail.subarray(nl + 1)] : [tail];
      expect(endingSource("base64", tail).toString("hex"), `${label} ending (${lastNl})`).toBe((await throughDecoder(chunks)).toString("hex"));
    }
  });

  it("quoted-printable: the port equals libqp's decode", () => {
    for (const s of ["Ren\x3dC3\x3dA9  \r\nsoft=\r\nbreak", "tail=", "=4=41 ==41 =zz", "a\t \r\nb ", "=\r\n=\n="]) {
      expect(insideSource("quoted-printable", Buffer.from(s, "latin1")).toString("hex"), s).toBe(libqp.decode(Buffer.from(s, "latin1")).toString("hex"));
    }
  });

  it("a served body still in its transfer encoding decodes by the declared one; nothing else is touched", async () => {
    const b64 = Buffer.from("aGVs\r\nbG8=\r\n", "latin1");
    expect(Buffer.from(transferDecoded(b64, "BASE64")!).toString("hex")).toBe((await throughDecoder([b64])).toString("hex"));
    expect(Buffer.from(transferDecoded(Buffer.from("soft=\r\nbreak=20here"), "quoted-printable")!).toString()).toBe("softbreak here");
    for (const enc of ["7bit", "binary", null]) expect(transferDecoded(b64, enc)).toBeNull();
  });
});

describe("the converter keeps what the server said and bounds what it keeps", () => {
  it("drops imapflow's part label and every non-string parameter", () => {
    expect(structureOf({ part: "2", type: "Image/PNG", encoding: "BASE64", parameters: { Name: "a.png", n: 3 }, childNodes: [] }))
      .toEqual({ type: "image/png", encoding: "base64", params: { name: "a.png" }, id: null, disposition: null, size: null, children: [] });
  });

  it("refuses a tree past its depth or node bound, and a node that is not one", () => {
    let deep: Record<string, unknown> = { type: "text/plain" };
    for (let i = 0; i < 150; i += 1) deep = { type: "multipart/mixed", childNodes: [deep] };
    expect(structureOf(deep)).toBeUndefined();
    expect(structureOf({ type: "multipart/mixed", childNodes: Array.from({ length: 2500 }, () => ({ type: "text/plain" })) })).toBeUndefined();
    expect(structureOf("text/plain")).toBeUndefined();
    expect(structureOf(undefined)).toBeUndefined();
  });
});

describe("the tree rides with the source through a correlated move", () => {
  it("a move paired from a create carries that create's structure", async () => {
    const { correlateMoves } = await import("../src/adapters/imap.js");
    type Creates = Parameters<typeof correlateMoves>[0];
    type Deletes = Parameters<typeof correlateMoves>[1];
    const tree = structureOf({ type: "multipart/mixed", parameters: { boundary: "b" }, childNodes: [{ type: "text/plain" }] })!;
    const creates: Creates = [{ folder: "Archive", uidValidity: 7n, uid: 3, raw: Buffer.from("x"), seen: false, messageId: "m@x", structure: tree }];
    const deletes: Deletes = [{ folder: "INBOX", uidValidity: 7n, uid: 9, messageId: "m@x" }];
    const out = correlateMoves(creates, deletes);
    expect(out.moves.map((m) => m.structure)).toEqual([tree]);
    expect(correlateMoves([{ ...creates[0]!, structure: undefined }], deletes).moves[0]).not.toHaveProperty("structure");
  });
});
