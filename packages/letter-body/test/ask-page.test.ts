/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { design } from "@ohmail/tokens/design";
import { askPage } from "../src/link-ask";

/**
 * THE ASK PAGE AS DRAWN: a card that names where the link goes, the address as text, and one button that holds the
 * one link there, its arrow drawn in place. The page asks for no file: no picture, no sheet, no typeface, no
 * address in its styles.
 */
const COPY = {
  lang: "en",
  title: "Open this link?",
  elsewhere: "The text of this link names a different site.",
  goes: (host: string) => `It goes to ${host}.`,
  open: (host: string) => `Open ${host}`,
  stay: "To stay, close this tab.",
};
const page = (url: string) => new DOMParser().parseFromString(askPage(url, COPY), "text/html");

describe("the ask page", () => {
  it("its one button carries an arrow drawn in place, and its name is where it opens", () => {
    const doc = page("https://klick.versandbote.example/t/8f2c61a0?o=5521");
    const button = doc.querySelector("a")!;
    expect(button.querySelector("svg path")?.getAttribute("d")).toBeTruthy();
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).toBe("Open klick.versandbote.example");
  });

  it("asks for no file: no picture, no sheet but its own, no address or typeface in its styles", () => {
    const doc = page("https://evil.example/x?a=1");
    expect(doc.querySelectorAll("img, script, iframe, object, embed")).toHaveLength(0);
    expect([...doc.querySelectorAll("link")].map((l) => l.getAttribute("href"))).toEqual(["data:,"]);
    const css = [...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(css).not.toMatch(/url\(|@import|@font-face/);
  });
});

describe("the ask page's colours", () => {
  /** The page's own sheet applied to this document, and what it paints `selector` in. */
  function painted(selector: string): CSSStyleDeclaration {
    const doc = page("https://klick.versandbote.example/t/8f2c61a0?o=5521");
    document.head.innerHTML = doc.head.innerHTML;
    document.body.innerHTML = doc.body.innerHTML;
    return getComputedStyle(document.querySelector(selector)!);
  }

  it("stand on the design's paper face: its ground behind, a sheet for the card, the solid button", () => {
    const paper = design.faces.paper.light;
    const rgb = (hex: string) =>
      `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    expect(painted("body").backgroundColor).toBe(rgb(paper.ground));
    expect(painted("main").backgroundColor).toBe(rgb(paper.sheet));
    expect(painted("a").backgroundColor).toBe(rgb(paper.solid));
    expect(painted("a").color).toBe(rgb(paper["on-solid"]));
  });
});
