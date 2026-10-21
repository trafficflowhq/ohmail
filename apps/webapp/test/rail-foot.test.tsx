/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { RailNav } from "@ohmail/ui";
import { DesktopCta } from "../app/shell/AppShell";

/**
 * ═══ THE RAIL'S FOOT HOLDS NO EMPTY BOX (owner report 2026-08-29, bug 3) ════════════════════
 *
 * `RailNav` keeps a `.rail-mail` element — `padding: 14px 8px 0` (`rail.css`) — around ANY
 * truthy `footer`, and `DesktopCta` used to answer its own dismissal by rendering `null` from
 * INSIDE that footer. The two rules compose into a 14px dead band under the Command row on
 * every signed-in browser whose owner dismissed the desktop prompt (a real signed-in account
 * has no `account.email` — that field is a demo fixture — so the prompt was the footer's only
 * content). Measured live on ohmail.app: `.rail-mail` at height 14 with `innerHTML: ""`.
 *
 * The fix is a contract split, and each test pins one half:
 *  · `RailNav` renders `.rail-mail` only for a truthy footer (so `undefined` MEANS no box);
 *  · `DesktopCta` is CONTROLLED — the × reports to `onDismiss` and the component never hides
 *    itself, so the parent that decides the slot exists is the one that knows it will be empty
 *    (`AppShell` holds the persisted flag and hands `footer: undefined` once dismissed).
 *
 * ── MUTATION-WATCHED (2026-08-29) ───────────────────────────────────────────────────────────
 *  · `RailNav`'s `{footer ? <div className="rail-mail">…}` made unconditional → "no box" red.
 *  · A self-hiding `useState` dismissal reinstated inside `DesktopCta` → "stays rendered" red.
 * Each was watched, then the implementation was restored.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) {
    await act(() => r.unmount());
  }
  roots.length = 0;
  document.body.innerHTML = "";
});

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(node);
  });
  return container;
}

describe("the rail's footer box exists only when something is in it", () => {
  it("footer: undefined renders NO .rail-mail — absence is the contract, not an empty padded box", async () => {
    const c = await mount(h(RailNav, { composeLabel: "Compose", mailboxesLabel: "Mailboxes", ariaLabel: "Main", groups: [] }));
    expect(c.querySelector(".rail-mail")).toBeNull();
  });

  it("…and a real footer still gets its box (the control case)", async () => {
    const c = await mount(h(RailNav, { composeLabel: "Compose", mailboxesLabel: "Mailboxes", ariaLabel: "Main", groups: [], footer: h("span", null, "me@example.test") }));
    const box = c.querySelector(".rail-mail");
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain("me@example.test");
  });
});

describe("the notice slot stands under the piles, before the first list group", () => {
  const base = { composeLabel: "Compose", mailboxesLabel: "Mailboxes", ariaLabel: "Main" };
  const places = { label: undefined, items: [{ id: "ohbox", label: "Ohbox" }] };
  const piles = { items: [{ id: "triage-resurface", label: "Resurface" }] };
  const tags = { items: [], tags: { label: "Tags", items: [] } };
  const custom = { items: [], custom: h("div", { className: "folders-probe" }, "Folders") };
  const notice = h("div", { className: "rail-notice" }, "n");
  const foot = { sync: h("span", null, "sync"), dock: h("span", null, "dock") };
  const rgroups = (c: HTMLElement): Element[] => [...c.querySelector("nav")!.children].filter((e) => e.classList.contains("rgroup"));

  it("notice: undefined renders NO slot", async () => {
    const c = await mount(h(RailNav, { ...base, groups: [places, piles, tags, custom], ...foot }));
    expect(c.querySelector(".rail-notice-slot")).toBeNull();
  });

  it("places, piles, then the slot, then the Tags group, then the custom group; no tone class", async () => {
    const c = await mount(h(RailNav, { ...base, groups: [places, piles, tags, custom], notice, ...foot }));
    const slot = c.querySelector(".rail-notice-slot");
    expect(slot, "the notice was not placed in the rail").not.toBeNull();
    const [, pileGroup, tagGroup, customGroup] = rgroups(c);
    expect(slot!.previousElementSibling).toBe(pileGroup);
    expect(slot!.nextElementSibling).toBe(tagGroup);
    expect(tagGroup!.querySelector(".rlabel-toggle")).not.toBeNull();
    expect(tagGroup!.nextElementSibling).toBe(customGroup);
    expect(customGroup!.querySelector(".folders-probe")).not.toBeNull();
    expect(slot!.className, "the slot wears a tone class").toBe("rail-notice-slot");
  });

  it("with no Tags group the slot comes before the first custom group", async () => {
    const c = await mount(h(RailNav, { ...base, groups: [places, piles, custom], notice, ...foot }));
    expect(c.querySelector(".rail-notice-slot")!.nextElementSibling!.querySelector(".folders-probe")).not.toBeNull();
  });

  it("with no list group the slot goes after the last group, before the mailboxes", async () => {
    const c = await mount(h(RailNav, {
      ...base, groups: [places, piles], notice, mailboxes: [{ name: "a@x.example", hint: "imap" }], ...foot,
    }));
    const slot = c.querySelector(".rail-notice-slot")!;
    expect(slot.previousElementSibling).toBe(rgroups(c)[1]);
    expect(slot.nextElementSibling!.querySelector(".mbx"), "the mailboxes group does not follow").not.toBeNull();
  });

  it("a notice arriving does not remount the Tags group", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const groups = [places, piles, tags, custom];
    await act(async () => { root.render(h(RailNav, { ...base, groups, ...foot })); });
    const before = rgroups(container)[2]!;
    await act(async () => { root.render(h(RailNav, { ...base, groups, notice, ...foot })); });
    expect(container.querySelector(".rail-notice-slot")).not.toBeNull();
    expect(rgroups(container)[2], "the Tags group was remounted when the notice came").toBe(before);
    await act(async () => { root.render(h(RailNav, { ...base, groups, ...foot })); });
    expect(rgroups(container)[2], "the Tags group was remounted when the notice left").toBe(before);
  });
});

describe("DesktopCta is controlled — dismissal is the parent's fact", () => {
  it("the × reports to onDismiss and the component does NOT hide itself", async () => {
    const onDismiss = vi.fn();
    const c = await mount(
      h(DesktopCta, { href: "/#download", label: "Get ohmail for desktop", dismissLabel: "Dismiss", onDismiss }),
    );
    const x = c.querySelector<HTMLButtonElement>(".rail-desktop-cta-x");
    expect(x).not.toBeNull();
    await act(async () => {
      x!.click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Still rendered: a self-hiding CTA is exactly the shape that left the empty box behind —
    // the PARENT withdraws the footer (and with it the box), never the child alone.
    expect(c.querySelector(".rail-desktop-cta"), "DesktopCta hid itself — the padded box is back").not.toBeNull();
  });
});
