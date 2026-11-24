import { describe, expect, it } from "vitest";
import { sectionHoldsFile } from "../src/mime-sections.js";
import type { MimeStructure } from "../src/types.js";

/**
 * When a download of a stored attachment misses its checksum, the server's tree decides what
 * went wrong: if the stored section still is the file (a leaf of its type, under its name), the
 * read failed and reading it again is the repair; anything else means the row points elsewhere.
 */
const node = (type: string, opts: { name?: string; children?: MimeStructure[] } = {}): MimeStructure => ({
  type,
  encoding: opts.children === undefined ? "base64" : null,
  params: {},
  id: null,
  disposition: opts.name === undefined ? null : { type: "attachment", params: { filename: opts.name } },
  size: opts.children === undefined ? 1024 : null,
  children: opts.children ?? [],
});

// 1 text/plain, 2 application/pdf "invoice.pdf", 3 application/octet-stream "invoice.pdf",
// 4 multipart/alternative (4.1, 4.2)
const letter = node("multipart/mixed", {
  children: [
    node("text/plain"),
    node("application/pdf", { name: "invoice.pdf" }),
    node("application/octet-stream", { name: "invoice.pdf" }),
    node("multipart/alternative", { children: [node("text/plain"), node("text/html")] }),
  ],
});

describe("the stored section still holds the row's file", () => {
  it("a leaf at the row's section, of its type and under its name, holds it", () => {
    expect(sectionHoldsFile(letter, { partId: "2", contentType: "application/pdf", filename: "invoice.pdf" })).toBe(true);
    expect(sectionHoldsFile(letter, { partId: "2", contentType: "Application/PDF; name=invoice.pdf", filename: " invoice.pdf " })).toBe(true);
  });

  it("a server's octet-stream under the row's name holds it", () => {
    expect(sectionHoldsFile(letter, { partId: "3", contentType: "application/pdf", filename: "invoice.pdf" })).toBe(true);
  });

  it("a row with no name is held by a leaf of its type", () => {
    expect(sectionHoldsFile(letter, { partId: "2", contentType: "application/pdf", filename: null })).toBe(true);
  });

  it("another type, another name, a multipart, a missing section or no section at all does not", () => {
    expect(sectionHoldsFile(letter, { partId: "1", contentType: "application/pdf", filename: "invoice.pdf" })).toBe(false);
    expect(sectionHoldsFile(letter, { partId: "2", contentType: "application/pdf", filename: "receipt.pdf" })).toBe(false);
    expect(sectionHoldsFile(letter, { partId: "4", contentType: "multipart/alternative", filename: null })).toBe(false);
    expect(sectionHoldsFile(letter, { partId: "9", contentType: "application/pdf", filename: "invoice.pdf" })).toBe(false);
    expect(sectionHoldsFile(letter, { partId: null, contentType: "application/pdf", filename: "invoice.pdf" })).toBe(false);
  });
});
