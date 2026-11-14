/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useWayOut } from "../../../src/account/way-out/use-way-out.js";
import {
  WAY_OUT_START,
  wayOutStep,
  type WayOutDoor,
  type WayOutSection,
} from "../../../src/account/way-out/model.js";
import { WAY_OUT_STATES } from "../../../src/account/way-out/states.js";
import { WayOutPane } from "../../../src/account/way-out/WayOutPane.js";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import settingsDe from "../../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../../messages/settings.en.json" with { type: "json" };
/* The states the comparison registers, by address. */
import registry from "../../../../../test/compare/registry.json" with { type: "json" };
import { fakeWayOutDoor } from "./fake-door.js";

afterEach(cleanup);

const WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: settingsEn,
  de: fillOver(settingsEn, settingsDe),
};
/** A sentence of `settings` by its key: a case names a sentence by its key, never by its words. */
const said = (key: string, lang: "en" | "de" = "en"): string => {
  const at = (WORDS[lang].settings as Record<string, unknown>)[key];
  if (typeof at !== "string") throw new Error(`no sentence settings.${key} in ${lang}`);
  return at;
};
const seen = (words: string): boolean => (document.body.textContent ?? "").includes(words);

function drawn(node: ReactNode, lang: "en" | "de" = "en") {
  return render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      {node}
    </TextProvider>,
  );
}

/** The card over a door, as a shell mounts it. */
function Card({ door, section }: { door: WayOutDoor; section: WayOutSection }) {
  return <WayOutPane model={useWayOut(door, section)} />;
}
const theVerb = (lang: "en" | "de" = "en") => screen.getByRole("button", { name: said("webOpen", lang) });
/** A press, and the door's answer to it taken in. */
const press = async () => {
  await act(async () => {
    fireEvent.click(theVerb());
  });
};

const SAYS: Readonly<Record<WayOutSection, readonly string[]>> = {
  devices: ["webDevicesTitle", "webDevicesWhy", "webDevicesNote"],
  security: ["webSecurityTitle", "webSecurityWhy"],
  account: ["webAccountTitle", "webAccountWhy", "webAccountNote"],
};

describe("the card's rule", () => {
  it("says no browser from a press that started none until a press starts one", () => {
    expect(WAY_OUT_START.noBrowser).toBe(false);
    const failed = wayOutStep(WAY_OUT_START, { kind: "answered", opened: false });
    expect(failed.noBrowser).toBe(true);
    expect(wayOutStep(failed, { kind: "answered", opened: false }).noBrowser).toBe(true);
    expect(wayOutStep(failed, { kind: "answered", opened: true }).noBrowser).toBe(false);
  });
});

describe("the card", () => {
  for (const section of ["devices", "security", "account"] as const) {
    it(`${section}: says what is handled in the browser and why, and offers the one verb`, () => {
      drawn(<WayOutPane model={WAY_OUT_STATES[section].model} />);
      expect(screen.getByRole("heading", { name: said(SAYS[section][0]!) })).toBeTruthy();
      for (const key of SAYS[section]) expect(seen(said(key)), key).toBe(true);
      expect(theVerb()).toBeTruthy();
      expect(seen(said("webNoBrowser"))).toBe(false);
    });
  }

  it("says another section's sentences on no card", () => {
    drawn(<WayOutPane model={WAY_OUT_STATES.security.model} />);
    for (const key of [...SAYS.devices, ...SAYS.account]) expect(seen(said(key)), key).toBe(false);
  });

  it("says where the page is when this computer started no browser, and keeps the verb", () => {
    drawn(<WayOutPane model={WAY_OUT_STATES.devicesNoBrowser.model} />);
    expect(seen(said("webNoBrowser"))).toBe(true);
    expect(theVerb()).toBeTruthy();
  });

  it("reads German where the catalogue is German", () => {
    drawn(<WayOutPane model={WAY_OUT_STATES.accountNoBrowser.model} />, "de");
    expect(screen.getByRole("heading", { name: said("webAccountTitle", "de") })).toBeTruthy();
    expect(seen(said("webNoBrowser", "de"))).toBe(true);
    expect(theVerb("de")).toBeTruthy();
  });

  it("holds no form, no named control, no link, no handler written into the page and no test id", () => {
    const { container } = drawn(<WayOutPane model={WAY_OUT_STATES.devicesNoBrowser.model} />);
    expect(container.querySelectorAll("form, input, a[href], [name], [data-testid]")).toHaveLength(0);
    const written = [...container.querySelectorAll("*")].flatMap((el) =>
      el.getAttributeNames().filter((name) => name.startsWith("on")),
    );
    expect(written).toEqual([]);
  });
});

describe("the card over its door", () => {
  it("opens nothing by being drawn, and one browser per press", async () => {
    const door = fakeWayOutDoor([true, true]);
    drawn(<Card door={door} section="security" />);
    expect(door.opens()).toBe(0);
    await press();
    expect(door.opens()).toBe(1);
    expect(seen(said("webNoBrowser"))).toBe(false);
    await press();
    expect(door.opens()).toBe(2);
  });

  it("says no browser when the press started none, and takes it back when the next press starts one", async () => {
    const door = fakeWayOutDoor([false, true]);
    drawn(<Card door={door} section="devices" />);
    await press();
    expect(seen(said("webNoBrowser"))).toBe(true);
    await press();
    expect(seen(said("webNoBrowser"))).toBe(false);
    expect(door.opens()).toBe(2);
  });

  it("works the same where the tree is mounted twice over", async () => {
    const door = fakeWayOutDoor([false]);
    drawn(
      <StrictMode>
        <Card door={door} section="account" />
      </StrictMode>,
    );
    expect(door.opens()).toBe(0);
    await press();
    expect(door.opens()).toBe(1);
    expect(seen(said("webNoBrowser"))).toBe(true);
  });

  it("an answer that lands after the card was left changes nothing and throws nothing", async () => {
    let answer: (opened: boolean) => void = () => {};
    const door: WayOutDoor = {
      open: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    };
    const { unmount } = drawn(<Card door={door} section="account" />);
    fireEvent.click(theVerb());
    unmount();
    await act(async () => {
      answer(false);
    });
    expect(seen(said("webNoBrowser"))).toBe(false);
  });
});

describe("the card's states", () => {
  const registered = new Set((registry as { states: { key: string }[] }).states.map((state) => state.key));
  const addresses = Object.values(WAY_OUT_STATES).flatMap((state) =>
    state.address === null ? [] : [state.address],
  );

  it("each address is a state the comparison registers, once", () => {
    expect(addresses.filter((address) => !registered.has(address))).toEqual([]);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("cover every picture of the card: Devices with and without a browser, Security, Account", () => {
    const pictured = [...registered].filter((key) =>
      /^door=cloud&screen=settings&sec=(devices|security|account)(&|$)/.test(key),
    );
    expect([...addresses].sort()).toEqual(pictured.sort());
  });

  it("each state says no browser exactly where its picture does", () => {
    for (const [name, state] of Object.entries(WAY_OUT_STATES))
      expect(state.model.noBrowser, name).toBe(name.endsWith("NoBrowser"));
  });
});
