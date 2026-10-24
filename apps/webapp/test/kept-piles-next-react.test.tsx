/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

/**
 * THE KEPT PILES UNDER THE REACT THE WEB APP SHIPS WITH. Next's App Router does not render with the
 * workspace's `react`: it swaps in its own vendored copy (`next/dist/compiled/react`), and that copy
 * may lack an export the workspace's React has. 0.30.2 imported `Activity` from "react"; the vendored
 * 19.2 canary has none, so `Activity` was undefined in the web bundle and the first press of News or
 * Receipts threw React #130 ("Element type is invalid"), outside the piles' own boundaries. Every other
 * test resolves the workspace's React 19.2.3, which has `Activity`, and passed.
 *
 * So here every `react` import in the module graph is Next's vendored React, and the renderer is
 * Next's vendored react-dom, the pair the production web bundle runs. The shell's sequence is played:
 * News, the Ohbox, Receipts, News again.
 */
/* A name the vendored React does not export reads as undefined, as it does in the web bundle (webpack
   only warns "Attempted import error" and builds), not as vitest's "no such export on the mock" throw. */
const asBundled = (m: object): object => new Proxy({ ...m }, { has: () => true });
vi.mock("react", async () => asBundled(await import("next/dist/compiled/react" as string)));
vi.mock("react/jsx-runtime", async () => asBundled(await import("next/dist/compiled/react/jsx-runtime" as string)));
vi.mock("react/jsx-dev-runtime", async () => asBundled(await import("next/dist/compiled/react/jsx-dev-runtime" as string)));

const React = await import("react");
const { createRoot } = (await import("next/dist/compiled/react-dom/client" as string)) as typeof import("react-dom/client");
const { KeptPiles } = await import("../app/shell/kept-piles");
type KeptPileName = import("../app/shell/kept-piles").KeptPileName;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
let failures: string[] = [];

function Pile({ name }: { name: KeptPileName }) {
  return h("section", { className: `view view-${name}` }, `the ${name} pile`);
}

async function show(active: KeptPileName | null): Promise<void> {
  await act(async () => {
    root!.render(
      h(Boundary, null,
        h(KeptPiles, {
          active,
          piles: { reads: h(Pile, { name: "reads" }), receipts: h(Pile, { name: "receipts" }) },
          onError: (pile: KeptPileName, error: unknown) => { failures.push(`${pile}: ${String(error)}`); },
          fallback: (pile: KeptPileName) => h("div", { className: "view-fail" }, `${pile} failed`),
        }),
      ),
    );
  });
}

/** The shell's outer boundary (`AppShell.tsx`, keyed `piles:<engine>`): what catches a throw in KeptPiles itself. */
class Boundary extends React.Component<{ children?: React.ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  override componentDidCatch(error: unknown) { failures.push(`outer: ${String(error)}`); }
  override render() {
    return this.state.error ? h("div", { className: "view-fail" }, "the view failed") : this.props.children;
  }
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  vi.restoreAllMocks();
});

const visible = (p: KeptPileName): boolean => {
  const s = host!.querySelector<HTMLElement>(`.view-${p}`);
  return s !== null && s.style.display !== "none";
};

describe("News and Receipts under Next's own React", () => {
  it("is the vendored React this test renders with", () => {
    const vendored = createRequire(import.meta.url)("next/dist/compiled/react") as { version: string };
    expect(React.version).toBe(vendored.version);
  });

  it("News, the Ohbox, Receipts and News again all draw, with no failure card", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    failures = [];
    vi.spyOn(console, "error").mockImplementation(() => {});

    await show("reads");
    expect(failures).toEqual([]);
    expect(host.querySelector(".view-fail")).toBeNull();
    expect(visible("reads")).toBe(true);

    await show(null);
    expect(failures).toEqual([]);
    expect(host.querySelector(".view-fail")).toBeNull();
    expect(visible("reads")).toBe(false);

    await show("receipts");
    expect(failures).toEqual([]);
    expect(host.querySelector(".view-fail")).toBeNull();
    expect(visible("receipts")).toBe(true);
    expect(visible("reads")).toBe(false);

    await show("reads");
    expect(failures).toEqual([]);
    expect(visible("reads")).toBe(true);
    expect(visible("receipts")).toBe(false);
    expect(host.querySelectorAll(".view-reads")).toHaveLength(1);
  });
});
