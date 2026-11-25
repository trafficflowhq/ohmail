/** @vitest-environment jsdom */
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { design } from "@ohmail/tokens/design";
import { mount, styleOf } from "./_rendered-dom";

const scene = vi.hoisted(() => ({
  session: {} as unknown,
  answer: Promise.resolve() as Promise<void>,
  scheme: "light" as "light" | "dark",
  mirror: { syncFolder: "Archive in progress", unsaved: 2 },
}));

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    ...rnDom,
    Animated: { View: rnDom.View, Value: class { setValue() {} } },
    ActivityIndicator: rnDom.View,
  };
});
vi.mock("expo-router", () => ({ Redirect: () => null, usePathname: () => "/" }));
vi.mock("../src/net/connection", () => ({
  MAIL_SURFACE: "screens",
  useConnection: () => ({ state: { k: "live", session: scene.session }, profiles: [1] }),
}));
vi.mock("../src/net/account", () => ({ readAccess: () => scene.answer }));
vi.mock("../src/state/access-verdict-native", () => ({}));
vi.mock("../src/state/access-verdict", () => ({
  recordVerdict: () => undefined,
  storedVerdict: () => null,
  verdictsReady: () => true,
  verdictsSettled: () => Promise.resolve(),
}));
vi.mock("../src/ui/AccountWall", () => ({ AccountWall: () => null }));
vi.mock("../src/ui/UpdateCard", () => ({ UpdateCard: () => null }));
vi.mock("../src/ui/LifecycleStrip", () => ({ LifecycleStrip: () => null }));
vi.mock("../src/ui/StorageNotice", () => ({ StorageNotice: () => null }));
vi.mock("../src/theme/mail-fonts", () => ({ useMailFonts: () => false }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    face: "ohmarchy",
    scheme: scene.scheme,
    reduceMotion: true,
    space: { deckCompact: 10 },
    radius: { pill: 99 },
    c: { canvas: "legacy canvas", panel: "legacy panel", tint: "legacy tint", tint2: "legacy tint" },
  }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Screen: rnDom.View,
    Txt: rnDom.Text,
    Panel: rnDom.View,
    useTopPad: (gap: number) => 24 + gap,
  };
});
vi.mock("../src/ui/MailList", () => ({ MailList: () => null }));
/* Seed the live chrome's inputs with mail-derived information and working controls. */
vi.mock("../src/ui/chrome", () => ({
  TopBar: () => h("div", null, scene.mirror.syncFolder, ` ${scene.mirror.unsaved} unsaved changes`,
    h("button", null, "Retry"), h("button", null, "Discard")),
}));

import { Gated } from "../src/ui/Gated";
import { BootShell, SKELETON_GRACE_MS } from "../src/ui/Skeleton";
import { TopBar } from "../src/ui/chrome";

afterEach(() => { vi.useRealTimers(); });

describe("the phone opening shell", () => {
  it("keeps mail and its actions behind a pending managed access verdict", async () => {
    vi.useFakeTimers();
    scene.session = { profile: { id: "managed", flavor: "managed", origin: "https://example.invalid" } };
    let allow!: () => void;
    scene.answer = new Promise((resolve) => { allow = resolve; });
    const view = mount(h(Gated, { children: h(TopBar, {}) }));
    try {
      for (const wait of [0, SKELETON_GRACE_MS + 1]) {
        await act(async () => { await vi.advanceTimersByTimeAsync(wait); });
        expect(view.el.textContent).not.toContain(scene.mirror.syncFolder);
        expect(view.el.textContent).not.toContain("2 unsaved changes");
        expect(view.el.querySelector("button")).toBeNull();
        expect(view.el.querySelector('[data-role="progressbar"]')).not.toBeNull();
      }
      await act(async () => { allow(); });
      expect(view.el.textContent).toContain(scene.mirror.syncFolder);
      expect(view.el.textContent).toContain("2 unsaved changes");
      expect(Array.from(view.el.querySelectorAll("button"), (button) => button.textContent)).toEqual(["Retry", "Discard"]);
    } finally {
      view.unmount();
    }
  });

  it.each(["light", "dark"] as const)("draws the Ohmarchy %s mail ground, sheet and rows", async (scheme) => {
    vi.useFakeTimers();
    scene.scheme = scheme;
    const face = design.faces.ohmarchy[scheme];
    const view = mount(h(BootShell, {}));
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(SKELETON_GRACE_MS + 1); });
      const styles = [...view.el.querySelectorAll("[data-rn]")].map(styleOf);
      expect(styles).toContainEqual(expect.objectContaining({ backgroundColor: face.ground }));
      expect(styles).toContainEqual(expect.objectContaining({ backgroundColor: face.sheet, borderTopLeftRadius: parseFloat(face["r-sheet"]) }));
      expect(styles).toContainEqual(expect.objectContaining({ minHeight: parseFloat(face.row) + parseFloat(face.s4) }));
      expect(styles).toContainEqual(expect.objectContaining({ backgroundColor: face["soft-sheet"], width: parseFloat(face.av) }));
    } finally {
      view.unmount();
    }
  });
});
