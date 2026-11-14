/** @vitest-environment jsdom */
/**
 * A NOTICE's MORE: a notice that hands `more` draws one answer more, its word; a press on it opens the kit's dialog over
 * the app with the notice's sentence, its line and the rows, and its way out closes it again while the notice stands.
 * The dialog follows the notice: new rows are drawn, and a notice that leaves takes its dialog with it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { FrameNotice } from "../../src/frame/contract.js";
import type { FeatureEntry } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { FRAME_WORDS } from "../support/frame-words.js";

let okPressed = 0;
const said: { set: ((next: readonly FrameNotice[]) => void) | null } = { set: null };
const sweeps = (rows: readonly string[]): FrameNotice => ({
  kind: "signInCopies",
  title: "ohmail signed out an older copy of your sign-in",
  line: "If none of that happened, change your password in Settings → Account.",
  acts: [{ label: "OK", onPress: () => void (okPressed += 1) }],
  more: { label: "Details", rows },
});
function useSays(): readonly FrameNotice[] {
  const [now, set] = useState<readonly FrameNotice[]>([sweeps(["ohmail for Linux, Wed 18 Nov 2026, 06:10"])]);
  said.set = set;
  return now;
}
const strip: FeatureEntry = { name: "accountStrip", render: () => null, notice: useSays };

function mount() {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "managed",
    scope: "acct-1",
    features: { accountStrip: strip },
  });
  render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
}
const dialog = () => screen.queryByRole("dialog");
const rows = () => [...(dialog()?.querySelectorAll('[role="listitem"]') ?? [])].map((r) => r.textContent);

beforeEach(() => {
  okPressed = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("a notice's more", () => {
  it("draws its word as the notice's last answer, and the rows stand only behind it", () => {
    mount();
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("change your password");
    const answers = [...notice.querySelectorAll("button")].map((b) => b.textContent);
    expect(answers).toEqual(["OK", "Details"]);
    expect(dialog()).toBeNull();
    expect(screen.queryByText(/ohmail for Linux/)).toBeNull();
  });

  it("opens the kit's dialog with the sentence, the line and every row; its way out closes it and the notice stays", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const box = dialog();
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain("ohmail signed out an older copy of your sign-in");
    expect(box!.textContent).toContain("change your password in Settings → Account");
    expect(rows()).toEqual(["ohmail for Linux, Wed 18 Nov 2026, 06:10"]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog()).toBeNull();
    expect(okPressed).toBe(0);
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });

  it("follows the notice: new rows are drawn, and a notice that leaves takes its dialog with it", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    act(() =>
      said.set!([sweeps(["ohmail for Linux, Wed 18 Nov 2026, 06:10", "A browser, Tue 17 Nov 2026, 22:01"])]),
    );
    expect(rows()).toEqual(["ohmail for Linux, Wed 18 Nov 2026, 06:10", "A browser, Tue 17 Nov 2026, 22:01"]);
    act(() => said.set!([]));
    expect(dialog()).toBeNull();
  });
});
