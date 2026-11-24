import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("StreamCard — the clamp tells the truth about what it is clamping", () => {
  it("and the CSS that un-hides that pill exists — and the fade is NOT dropped any more", async () => {
    /**
     * The class is inert without the rule, and the rule lives in a stylesheet jsdom does not
     * load — so it is asserted as text.
     *
     * THE SECOND HALF OF THIS PAIR IS GONE, AND ITS REASON WITH IT. It used to assert
     * `.scast.short.pend .sc-fade{display:none}`, because an 88px gradient over two lines of
     * snippet reads as a rendering fault. `.scast.short .sc-fade{display:none}` already reaches a
     * short waiting card, and a second rule changed the pill's margins at the moment the body
     * arrived (`566 → 550` at 1440). The absence is asserted, not merely un-asserted: this is the
     * one place that named it.
     */
    // `process.cwd()` rather than `import.meta.url`: this file runs under jsdom, where
    // `import.meta.url` is not a file: URL and `fileURLToPath` refuses it. Vitest runs from
    // the repository root (see the root `vitest.config.ts` include globs).
    const css = readFileSync(resolve(process.cwd(), "packages/ui/src/composites/stream.css"), "utf8");
    expect(css).toContain(".scast.short.pend .sc-x{display:flex}");
    expect(css).not.toContain(".scast.short.pend .sc-fade{display:none}");
    // …and the box a waiting card reserves: its own estimate, at most the clamp.
    expect(css).toContain(".scast.pend .sc-clip{min-height:var(--sc-reserve,120px)}");
    // The rule it has to override is still there — otherwise this pair would be decoration.
    expect(css).toContain(".scast.short:not(.open):not(.pend) .sc-x{position:absolute;");
  });
});
