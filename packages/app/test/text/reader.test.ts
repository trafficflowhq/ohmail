/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { Fragment, createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TextProvider,
  fillOver,
  useLocale,
  useText,
  type Locale,
  type Messages,
} from "../../src/text/index.js";

/**
 * The one text reader: a namespace's sentences under one provider, German filled over English,
 * and never a key on screen.
 */

const EN: Messages = {
  ohbox: {
    title: "Ohbox",
    count: "{count, plural, one {# letter} other {# letters}}",
    lead: "Read <b>this</b> first",
    none: "Nothing to read",
    empty: { waiting: "Nothing waits" },
  },
  shared: { at: "{when, time, short}" },
};
const DE: Messages = {
  ohbox: { title: "Ohbox", count: "{count, plural, one {# Brief} other {# Briefe}}", none: "", empty: {} },
};

function Line(props: { ns: string; k: string; values?: Record<string, string | number | Date> }): ReactNode {
  const t = useText(props.ns);
  return h("p", null, t(props.k, props.values));
}
const line = (ns: string, k: string, values?: Record<string, string | number | Date>) =>
  h(Line, { ns, k, values });
const all = (...nodes: ReactNode[]) => h(Fragment, null, ...nodes);
const lines = (view: HTMLElement) => [...view.querySelectorAll("p")].map((p) => p.textContent);

function mount(
  node: ReactNode,
  locale: Locale = "en",
  messages: Messages = EN,
  timeZone = "UTC",
): HTMLElement {
  return render(h(TextProvider, { locale, messages, timeZone, children: node })).container;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useText", () => {
  it("reads a sentence of its own namespace, with values and plurals", () => {
    const view = mount(
      all(
        line("ohbox", "title"),
        line("ohbox", "count", { count: 1 }),
        line("ohbox", "count", { count: 3 }),
        line("ohbox", "empty.waiting"),
      ),
    );
    expect(lines(view)).toEqual(["Ohbox", "1 letter", "3 letters", "Nothing waits"]);
  });

  it("renders German filled over English: a German gap is the English sentence, an empty German one too", () => {
    const view = mount(
      all(line("ohbox", "count", { count: 2 }), line("ohbox", "none"), line("ohbox", "empty.waiting")),
      "de",
      fillOver(EN, DE),
    );
    expect(lines(view)).toEqual(["2 Briefe", "Nothing to read", "Nothing waits"]);
  });

  it("never renders a key: a sentence missing in every language is nothing, and it is reported", () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = mount(all(line("ohbox", "nowhere"), line("absent", "title")));
    expect(lines(view)).toEqual(["", ""]);
    expect(view.textContent).not.toMatch(/nowhere|absent|ohbox/);
    expect(report).toHaveBeenCalled();
    expect(String(report.mock.calls[0]?.[0])).toMatch(/MISSING_MESSAGE/);
  });

  it("while the catalogue is still on its way, a namespace the document did not carry is nothing and is not reported", () => {
    // The web's first screen carries a cut of the catalogue; the rest lands after hydration, as for the intl provider.
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const cut = { ohbox: { title: "Ohbox" } };
    const view = render(
      h(TextProvider, {
        locale: "en",
        messages: cut,
        timeZone: "UTC",
        pending: true,
        children: all(line("ohbox", "title"), line("frame", "title")),
      }),
    );
    expect(lines(view.container)).toEqual(["Ohbox", ""]);
    expect(report).not.toHaveBeenCalled();
    // The whole catalogue lands: the sentence is drawn, and a key missing then is reported again.
    view.rerender(
      h(TextProvider, {
        locale: "en",
        messages: { ...cut, frame: { title: "Frame" } },
        timeZone: "UTC",
        children: all(line("ohbox", "title"), line("frame", "title"), line("frame", "gone")),
      }),
    );
    expect(lines(view.container)).toEqual(["Ohbox", "Frame", ""]);
    expect(String(report.mock.calls[0]?.[0])).toMatch(/MISSING_MESSAGE/);
  });

  it("renders a sentence whose value is missing as nothing, never as its pattern", () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = mount(line("ohbox", "count"));
    expect(view.textContent).toBe("");
    expect(report).toHaveBeenCalled();
  });

  it("formats in the provider's time zone", () => {
    const when = new Date(Date.UTC(2026, 10, 14, 12, 5));
    expect(mount(line("shared", "at", { when }), "en", EN, "UTC").textContent).toMatch(/12:05/);
    cleanup();
    expect(mount(line("shared", "at", { when }), "en", EN, "Europe/Zurich").textContent).toMatch(/1:05/);
  });

  it("draws rich sentences and answers whether a key holds a sentence", () => {
    function Rich(): ReactNode {
      const t = useText("ohbox");
      return h(
        "div",
        null,
        h("span", null, t.rich("lead", { b: (chunks: ReactNode) => h("strong", null, chunks) })),
        h("i", null, [t.has("title"), t.has("nowhere"), t.has("empty.waiting"), t.has("empty")].join(",")),
      );
    }
    const view = mount(h(Rich));
    expect(view.querySelector("strong")?.textContent).toBe("this");
    expect(view.querySelector("span")?.textContent).toBe("Read this first");
    expect(view.querySelector("i")?.textContent).toBe("true,false,true,false");
  });

  it("answers has() with false for a namespace the catalogue does not hold", () => {
    function Probe(): ReactNode {
      return h("i", null, String(useText("absent").has("title")));
    }
    expect(mount(h(Probe)).textContent).toBe("false");
  });

  it("reports nothing for a namespace the catalogue does not hold until a sentence of it is asked", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Holds(): ReactNode {
      useText("absent");
      return h("i", null, "held");
    }
    expect(mount(h(Holds)).textContent).toBe("held");
    expect(errors).not.toHaveBeenCalled();
    cleanup();
    expect(mount(line("absent", "title")).textContent).toBe("");
    expect(errors).toHaveBeenCalled();
  });

  it("hands the same reader to every caller of one namespace under one provider", () => {
    const seen: unknown[] = [];
    function Take(): ReactNode {
      seen.push(useText("ohbox"));
      return null;
    }
    mount(all(h(Take, { key: 1 }), h(Take, { key: 2 })));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("refuses to read without a provider, rather than drawing keys or blanks", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(line("ohbox", "title"))).toThrow(/TextProvider/);
  });
});

describe("useLocale", () => {
  it("is the provider's locale", () => {
    function Show(): ReactNode {
      return h("b", null, useLocale());
    }
    expect(mount(h(Show), "de", fillOver(EN, DE)).textContent).toBe("de");
    cleanup();
    expect(mount(h(Show)).textContent).toBe("en");
  });
});

describe("fillOver", () => {
  it("fills deep, keeps German where it has a sentence, and changes neither input", () => {
    const en: Messages = { a: { b: { c: "C", d: "D" }, e: "E" }, f: "F" };
    const de: Messages = { a: { b: { c: "Ce" } }, g: "G" };
    const before = JSON.stringify([en, de]);
    expect(fillOver(en, de)).toEqual({ a: { b: { c: "Ce", d: "D" }, e: "E" }, f: "F", g: "G" });
    expect(JSON.stringify([en, de])).toBe(before);
  });

  it("counts an empty German sentence as absent", () => {
    expect(fillOver({ a: "A" }, { a: "" })).toEqual({ a: "A" });
  });
});
