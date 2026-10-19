import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { publicPath } from "./support/public-root.mjs";

/**
 * ══ WHAT LEFT THE README IS STILL SAID, WHERE THE README SENDS YOU ═══════════════════════════
 *
 * The README was shortened and its long form moved under docs/. The README's own claims stay
 * pinned where they were (ai-provider-draft-disclosure and desktop-shell read the README's provider
 * section and its CSP sentence). This file pins the long form at its new place, so a page the README
 * links cannot quietly say less, or say something the README's short form contradicts.
 */
const read = (rel: string): string => readFileSync(publicPath(rel), "utf8");
const readme = read("README.md");

describe("the docs the README links", () => {
  it("every docs/ page the README links exists", () => {
    const linked = [...readme.matchAll(/\]\((docs\/[^)#\s]+)/g)].map((m) => m[1]!);
    expect(linked.length).toBeGreaterThanOrEqual(8);
    for (const rel of new Set(linked)) expect(() => read(rel), rel).not.toThrow();
  });

  it("docs/ai.md lists the README's four model options, each with the host it reaches", () => {
    const start = readme.indexOf("### Model providers and keys");
    const short = readme.slice(start, readme.indexOf("\n## ", start));
    const guide = read("docs/ai.md");
    const long = guide.slice(guide.indexOf("## Model providers and keys"));
    const named = (text: string) => [...text.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1]);
    expect(named(short)).toEqual(["Your Anthropic key", "Your OpenAI key", "Your OpenCode Go key", "A model on this machine"]);
    expect(named(long).slice(0, 4)).toEqual(named(short));
    for (const host of ["api.anthropic.com", "api.openai.com", "opencode.ai", "127.0.0.1:11434"]) {
      expect(short, host).toContain(host);
      expect(long, host).toContain(host);
    }
    // The four are offered on the server stack too; the old "shorter today" was false.
    expect(guide).not.toMatch(/shorter today/);
    expect(guide).toContain("self-host/README.md#screener-suggestions-and-reply-drafts");
  });

  it("docs/architecture.md states the window's policy the way the overlays do", () => {
    // desktop-shell holds the README, SECURITY.md and apps/desktop/README.md to the same three facts.
    const text = read("docs/architecture.md");
    expect(text).toMatch(/in-process command scheme/);
    expect(text).toMatch(/tauri\.(?:<os>|linux|macos|windows)\.conf\.json/);
    expect(text.split("connect-src 'none'").length - 1, "docs/architecture.md says connect-src 'none'").toBe(0);
    // The command list is named by where it is declared, never by a count that goes stale.
    expect(text).toContain("WINDOW_COMMANDS");
    expect(text).not.toMatch(/\b(?:thirty|forty)-\w+ commands\b/);
  });

  it("docs/organizing.md carries the frozen folder set the README draws", () => {
    const fence = (text: string) =>
      /The folders ohmail creates are a small, frozen set:[\s\S]*?```\n([\s\S]*?)```/.exec(text)?.[1];
    expect(fence(readme), "the README's folder fence").toBeDefined();
    expect(fence(read("docs/organizing.md"))).toBe(fence(readme));
  });
});
