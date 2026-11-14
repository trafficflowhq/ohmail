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
const shell = read("../app/shell/AppShell.tsx");
const persisted = code(read("../../../packages/app-logic/src/storage/persisted-ui.ts"));

describe("the Tags group remembers its collapse state", () => {
  it("the webapp OWNS the state and persists it", () => {
    expect(shell).toMatch(/usePersistedFlag\(UI_KEYS\.tagsOpen/);
    expect(shell).toMatch(/open: tagsOpen/);
    expect(shell).toMatch(/onOpenChange: setTagsOpen/);
  });

  it("holds the collapse flag in a rail-only component, never on the top-level shell (#97)", () => {
    // The performance half of the tag-collapse defect. `tagsOpen` on `AppShell` meant a toggle
    // re-rendered the exported shell and, with it, the active mailbox view — hundreds of rows to
    // reconcile for a rail fold, which is the ~5s. It now lives in a dedicated `ShellRail`
    // component, so a toggle re-renders only the rail; the view beside it is left alone (measured:
    // a toggle produces zero DOM mutations in the mailbox pane). Guarded positionally: the flag
    // must appear inside `ShellRail` and must NOT appear in `AppShell`'s own body.
    expect(shell).toMatch(/function ShellRail\([^)]*\)[\s\S]*?usePersistedFlag\(UI_KEYS\.tagsOpen/);
    const appShellBody = shell.slice(shell.indexOf("export function AppShell"));
    expect(appShellBody).not.toMatch(/usePersistedFlag\(UI_KEYS\.tagsOpen/);
  });

  it("the shared UI package never touches browser storage", () => {
    // The whole reason the component is controlled-optional. If this ever fails, the desktop
    // shell has inherited a web-only storage decision it cannot satisfy.
    expect(railNav).not.toMatch(/localStorage|sessionStorage/);
  });

  it("stays usable uncontrolled — a host that wires nothing still gets a working toggle", () => {
    // Degrade to today's behaviour (forgets), never to a dead button.
    expect(railNav).toMatch(/const \[uncontrolled, setUncontrolled\] = useState\(defaultOpen\)/);
    expect(railNav).toMatch(/const open = openProp \?\? uncontrolled/);
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
  const rail = readFileSync(fileURLToPath(new URL("../../../packages/ui/src/composites/rail.css", import.meta.url)), "utf8");

  it("the subordinate group carries no left indent", () => {
    // "tags is not indented in the menu (margin left currently within the menu)" — owner.
    // The 10px indent said Tags belonged to the group above it. It belongs to all of them.
    const rule = rail.split("\n").find((l) => l.includes(".rgroup.rsub{"));
    expect(rule, ".rgroup .rgroup.rsub rule not found").toBeTruthy();
    expect(rule).toBe(".rgroup .rgroup.rsub{margin:3px 0 0}");
  });
});
