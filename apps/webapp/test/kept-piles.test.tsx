/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { KeptPiles, type KeptPileName } from "../app/shell/kept-piles";
import { queryVisible, queryAllVisible } from "../app/shell/visible-dom";

/**
 * THE KEPT PILES (`kept-piles.tsx`): News and Receipts stay mounted, hidden, while the reader is on
 * another pile; each has a boundary of its own; and the shell's document queries skip the hidden
 * one (`visible-dom.ts`).
 *
 * Mutations watched red: one shared boundary for the piles (a throw in hidden Receipts replaces
 * the visible News — the boundary rows); keep a failed pile after the reader left it (the remount
 * row); `queryVisible` answering the document's first match (the strip row).
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let mounts: Record<KeptPileName, number> = { reads: 0, receipts: 0 };
let broken: Record<KeptPileName, boolean> = { reads: false, receipts: false };

function Pile({ name }: { name: KeptPileName }) {
  /* Counted where a MOUNT is counted: a state initializer runs once per mounted instance (an
     effect runs again at every reveal, which is the point of the visit contract). */
  React.useState(() => { mounts[name] += 1; return null; });
  if (broken[name]) throw new Error(`${name} broke`);
  return h("section", { className: `view view-${name}` }, `the ${name} pile`);
}

async function show(active: KeptPileName | null): Promise<void> {
  await act(async () => {
    root!.render(h(KeptPiles, {
      active,
      piles: { reads: h(Pile, { name: "reads" }), receipts: h(Pile, { name: "receipts" }) },
      onError: () => {},
      fallback: (pile: KeptPileName) => h("div", { className: "view-fail" }, `${pile} failed`),
    }));
  });
}

async function start(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounts = { reads: 0, receipts: 0 };
  broken = { reads: false, receipts: false };
  vi.spyOn(console, "error").mockImplementation(() => {});
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  vi.restoreAllMocks();
});

const section = (p: KeptPileName): HTMLElement | null => host!.querySelector<HTMLElement>(`.view-${p}`);
const marker = (p: KeptPileName): HTMLElement | null => host!.querySelector<HTMLElement>(`[data-pile="${p}"]`);

describe("a visited pile stays mounted, hidden", () => {
  it("leaving News keeps its DOM and state; coming back shows the same element", async () => {
    await start();
    await show("reads");
    const reads = section("reads");
    expect(marker("reads")!.hasAttribute("data-pile-active")).toBe(true);
    await show("receipts");
    expect(section("reads"), "News was unmounted on the way out").toBe(reads);
    expect(reads!.style.display).toBe("none");
    expect(marker("reads")!.hasAttribute("data-pile-active")).toBe(false);
    expect(marker("receipts")!.hasAttribute("data-pile-active")).toBe(true);
    await show(null); // the Ohbox: both kept, both hidden
    await show("reads");
    expect(section("reads")).toBe(reads);
    expect(reads!.style.display).not.toBe("none");
    expect(mounts.reads, "the revisit mounted News again").toBe(1);
  });

  it("a pile never visited is not mounted", async () => {
    await start();
    await show("reads");
    expect(section("receipts")).toBeNull();
  });
});

describe("each pile fails on its own", () => {
  it("a throw in hidden Receipts leaves the visible News standing, and Receipts mounts fresh later", async () => {
    await start();
    await show("receipts");
    await show("reads");
    broken.receipts = true;
    await show("reads"); // a hidden pile re-renders on its props; this one throws
    expect(section("reads"), "the hidden pile's throw took the visible one down").not.toBeNull();
    expect(section("reads")!.textContent).toBe("the reads pile");
    expect(section("reads")!.style.display).not.toBe("none");
    /* React reports a hidden subtree's error once it is shown: the reveal says this pile failed,
       inside the pile, and leaving it lets the failure go. */
    await show("receipts");
    expect(marker("receipts")!.textContent).toBe("receipts failed");
    await show("reads");
    broken.receipts = false;
    await show("receipts");
    expect(section("receipts"), "the failed pile did not come back").not.toBeNull();
    expect(host!.textContent).not.toContain("receipts failed");
    expect(mounts.receipts, "the failed pile was not mounted fresh").toBe(2);
  });

  it("a pile that failed on screen shows its card, and leaving it clears the failure", async () => {
    await start();
    broken.receipts = true;
    await show("receipts");
    expect(host!.textContent).toContain("receipts failed");
    await show("reads");
    expect(marker("receipts"), "a failed pile was kept after the reader left it").toBeNull();
    broken.receipts = false;
    await show("receipts");
    expect(section("receipts")).not.toBeNull();
    expect(host!.textContent).not.toContain("receipts failed");
  });
});

describe("a hidden pile's DOM is never the shell's answer", () => {
  it("the `d` confirm presses the visible strip, not a hidden pile's earlier in the document", () => {
    document.body.innerHTML = `
      <div data-pile="reads"><section class="view"><div class="abar-delete"><button class="abar-danger" id="hidden">Delete</button></div></section></div>
      <div data-pile="receipts" data-pile-active=""><section class="view"><div class="abar-delete"><button class="abar-danger" id="shown">Delete</button></div></section></div>
      <div class="sheet"><div class="row" data-id="x"></div></div>`;
    const pressed: string[] = [];
    for (const b of document.querySelectorAll("button")) b.addEventListener("click", () => pressed.push(b.id));
    expect(document.querySelector(".abar-delete .abar-danger")!.id, "control: the raw query lands in the hidden pile").toBe("hidden");
    queryVisible<HTMLButtonElement>(".abar-delete .abar-danger")?.click();
    expect(pressed).toEqual(["shown"]);
    expect(queryAllVisible(".view").length).toBe(1);
    expect(queryVisible(".row[data-id]"), "chrome outside the piles is matched as before").not.toBeNull();
    document.body.innerHTML = "";
  });
});
