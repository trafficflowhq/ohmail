/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { Frame } from "../../src/frame/Frame.js";
import { useFrame } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry, StageEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/**
 * A stand-in feature that keeps what a person has not finished: a half-written letter, a send held for its
 * Undo window and a delete waiting for its own. It keeps them in a store partitioned by the scope it reads
 * from the frame it stands in, and it writes once more as it is taken down.
 */
interface Kept {
  letter: string;
  held: string[];
  deletes: string[];
}
const store = new Map<string, Kept>();
const firstEffects: (string | null)[] = [];
const HELD_MS = 5000;

function Writer(_: PaneProps) {
  const { host } = useFrame();
  const scope = host.session.scope ?? "";
  const engine = host.engine as unknown as { send(words: string): void; remove(id: string): void };
  const was = store.get(scope) ?? { letter: "", held: [], deletes: [] };
  const [letter, setLetter] = useState(was.letter);
  const now = useRef(letter);
  now.current = letter;
  const atMount = useRef({ session: host.session.scope, scope, was });
  useEffect(() => {
    const first = atMount.current;
    firstEffects.push(first.session);
    return () => {
      store.set(first.scope, { ...(store.get(first.scope) ?? first.was), letter: now.current });
    };
  }, []);
  const keep = (next: Partial<Kept>) => store.set(scope, { ...(store.get(scope) ?? was), ...next });
  return (
    <div>
      <textarea
        aria-label="Letter"
        value={letter}
        onChange={(e) => (setLetter(e.target.value), keep({ letter: e.target.value }))}
      />
      <button
        type="button"
        onClick={() => {
          const words = now.current;
          keep({ held: [...(store.get(scope)?.held ?? []), words] });
          setTimeout(() => engine.send(words), HELD_MS);
        }}
      >
        Send
      </button>
      <button
        type="button"
        onClick={() => {
          keep({ deletes: [...(store.get(scope)?.deletes ?? []), "m-7"] });
          setTimeout(() => engine.remove("m-7"), HELD_MS);
        }}
      >
        Delete
      </button>
    </div>
  );
}
const write: PlaceEntry = { id: "write", body: "write", rail: null, panes: { kind: "wide", Wide: Writer } };

const engineOf = () => ({ send: vi.fn(), remove: vi.fn() });
const engines = { A: engineOf(), B: engineOf() };
const window = fakeWindow("desktop");
const address = fakeAddress("#/compose");
const hostOf = (scope: "A" | "B") =>
  fakeHost({
    engine: engines[scope] as unknown as OhmailEngine,
    service: "self",
    scope,
    places: { write },
    window,
    address,
  }).host;

function at(scope: "A" | "B") {
  return (
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={hostOf(scope)} />
    </TextProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  firstEffects.length = 0;
  engines.A = engineOf();
  engines.B = engineOf();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a change of scope mounts the frame again", () => {
  it("and nothing of one scope's unfinished work is read, sent or deleted under another", () => {
    const view = render(at("A"));
    fireEvent.change(screen.getByRole("textbox", { name: "Letter" }), {
      target: { value: "Half a letter to Lena" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    view.rerender(at("B"));
    expect((screen.getByRole("textbox", { name: "Letter" }) as HTMLTextAreaElement).value).toBe("");
    expect(firstEffects).toEqual(["A", "B"]);

    act(() => vi.advanceTimersByTime(HELD_MS));
    expect(engines.B.send).not.toHaveBeenCalled();
    expect(engines.B.remove).not.toHaveBeenCalled();
    expect(engines.A.send.mock.calls).toEqual([["Half a letter to Lena"]]);
    expect(engines.A.remove.mock.calls).toEqual([["m-7"]]);
    expect(store.get("A")).toEqual({
      letter: "Half a letter to Lena",
      held: ["Half a letter to Lena"],
      deletes: ["m-7"],
    });
    expect(JSON.stringify(store.get("B") ?? null)).not.toContain("Lena");

    view.rerender(at("A"));
    expect((screen.getByRole("textbox", { name: "Letter" }) as HTMLTextAreaElement).value).toBe(
      "Half a letter to Lena",
    );
  });

  it("writes a scope's last words under that scope as it is taken down, never under the next", () => {
    const view = render(at("A"));
    fireEvent.change(screen.getByRole("textbox", { name: "Letter" }), { target: { value: "Dear Lena" } });
    view.rerender(at("B"));
    view.unmount();
    expect(store.get("A")?.letter).toBe("Dear Lena");
    expect(store.get("B")?.letter ?? "").toBe("");
  });
});

describe("a scope that names nobody mounts nothing", () => {
  let bodies = 0;
  function Body(_: PaneProps) {
    bodies += 1;
    return <p>the place&apos;s body</p>;
  }
  const ohbox: PlaceEntry = {
    id: "ohbox",
    body: "ohbox",
    rail: { group: "main", icon: "ohbox", label: "title" },
    panes: { kind: "wide", Wide: Body },
  };
  const firstRun: StageEntry = { id: "firstRun", Body: () => <p>the stage</p> };
  /** The frame under a scope, at an address: what of a place it draws. */
  function under(scope: string | null, at: string) {
    bodies = 0;
    const host = fakeHost({
      engine: engineOf() as unknown as OhmailEngine,
      service: "self",
      scope,
      places: { ohbox },
      stages: { firstRun },
      window,
      address: fakeAddress(at),
    }).host;
    const view = render(
      <TextProvider
        locale="en"
        messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }}
        timeZone="Europe/Zurich"
      >
        <Frame host={host} />
      </TextProvider>,
    );
    const drawn = {
      body: bodies,
      railEntries: view.container.querySelectorAll("[data-rail-id]").length,
      stage: (view.container.textContent ?? "").includes("the stage"),
      frame: view.container.querySelector(".fr-frame") !== null,
    };
    cleanup();
    return drawn;
  }
  const NOTHING = { body: 0, railEntries: 0, stage: false, frame: false };

  it("refuses no scope, an empty one, the two words keys spell for nobody, and a shape no id has", () => {
    for (const scope of [null, "", "local", "anon", "a:b"]) {
      expect({ place: under(scope, "#/ohbox"), staged: under(scope, "#/first-run") }, String(scope)).toEqual({
        place: NOTHING,
        staged: NOTHING,
      });
    }
  });

  it("mounts under an account's id and under the demo's own word", () => {
    for (const scope of ["acct-1", "demo:fixtures"]) {
      const place = under(scope, "#/ohbox");
      expect({ body: place.body > 0, railEntries: place.railEntries, frame: place.frame }, scope).toEqual({
        body: true,
        railEntries: 1,
        frame: true,
      });
      expect(under(scope, "#/first-run").stage, scope).toBe(true);
    }
  });
});
