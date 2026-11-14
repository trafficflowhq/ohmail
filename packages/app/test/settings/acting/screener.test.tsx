/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapabilities, HostWires } from "../../../src/host/index.js";
import {
  ScreenerPane,
  screenerHasAny,
  screenerOffers,
  screenerStates,
  windowRungs,
  type ScreenerModel,
  type ScreenerOhbox,
} from "../../../src/settings/screener/index.js";
import { fakeHost, NO_ENGINE } from "../../support/fake-host.js";
import { drawn, said } from "./words.js";

afterEach(cleanup);

const seen = (words: string) => (document.body.textContent ?? "").includes(words);
const settle = () => act(async () => {});
const sw = (lang: "en" | "de", key: string) =>
  screen.getByRole("switch", { name: said(lang, "settings", key) });
const isOff = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

const SUGGEST = {
  title: "Suggest for new senders automatically",
  state: "Off.",
  what: "What it does.",
  cost: "What it costs.",
  decides: "It decides nothing.",
  quote: null,
  notice: null,
  turnOn: "Turn on",
  cancel: "Cancel",
  failed: "Could not change it.",
};
const STATES = screenerStates({
  suggest: SUGGEST,
  act: {
    title: "Act on confident suggestions for me",
    description: "Only Screen out and Spam.",
    failed: "No.",
  },
  review: { label: "People you wrote to", body: "Look at them again.", action: "Review" },
  defaultBar: "Keep my Ohbox for real people.",
  world: { from: "Northwind Billing", subject: "Your invoice", bar: "Only people.", holder: "the laptop" },
});
const NOTHING: ScreenerModel = {
  ohbox: null,
  window: null,
  suggest: null,
  ownSuggest: null,
  act: null,
  unsubscribe: null,
  filed: null,
  review: null,
};
const only = (part: Partial<ScreenerModel>): ScreenerModel => ({ ...NOTHING, ...part });
const ohbox = (more: Partial<ScreenerOhbox> = {}): ScreenerOhbox => ({
  ...STATES.rest.model.ohbox!,
  ...more,
});

/** A host with every wire `none` and every capability at its cannot, then the answers a case hands in. */
function host(wires: Partial<HostWires> = {}, capabilities: Partial<HostCapabilities> = {}) {
  const made = fakeHost({ engine: NO_ENGINE, service: "managed", scope: "acct-1" }).host;
  return { wires: { ...made.wires, ...wires }, capabilities: { ...made.capabilities, ...capabilities } };
}
const A_WIRE = {} as never;

describe("which of the Screener's controls a host offers", () => {
  it("offers nothing where every wire is none", () => {
    expect(screenerOffers(host())).toEqual({
      ohbox: false,
      window: false,
      suggest: null,
      unsubscribe: null,
      filed: false,
      review: false,
    });
  });

  it("withholds each control where its own wire is none, and only that one", () => {
    expect(screenerOffers(host({ screening: A_WIRE }))).toMatchObject({
      ohbox: true,
      filed: false,
      window: false,
    });
    expect(screenerOffers(host({ autoFiled: A_WIRE }))).toMatchObject({ ohbox: false, filed: true });
    expect(screenerOffers(host({ seedReview: A_WIRE }))).toMatchObject({ review: true, window: false });
    expect(screenerOffers(host({ consent: A_WIRE }))).toMatchObject({
      window: true,
      suggest: null,
      unsubscribe: null,
    });
  });

  it("draws the priced suggestion only with its wire and the consent row it writes", () => {
    expect(screenerOffers(host({ suggest: A_WIRE }, { suggest: "priced" })).suggest).toBeNull();
    expect(screenerOffers(host({ suggest: A_WIRE, consent: A_WIRE }, { suggest: "priced" })).suggest).toBe(
      "priced",
    );
    expect(screenerOffers(host({ consent: A_WIRE }, { suggest: "priced" })).suggest).toBeNull();
    expect(screenerOffers(host({ ownModelAutoSuggest: A_WIRE }, { suggest: "ownModel" })).suggest).toBe(
      "ownModel",
    );
    expect(screenerOffers(host({ ownModelAutoSuggest: A_WIRE }, { suggest: "priced" })).suggest).toBeNull();
  });

  it("unsubscribes only where a machine sends the request, and names whose", () => {
    expect(screenerOffers(host({ consent: A_WIRE }, { unsubscribeFrom: "computer" })).unsubscribe).toBe(
      "computer",
    );
    expect(screenerOffers(host({}, { unsubscribeFrom: "service" })).unsubscribe).toBeNull();
  });
});

describe("the Screener pane", () => {
  it("draws nothing at all from a model that holds nothing", () => {
    const { container } = drawn(<ScreenerPane model={NOTHING} />);
    expect(screenerHasAny(NOTHING)).toBe(false);
    expect(container.textContent).toBe("");
  });

  it("draws a part only where the model holds it", () => {
    drawn(<ScreenerPane model={only({ window: STATES.rest.model.window })} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("group", { name: said("en", "settings", "dormancy.title") })).toBeTruthy();
  });
});

describe("what reaches the Ohbox", () => {
  it("writes the posture, holds the switches while it writes, and says Saved where it was written here", async () => {
    let answer!: (travelled: boolean) => void;
    const change = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    drawn(<ScreenerPane model={only({ ohbox: ohbox({ change }) })} />);
    fireEvent.click(sw("en", "screening.postureTitle"));
    expect(change.mock.calls).toEqual([[{ relevant: false }]]);
    expect(isOff(sw("en", "screening.impersonationTitle"))).toBe(true);
    await act(async () => answer(false));
    expect(seen(said("en", "settings", "screening.saved"))).toBe(true);
  });

  it("says no Saved for a change that travelled, and the change on its way from the model", async () => {
    drawn(
      <ScreenerPane
        model={only({ ohbox: ohbox({ change: () => Promise.resolve(true), note: { kind: "asked" } }) })}
      />,
    );
    fireEvent.click(sw("en", "screening.impersonationTitle"));
    await settle();
    expect(seen(said("en", "settings", "screening.saved"))).toBe(false);
    expect(seen(said("en", "settings", "screening.asked"))).toBe(true);
  });

  it("says a refused switch under the switches, and a holder's refusal on the sheet", async () => {
    drawn(
      <ScreenerPane
        model={only({
          ohbox: ohbox({
            change: () => Promise.reject(new Error("refused")),
            note: { kind: "refused", holder: "the laptop", refusal: "other" },
          }),
        })}
      />,
    );
    expect(seen(said("en", "settingsScreener", "notApplied"))).toBe(true);
    expect(seen(said("en", "settings", "screening.refusedOther").replace("{name}", "the laptop"))).toBe(true);
    fireEvent.click(sw("en", "screening.postureTitle"));
    await settle();
    expect(seen(said("en", "settings", "screening.failed"))).toBe(true);
  });

  it("draws no impersonation switch for an older server that files none", () => {
    drawn(<ScreenerPane model={only({ ohbox: ohbox({ impersonation: null }) })} />);
    expect(
      screen.queryByRole("switch", { name: said("en", "settings", "screening.impersonationTitle") }),
    ).toBeNull();
  });

  it("saves written words trimmed, the default as nothing stored, and offers the default only once words are stored", async () => {
    const saveBar = vi.fn((bar: string | null) => Promise.resolve({ bar, travelled: false }));
    drawn(<ScreenerPane model={only({ ohbox: ohbox({ saveBar }) })} />);
    const save = screen.getByRole("button", { name: said("en", "settings", "screening.save") });
    expect(isOff(save)).toBe(true);
    expect(screen.queryByRole("button", { name: said("en", "settings", "screening.reset") })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: said("en", "settings", "screening.barLabel") }), {
      target: { value: "  Only people.  " },
    });
    fireEvent.click(save);
    await settle();
    expect(saveBar.mock.calls).toEqual([["Only people."]]);
    fireEvent.click(screen.getByRole("button", { name: said("en", "settings", "screening.reset") }));
    await settle();
    expect(saveBar.mock.calls.at(-1)).toEqual([null]);
  });

  it("shows the server's default in English and the catalogue's translation of it in German", () => {
    drawn(<ScreenerPane model={only({ ohbox: ohbox() })} />);
    const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box().value).toBe("Keep my Ohbox for real people.");
    cleanup();
    drawn(<ScreenerPane model={only({ ohbox: ohbox() })} />, "de");
    expect(box().value).toBe(said("de", "settings", "screening.defaultBar"));
  });

  it("says a refused save of the words under the field", async () => {
    drawn(
      <ScreenerPane
        model={only({
          ohbox: ohbox({ bar: "Only people.", saveBar: () => Promise.reject(new Error("no")) }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: said("en", "settings", "screening.reset") }));
    await settle();
    expect(seen(said("en", "settings", "screening.failed"))).toBe(true);
  });
});

describe("how far back the Screener asks", () => {
  it("lists the presets, the default and the stored value once each, in order", () => {
    expect(windowRungs(120, 90)).toEqual([90, 120, 180, 365]);
    expect(windowRungs(90, 90)).toEqual([90, 180, 365]);
  });

  it("writes a number of days in the window, and All time as its own scope", async () => {
    const set = vi.fn(() => Promise.resolve());
    drawn(<ScreenerPane model={only({ window: { ...STATES.rest.model.window!, set } })} />);
    fireEvent.click(screen.getByRole("button", { name: "180" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: said("en", "settings", "dormancy.allTime") }));
    await settle();
    expect(set.mock.calls).toEqual([
      [180, "window"],
      [undefined, "all_time"],
    ]);
    expect(seen(said("en", "settings", "dormancy.microcopy"))).toBe(true);
  });
});

describe("the suggestions, acting on them, and unsubscribing", () => {
  it("opens the priced confirm on On and writes nothing until the price is known and accepted", async () => {
    const open = vi.fn();
    const set = vi.fn(() => Promise.resolve());
    const cancel = vi.fn();
    const suggest = { ...STATES.rest.model.suggest!, open, set, cancel };
    drawn(<ScreenerPane model={only({ suggest })} />);
    fireEvent.click(screen.getByRole("switch", { name: SUGGEST.title }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    cleanup();
    drawn(<ScreenerPane model={only({ suggest: { ...suggest, phase: "pricing" } })} />);
    expect(isOff(screen.getByRole("button", { name: SUGGEST.turnOn }))).toBe(true);
    cleanup();
    drawn(<ScreenerPane model={only({ suggest: { ...suggest, phase: "ready", priced: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: SUGGEST.turnOn }));
    await settle();
    expect(set.mock.calls).toEqual([[true]]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("turns off at once, with no confirm between a person and the brake", async () => {
    const set = vi.fn(() => Promise.resolve());
    const open = vi.fn();
    drawn(<ScreenerPane model={only({ suggest: { ...STATES.rest.model.suggest!, on: true, set, open } })} />);
    fireEvent.click(screen.getByRole("switch", { name: SUGGEST.title }));
    await settle();
    expect(set.mock.calls).toEqual([[false]]);
    expect(open).not.toHaveBeenCalled();
  });

  it("holds acting on suggestions where suggestions are off or this install only reads", () => {
    const set = vi.fn(() => Promise.resolve());
    drawn(<ScreenerPane model={only({ act: { ...STATES.rest.model.act!, set, why: "reader" } })} />);
    fireEvent.click(screen.getByRole("switch", { name: "Act on confident suggestions for me" }));
    expect(set).not.toHaveBeenCalled();
  });

  it("writes the stored block the other way round, and says whose machine sends", async () => {
    const setBlocked = vi.fn(() => Promise.resolve());
    drawn(<ScreenerPane model={only({ unsubscribe: { on: true, from: "computer", setBlocked } })} />);
    fireEvent.click(sw("en", "autoUnsub.title"));
    await settle();
    expect(setBlocked.mock.calls).toEqual([[true]]);
    expect(seen(said("en", "settings", "autoUnsub.microcopyComputer"))).toBe(true);
  });
});

describe("what was filed automatically", () => {
  it("lists the letters behind Review and puts one back, saying how many went back", async () => {
    const putBack = vi.fn(() => Promise.resolve({ back: 1, requested: 0 }));
    drawn(<ScreenerPane model={only({ filed: { ...STATES.rest.model.filed!, putBack } })} />);
    expect(
      screen.queryByRole("button", { name: said("en", "settings", "screening.autoFiledPutBack") }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: said("en", "settings", "screening.autoFiledReview") }),
    );
    expect(seen("Northwind Billing · Your invoice · in Spam")).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: said("en", "settings", "screening.autoFiledPutBack") }),
    );
    await settle();
    expect(putBack.mock.calls).toEqual([[["m1"]]]);
    expect(seen("1 message goes back to your Screener")).toBe(true);
  });

  it("says a request sent to the install that organizes, and a refused one", async () => {
    let answer: Promise<{ back: number; requested: number }> = Promise.resolve({ back: 0, requested: 1 });
    drawn(<ScreenerPane model={only({ filed: { ...STATES.rest.model.filed!, putBack: () => answer } })} />);
    fireEvent.click(
      screen.getByRole("button", { name: said("en", "settings", "screening.autoFiledReview") }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Put back all/ }));
    await settle();
    expect(seen(said("en", "settings", "screening.autoFiledRequested"))).toBe(true);
    answer = Promise.reject(new Error("no"));
    fireEvent.click(screen.getByRole("button", { name: /Put back all/ }));
    await settle();
    expect(seen(said("en", "settings", "screening.autoFiledFailed"))).toBe(true);
  });
});

describe("the door back to the review", () => {
  it("opens the review with one press", () => {
    const open = vi.fn();
    drawn(<ScreenerPane model={only({ review: { ...STATES.rest.model.review!, open } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("the registered states", () => {
  it("carry the design's addresses for the pane at rest and where a change went", () => {
    expect(STATES.rest.address).toBe("screen=settings&sec=screener");
    expect(STATES.nottaken.model.ohbox?.note).toMatchObject({ kind: "refused", refusal: "other" });
    expect(STATES.noScreening.model.ohbox).toBeNull();
  });
});
