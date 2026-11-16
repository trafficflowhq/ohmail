/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { FrameNotice } from "../../src/frame/contract.js";
import { NONE, type FeatureEntry, type FeatureName, type None } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/** A feature that says what is true for it now; the test moves it from outside. */
const said: { set: ((next: readonly FrameNotice[]) => void) | null } = { set: null };
function useSays(): readonly FrameNotice[] {
  const [now, set] = useState<readonly FrameNotice[]>([
    { kind: "trial", title: "Trial ends Wed 18 Nov" },
    { kind: "payment", title: "The last payment failed", hot: true },
  ]);
  said.set = set;
  return now;
}
const strip: FeatureEntry = { name: "accountStrip", render: () => null, notice: useSays };

function mount(features: Partial<Record<FeatureName, FeatureEntry | None>>) {
  const made = fakeHost({ engine: NO_ENGINE, service: "managed", scope: "acct-1", features });
  const view = (host = made.host) => (
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>
  );
  const { rerender } = render(view());
  return {
    made,
    again: (next: Partial<Record<FeatureName, FeatureEntry | None>>) =>
      rerender(
        view(
          fakeHost({
            engine: NO_ENGINE,
            service: "managed",
            scope: "acct-1",
            features: next,
            window: made.window,
            address: made.address,
            appearance: made.appearance,
          }).host,
        ),
      ),
  };
}
const standing = () => screen.queryAllByRole("status").map((el) => el.textContent);

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("what a shell's features say in the one notice slot", () => {
  it("stands an entry's two notices in rank order: one in front, the other behind the line", () => {
    mount({ accountStrip: strip });
    expect(standing()).toEqual(["The last payment failed"]);
    expect(screen.getByRole("button", { name: /1 more/ })).toBeTruthy();
  });

  it("follows the entry's own state: a notice that is no longer true leaves", () => {
    mount({ accountStrip: strip });
    act(() => said.set!([{ kind: "trial", title: "Trial ends Wed 18 Nov" }]));
    expect(standing()).toEqual(["Trial ends Wed 18 Nov"]);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
    act(() => said.set!([]));
    expect(standing()).toEqual([]);
  });

  it("takes an entry's notices back when the entry goes", () => {
    const { again } = mount({ accountStrip: strip });
    expect(standing()).toEqual(["The last payment failed"]);
    again({ accountStrip: NONE });
    expect(standing()).toEqual([]);
  });

  it("calls nothing for an entry that has nothing to say", () => {
    mount({ account: { name: "account", render: () => null } });
    expect(standing()).toEqual([]);
  });
});
