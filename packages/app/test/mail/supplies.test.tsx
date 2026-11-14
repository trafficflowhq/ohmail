/** @vitest-environment jsdom */
/**
 * WHAT EVERY BROWSER HOST HANDS THE FRAME FOR MAIL (`useMailSupplies` of the mail entry): each mail place that is
 * seated on the ground and `none` for every other, the ground above the panes, the address and the facts of the
 * window the host names, the look the host stands under, and the host's way back. One record for the mount.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLACE_IDS, STAGE_IDS } from "../../src/frame/contract.js";
import { NONE, type Appearance, type HostSession } from "../../src/host/index.js";
import {
  MailGround,
  mailPlaces,
  mailReader,
  useMailSupplies,
  type MailHostParts,
  NO_PANE_PARTS,
} from "../../src/mail/index.js";

const PAPER: Appearance = { face: "paper", scheme: "light" };
/** A host that has no part of its own says so, part by part: no reader, nothing for a stage, no section's door. */
const NO_PARTS: MailHostParts = {
  reader: NONE,
  stageParts: { firstRun: { factor: NONE, pair: NONE, aiProvider: NONE, calendar: NONE } },
  paneParts: NO_PANE_PARTS,
};

beforeEach(() => {
  window.location.hash = "#/ohbox";
});
afterEach(cleanup);

describe("what a browser host hands the frame for mail", () => {
  it("names every place and every stage: a seated place by its own entry, each other one `none`, the ground above", () => {
    const { result } = renderHook(() => useMailSupplies(window, PAPER, NONE, NO_PARTS));
    const { places, stages, above } = result.current;
    expect(Object.keys(places).sort()).toEqual([...PLACE_IDS].sort());
    for (const id of PLACE_IDS) expect(places[id], id).toBe(mailPlaces()[id] ?? NONE);
    expect(Object.keys(stages).sort()).toEqual([...STAGE_IDS].sort());
    expect(above).toBe(MailGround);
  });

  it("hands the first run as the mail's own stage, made once for the mount", () => {
    const { result, rerender } = renderHook(({ look }) => useMailSupplies(window, look, NONE, NO_PARTS), {
      initialProps: { look: PAPER },
    });
    const first = result.current.stages.firstRun;
    expect(first).not.toBe(NONE);
    expect(first === NONE ? null : first.id).toBe("firstRun");
    /* A draw, and a look that changed: the entry stays, so the stage's body is never mounted again by a draw. */
    rerender({ look: { face: "ohmarchy", scheme: "dark" } });
    expect(result.current.stages.firstRun).toBe(first);
  });

  it("is one record for the mount: a draw with nothing changed hands the frame the same supplies", () => {
    const { result, rerender } = renderHook(({ look }) => useMailSupplies(window, look, NONE, NO_PARTS), {
      initialProps: { look: PAPER },
    });
    const first = result.current;
    rerender({ look: { face: "paper", scheme: "light" } });
    expect(result.current).toBe(first);
  });

  it("the look follows the host's without a new record: the signal is told, the address and the window stay", () => {
    const { result, rerender } = renderHook(({ look }) => useMailSupplies(window, look, NONE, NO_PARTS), {
      initialProps: { look: PAPER },
    });
    const first = result.current;
    expect(first.appearance.read()).toEqual(PAPER);
    let told = 0;
    const stop = first.appearance.subscribe(() => {
      told += 1;
    });
    rerender({ look: { face: "ohmarchy", scheme: "dark" } });
    expect(result.current).toBe(first);
    expect(first.appearance.read()).toEqual({ face: "ohmarchy", scheme: "dark" });
    expect(told).toBe(1);
    stop();
  });

  it("the address is the window's own fragment, read and written", () => {
    const { result } = renderHook(() => useMailSupplies(window, PAPER, NONE, NO_PARTS));
    expect(result.current.address.read()).toBe("#/ohbox");
    result.current.address.write("#/reads", "push");
    expect(window.location.hash).toBe("#/reads");
    expect(result.current.window.read().width).toBe(window.innerWidth);
  });

  it("the way back is the host's own; another one is a new record over the same address and window", () => {
    const back: HostSession["recover"] = () => undefined;
    const { result, rerender } = renderHook(
      ({ recover }) => useMailSupplies(window, PAPER, recover, NO_PARTS),
      {
        initialProps: { recover: NONE as HostSession["recover"] },
      },
    );
    const first = result.current;
    expect(first.recover).toBe(NONE);
    rerender({ recover: back });
    expect(result.current.recover).toBe(back);
    expect(result.current.address).toBe(first.address);
    expect(result.current.window).toBe(first.window);
    expect(result.current.appearance).toBe(first.appearance);
  });

  it("hands the host's reader as it is, the same one in every record; a host with none hands none", () => {
    const reader = mailReader({ body: () => null, look: NONE });
    const own: MailHostParts = { ...NO_PARTS, reader };
    const { result, rerender } = renderHook(({ recover }) => useMailSupplies(window, PAPER, recover, own), {
      initialProps: { recover: NONE as HostSession["recover"] },
    });
    expect(result.current.reader).toBe(reader);
    rerender({ recover: () => undefined });
    expect(result.current.reader).toBe(reader);
    expect(renderHook(() => useMailSupplies(window, PAPER, NONE, NO_PARTS)).result.current.reader).toBe(NONE);
  });

  it("hands Settings where the host hands a section's door, in the rail with its chord; where it hands none, no Settings", () => {
    const door = {
      who: async () => ({ ok: false as const, word: "signed_out" as const }),
      signOut: async () => "left" as const,
      toErase: () => undefined,
      toSignIn: () => undefined,
    };
    const own: MailHostParts = {
      ...NO_PARTS,
      paneParts: { ...NO_PANE_PARTS, account: { useDoor: () => door, password: NONE } },
    };
    const { result, rerender } = renderHook(({ look }) => useMailSupplies(window, look, NONE, own), {
      initialProps: { look: PAPER },
    });
    const settings = result.current.places.settings;
    expect(settings).not.toBe(NONE);
    expect(settings === NONE ? null : settings.rail?.keyHint).toBe("g ,");
    /* A draw: the place stays, so no section is mounted again by one. */
    rerender({ look: { face: "ohmarchy", scheme: "dark" } });
    expect(result.current.places.settings).toBe(settings);
    expect(
      renderHook(() => useMailSupplies(window, PAPER, NONE, NO_PARTS)).result.current.places.settings,
    ).toBe(NONE);
  });

  it("the host's own parts are one record, read at the mount: a record named again by a draw makes nothing again", () => {
    const reader = mailReader({ body: () => null, look: NONE });
    const { result, rerender } = renderHook(({ own }) => useMailSupplies(window, PAPER, NONE, own), {
      initialProps: { own: { ...NO_PARTS, reader } as MailHostParts },
    });
    const first = result.current;
    rerender({ own: { ...NO_PARTS, reader: mailReader({ body: () => null, look: NONE }) } });
    expect(result.current).toBe(first);
    expect(result.current.reader).toBe(reader);
    expect(result.current.stages.firstRun).toBe(first.stages.firstRun);
  });
});
