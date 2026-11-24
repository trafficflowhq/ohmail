import { expect, it, vi } from "vitest";
import type { WakeSession } from "../src/net/push";
import { answerWakePane } from "../src/shell/wake-pane";
import type { Wake } from "../src/state/wake";
import { pageOver, phone } from "./helpers/notice-phone";

const pairing = (id: string) => ({ profile: { id } }) as WakeSession;
const distributor = { id: "fixture.wake", name: "Wake helper", saved: true };

function fixture(os: "android" | "ios" = "android", app: "ohmail" | "ohcal" = "ohmail") {
  const current = pairing("this-pairing");
  let live = current;
  const choose = vi.fn((_id: string): boolean => true);
  const turnOff = vi.fn();
  const wake: Wake = {
    session: current,
    state: { k: "on", id: "registration-for-the-native-provider" },
    choices: [distributor],
    chosen: distributor.id,
    readDevice: () => ({ choices: wake.choices, chosen: wake.chosen }),
    busy: false,
    choose,
    turnOff,
    want: vi.fn(),
  };
  const { deps } = phone({ app });
  const page = pageOver(deps, undefined, undefined, (ask) => answerWakePane(ask, wake, live, os));
  return {
    page,
    wake,
    choose,
    turnOff,
    switchPairing: () => {
      live = pairing("another-pairing");
    },
  };
}

it("reads only the controls and outcome the page displays", async () => {
  const { page, wake } = fixture();
  expect(await page.request("phone.wake", { do: "read" })).toEqual({
    wake: {
      os: "android",
      state: { k: "on" },
      choices: [{ id: distributor.id, name: distributor.name }],
      chosen: distributor.id,
      busy: false,
    },
  });
  wake.state = { k: "off", reason: "fixture diagnostic detail" };
  expect((await page.request("phone.wake", { do: "read" })).wake?.state).toEqual({
    k: "off",
    reason: "failed",
  });
});

it.each(["row_remains", "endpoint_refused", "switched_off"])(
  "preserves the wake outcome with its own message: %s",
  async (reason) => {
    const { page, wake } = fixture();
    wake.state = { k: "off", reason };
    expect((await page.request("phone.wake", { do: "read" })).wake?.state).toEqual({
      k: "off",
      reason,
    });
  },
);

it("offers no selected distributor when the saved app has been removed", async () => {
  const { page, wake, choose, turnOff } = fixture();
  const another = { id: "fixture.other", name: "Other helper", saved: false };
  wake.choices = [another];

  expect((await page.request("phone.wake", { do: "read" })).wake).toMatchObject({
    choices: [{ id: another.id, name: another.name }],
    chosen: null,
  });
  expect(wake.chosen).toBe(distributor.id);
  expect(choose).not.toHaveBeenCalled();
  expect(turnOff).not.toHaveBeenCalled();
});

it("asks the device provider for one installed choice and to turn it off", async () => {
  const { page, choose, turnOff } = fixture();
  await page.request("phone.wake", { do: "choose", distributor: distributor.id });
  await page.request("phone.wake", { do: "off" });
  expect(choose.mock.calls).toEqual([[distributor.id]]);
  expect(turnOff.mock.calls).toEqual([[]]);
  await expect(
    page.request("phone.wake", { do: "choose", distributor: "other-helper" }),
  ).rejects.toMatchObject({ refused: "notReady" });
  expect(choose).toHaveBeenCalledTimes(1);
  choose.mockReturnValueOnce(false);
  await expect(
    page.request("phone.wake", { do: "choose", distributor: distributor.id }),
  ).rejects.toMatchObject({
    refused: "notReady",
  });
});

it("keeps the controls with their live pairing and waits for a busy provider", async () => {
  const { page, wake, turnOff, switchPairing } = fixture();
  wake.busy = true;
  await expect(page.request("phone.wake", { do: "off" })).rejects.toMatchObject({ refused: "notReady" });
  wake.busy = false;
  switchPairing();
  await expect(page.request("phone.wake", { do: "read" })).rejects.toMatchObject({ refused: "foreignScope" });
  await expect(page.request("phone.wake", { do: "off" })).rejects.toMatchObject({ refused: "foreignScope" });
  expect(turnOff).not.toHaveBeenCalled();
});

it("withholds distributor controls where the phone does not offer them", async () => {
  const { page, turnOff } = fixture("ios");
  expect(await page.request("phone.wake", { do: "read" })).toMatchObject({
    wake: { choices: [], chosen: null },
  });
  await expect(page.request("phone.wake", { do: "off" })).rejects.toMatchObject({ refused: "notReady" });
  expect(turnOff).not.toHaveBeenCalled();
  const calendar = fixture("android", "ohcal");
  await expect(calendar.page.request("phone.wake", { do: "read" })).rejects.toMatchObject({
    refused: "malformed",
  });
});
