import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * the Tags rail group must REMEMBER whether it was folded.
 *
 * Reported: "collapsable though, and saved if it's collapsed or not so ui stays as one left it".
 * The group was already its own top-level entry (tags are cross-cutting, not a fourth triage
 * pile) — what was missing was that `useState(defaultOpen)` forgets on every reload.
 *
 * Asserted at the source level rather than by rendering, because the property that matters is
 * WHERE the state lives: `packages/ui` is shared with the desktop shell, which has no
 * `localStorage`. A design-system component that reached for browser storage would be wrong
 * even while appearing to work in the browser.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

/**
 * Strip comments before asserting about CODE.
 *
 * The first version of this file failed on its own documentation: `RailNav`'s new comment
 * explains that the desktop shell "has no `localStorage`", and a bare grep for that word read
 * the explanation as the violation it was describing. Prose is not evidence — in either
 * direction — so assertions about what the code DOES must not see what the code SAYS.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const railNav = code(read("../../../packages/ui/src/composites/RailNav.tsx"));
const persisted = code(read("../../../packages/app-logic/src/storage/persisted-ui.ts"));

describe("the Tags group remembers its collapse state", () => {

  it("the shared UI package never touches browser storage", () => {
    // The whole reason the component is controlled-optional. If this ever fails, the desktop
    // shell has inherited a web-only storage decision it cannot satisfy. The rail every host's
    // frame draws is the kit's (`@ohmail/ui/mail`: the rail and its entries, the Tags group a
    // place draws itself among them), read here beside the older `RailNav`.
    const rails = ["Rail.tsx", "RailEntry.tsx", "RailFoot.tsx"]
      .map((f) => code(read(`../../../packages/ui/src/mail/Shell/${f}`))).join("\n");
    expect(rails).not.toMatch(/localStorage|sessionStorage/);
    expect(railNav).not.toMatch(/localStorage|sessionStorage/);
  });

  it("reads storage AFTER mount, or the server's value silently wins", () => {
    // Reading `localStorage` in the initial state makes server and client render different
    // markup; React resolves that mismatch by keeping the SERVER's value, so the stored
    // preference would be read and then thrown away. One frame of default, then the truth.
    //
    // Stated POSITIONALLY, not as a pattern to avoid. The first version of this assertion was
    // `not.toMatch(/useState\([^)]*localStorage/)`, which cannot cross a `)` — so the exact
    // regression it existed to catch, `useState(() => localStorage.getItem(key) === "1")`,
    // walked straight past it. The invariant is not "no read looks a certain way", it is
    // "nothing reads storage before the effect runs", and the hook's own ordering carries it:
    // the effect calls `setValue`, so the state declaration is always above it.
    const hook = persisted.slice(persisted.indexOf("export function usePersistedFlag"));
    const beforeEffect = hook.slice(0, hook.indexOf("useEffect("));
    expect(beforeEffect).not.toMatch(/localStorage|sessionStorage/);
    expect(hook).toMatch(/useEffect\(\(\) => \{[\s\S]*?localStorage\.getItem/);
  });

  it("never lets a blocked storage break the shell", () => {
    // Safari private mode throws on setItem. A rail preference is not worth an exception.
    const reads = persisted.split("localStorage.getItem")[0];
    expect(reads).toContain("try {");
    expect(persisted.split("localStorage.setItem")[0]).toContain("try {");
  });
});

describe("Tags is a peer in the rail, not a child of Triage", () => {
  it("the Tags fold uses the rail's top-level alignment", () => {
    const place = code(read("../../../packages/app/src/tags/place.ts"));
    const tags = code(read("../../../packages/app/src/tags/TagsRail.tsx"));
    const css = code(read("../../../packages/ui/src/mail/Shell/rail-entry.css"));
    expect(place).toContain('railGroup: { group: "tags", Body: TagsRail }');
    const fold = tags.match(/<RailEntry\s+kind="fold"[\s\S]*?>/)?.[0];
    expect(fold).toContain('expanded={open}');
    expect(fold).not.toMatch(/\bdepth=/);
    const base = css.match(/\.oh-railentry \{([^}]+)\}/)?.[1];
    expect(base).toMatch(/--oh-railentry-depth:\s*0;/);
  });
});
