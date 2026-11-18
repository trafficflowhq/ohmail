import { describe, expect, it } from "vitest";
import { formatFileSize } from "@ohmail/ui/file-size";

/**
 * ═══ ONE SIZE, SAID ONE WAY ════════════════════════════════════════════════════════════════
 *
 * The cases below are the three private copies this replaced, merged: `AttachmentStrip`'s
 * documented examples (a decimal MB, a larger decimal MB and a whole KB), `AttachmentPreview`'s claim to agree with
 * it, and `ComposeAttach`'s — which was 1024-based, so the composer and the reading pane named
 * different sizes for one file. 1000-based, like the Finder the file is about to land in.
 */
describe("formatFileSize", () => {
  it("names the sizes the two reading surfaces already named", () => {
    expect(formatFileSize(512, "en")).toBe("512 B");
    expect(formatFileSize(748_000, "en")).toBe("748 KB");
    expect(formatFileSize(2_300_000, "en")).toBe("2.3 MB");
    expect(formatFileSize(18_200_000, "en")).toBe("18.2 MB");
    expect(formatFileSize(4_000_000_000, "en")).toBe("4 GB");
  });

  it("never a trailing .0, and one decimal only below 100 of a unit", () => {
    expect(formatFileSize(3_000_000, "en")).toBe("3 MB");
    expect(formatFileSize(99_400_000, "en")).toBe("99.4 MB");
    // At 100 the decimal goes: three significant figures is what a file size is worth, and
    // a decimal there is a number nobody reads.
    expect(formatFileSize(101_300_000, "en")).toBe("101 MB");
  });

  it("the boundaries, where an off-by-one would live", () => {
    expect(formatFileSize(0, "en")).toBe("0 B");
    expect(formatFileSize(999, "en")).toBe("999 B");
    expect(formatFileSize(1_000, "en")).toBe("1 KB");
    expect(formatFileSize(999_999, "en")).toBe("1,000 KB");
    expect(formatFileSize(1_000_000, "en")).toBe("1 MB");
    // A terabyte has no unit above GB, so it says so in GB rather than falling off the ladder.
    expect(formatFileSize(2_000_000_000_000, "en")).toBe("2,000 GB");
  });

  /**
   * THE LOCALE, and it is why the argument is required. A decimal point in a German pane is a
   * thousands separator: a decimal size reads as a size far larger, which is the
   * measured failure `formatStorageBytes` was given its own locale argument for.
   */
  it("reads in the reader's own language", () => {
    expect(formatFileSize(2_300_000, "de")).toBe("2,3 MB");
    expect(formatFileSize(18_200_000, "de")).toBe("18,2 MB");
    // …and the whole-number arm is the same string in both, so a test that only checked this one
    // would pass against a formatter that ignored the locale entirely.
    expect(formatFileSize(3_000_000, "de")).toBe("3 MB");
    expect(formatFileSize(3_000_000, "en")).toBe("3 MB");
  });

  it("the units stay the product's own, not Intl's", () => {
    // `Intl`'s `style: "unit"` renders these as "kB" and "Byte"/"byte", and spaces German
    // gigabytes with U+00A0 while spacing German megabytes with U+0020. Every size in the product
    // says B/KB/MB/GB with an ordinary space; this is that law, asserted rather than assumed.
    for (const locale of ["en", "de"]) {
      expect(formatFileSize(748_000, locale)).toMatch(/^748 KB$/);
      expect(formatFileSize(12, locale)).toMatch(/^12 B$/);
      expect(formatFileSize(4_000_000_000, locale)).toMatch(/^4 GB$/);
    }
  });
});
