/** @vitest-environment jsdom */
/**
 * ── THE READING OVERLAY HAS AN ON-SCREEN WAY OUT, AND AN OPAQUE GROUND, AT PHONE WIDTH ───
 *
 * Two findings from one 390×844 walk of the live product, both themes:
 *
 *   · The overlay's only LABELLED exit was "esc · to return" — a keyboard affordance on a
 *     toast that fades out after 3.6s and cannot be tapped. Backdrop tap worked but nothing
 *     said so; browser-back worked but nothing said so. `touch-keys.css` already suppresses
 *     the esc hint on coarse pointers, which — correct in itself — left the overlay with NO
 *     visible exit at all. So the Reader now renders a real close button, always in the DOM
 *     (a keyboard user may want it too), displayed by the stylesheet at overlay widths.
 *
 *   · The list BEHIND the overlay ghosted through the seams between message panels — the
 *     `.reader` element painted no ground of its own, so `body.reading .shell`'s faint residue
 *     showed in every gap and read as a rendering glitch. Below 700px the overlay is the whole
 *     viewport and the recede is invisible behind it anyway, so the overlay now paints an
 *     opaque `--canvas` ground there. From 700px the webapp already zeroes the shell
 *     (`body.reading div.shell{opacity:0}`, app.css) and the desktop exhale is untouched.
 *
 * jsdom applies no author styles, so the button's BEHAVIOUR is asserted on the render and
 * the width gating on the stylesheet's declarations — the same split every structural-CSS
 * suite in this repo uses. All of it was watched red against the pre-fix Reader.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Reader } from "@ohmail/ui";

afterEach(() => {
  cleanup();
  document.body.classList.remove("reading");
});

const CSS = readFileSync(
  resolve(process.cwd(), "packages/ui/src/composites/reader.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of one @media block, located by a predicate over its condition. */
function mediaBlock(cond: (c: string) => boolean): string {
  let i = 0;
  while ((i = CSS.indexOf("@media", i)) !== -1) {
    const open = CSS.indexOf("{", i);
    const condition = CSS.slice(i + "@media".length, open);
    let depth = 1;
    let j = open + 1;
    while (j < CSS.length && depth > 0) {
      if (CSS[j] === "{") depth += 1;
      else if (CSS[j] === "}") depth -= 1;
      j += 1;
    }
    if (cond(condition)) return CSS.slice(open + 1, j - 1);
    i = j;
  }
  return "";
}

const ruleOf = (css: string, selector: string): string => {
  const re = new RegExp(
    `(^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`,
  );
  const m = re.exec(css);
  return m ? m[2]! : "";
};
const decl = (rule: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(rule);
  return m ? m[1]!.trim() : null;
};

describe("the Reader's close control", () => {
  it("renders a real button with an accessible name, and pressing it closes", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Reader returnHint="to return" ariaLabel="Reading" open onClose={onClose} closeLabel="Back">
        <article className="msg">hello</article>
      </Reader>,
    );
    const button = container.querySelector<HTMLButtonElement>("button.reader-close");
    expect(button, "no on-screen exit — the overlay's only way out is invisible again").not.toBeNull();
    expect(button!.getAttribute("aria-label")).toBe("Back");
    expect(button!.getAttribute("type"), "an unlabelled type submits forms it lands in").toBe("button");
    fireEvent.click(button!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pressing the close button is not a backdrop click — one close, not two paths at once", () => {
    // The backdrop handler closes on `target === currentTarget`; the button is a child, so
    // its click must reach `onClose` through its OWN handler exactly once.
    const onClose = vi.fn();
    const { container } = render(
      <Reader returnHint="to return" ariaLabel="Reading" closeLabel="Back" open onClose={onClose}>
        <article className="msg">hello</article>
      </Reader>,
    );
    fireEvent.click(container.querySelector("button.reader-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * THE DEFAULT IS GONE, AND THAT IS THE POINT.
   *
   * This case used to mount `Reader` bare and assert that `closeLabel` defaulted to something —
   * which it did, to the English word "Back", in every locale. The accessible name of an
   * icon-only button is exactly the kind of string nobody sees is untranslated. `closeLabel` is
   * now required, so a bare mount does not compile; what is left to guard is that the word the
   * host hands in is the word the button wears.
   */
  it("the close button wears the host's word — there is no default to fall back on", () => {
    const { container } = render(
      <Reader
        returnHint="zum Zurückgehen"
        ariaLabel="Geöffnete Nachricht"
        closeLabel="Zurück"
        open
        onClose={() => {}}
      >
        <article className="msg">hello</article>
      </Reader>,
    );
    const close = container.querySelector("button.reader-close")!;
    expect(close.getAttribute("aria-label")).toBe("Zurück");
    expect(container.querySelector(".reader")!.getAttribute("aria-label")).toBe("Geöffnete Nachricht");
  });
});

describe("the stylesheet gates the affordance and the ground to overlay widths", () => {
  const overlay = mediaBlock((c) => /max-width:\s*699\.98px/.test(c));

  it("there is a <700px block, and it paints the overlay opaque", () => {
    expect(overlay, "reader.css has no <700px block — nothing distinguishes the phone overlay").not.toBe("");
    const bg = decl(ruleOf(overlay, ".reader"), "background");
    expect(bg, "the overlay paints no ground — the dimmed list ghosts through the panel seams")
      .not.toBeNull();
    expect(bg!, "the ground must be the app's own canvas token, themed in both modes")
      .toContain("var(--canvas)");
  });

  it("the close control is displayed at overlay widths and hidden above them", () => {
    // Base: hidden — the desktop exhale keeps its chrome-free reading surface.
    expect(decl(ruleOf(CSS, ".reader-close"), "display"),
      "the button paints on desktop, where esc and the backdrop already say the way out").toBe("none");
    // <700px: a real, visible, fixed control.
    const shown = ruleOf(overlay, ".reader-close");
    expect(shown, "no <700px rule for .reader-close — the phone overlay has no visible exit").not.toBe("");
    expect(decl(shown, "display")).not.toBe("none");
    expect(decl(shown, "position"), "the exit must stay on screen while the thread scrolls").toBe("fixed");
  });
});

describe("the reading mark on <body> holds while the sheet stays open", () => {
  // The shell re-renders on every keystroke in the reply editor and hands a fresh `onClose`
  // each time; dropping and re-adding `reading` restarted the rail's and the shell's opacity
  // transitions, so the window flickered while the person typed.
  it("a re-render with a new onClose never takes the class off", () => {
    const sheet = (onClose: () => void) => (
      <Reader returnHint="to return" ariaLabel="Reading" closeLabel="Back" open onClose={onClose}>
        <article className="msg">hello</article>
      </Reader>
    );
    const { rerender } = render(sheet(() => {}));
    expect(document.body.classList.contains("reading")).toBe(true);
    const watch = new MutationObserver(() => {});
    watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    for (let i = 0; i < 3; i += 1) rerender(sheet(() => {}));
    const churn = watch.takeRecords();
    watch.disconnect();
    expect(churn, "the reading class was dropped and re-added on a re-render").toHaveLength(0);
    expect(document.body.classList.contains("reading")).toBe(true);
  });

  it("Escape closes through the latest onClose, and closing takes the class off", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const sheet = (open: boolean, onClose: () => void) => (
      <Reader returnHint="to return" ariaLabel="Reading" closeLabel="Back" open={open} onClose={onClose}>
        <article className="msg">hello</article>
      </Reader>
    );
    const { rerender } = render(sheet(true, first));
    rerender(sheet(true, latest));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    rerender(sheet(false, latest));
    expect(document.body.classList.contains("reading")).toBe(false);
  });
});
