/** @vitest-environment jsdom */
/**
 * The FACE half of the ThemeProvider (paper/ohmarchy, OHMARCHY-PLAN.md §3a): the resolution
 * order the provider promises — device pin, then adopted account face, then the Linux-device
 * detection, then paper — plus the `data-face` stamp contract (absent = paper) and the
 * pre-paint init script executing the same order.
 *
 * Mutation-proven at authoring time: swapping the provider's `devicePin ?? accountFace`
 * resolution went red on the pin-beats-account case; dropping the `CrOS` exclusion from
 * `linuxDesktopDevice` went red on the ChromeOS case; removing the init script's account-
 * mirror read went red on the script suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, act } from "@testing-library/react";
import {
  ThemeProvider,
  themeInitScript,
  linuxDesktopDevice,
  useTheme,
  type FaceName,
} from "@ohmail/ui";
import { jarDoor } from "./storage-door.js";

const LINUX_UA = "Mozilla/5.0 (X" + "11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
const CROS_UA = "Mozilla/5.0 (X" + "11; CrOS x86_64 14541.0.0) AppleWebKit/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

function stubPlatform(platform: string, ua: string) {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

let seen: { face: FaceName; facePreference: FaceName | null; accountFace: FaceName | null } | null =
  null;
let controls: ReturnType<typeof useTheme> | null = null;

function Probe() {
  const ctx = useTheme();
  seen = { face: ctx.face, facePreference: ctx.facePreference, accountFace: ctx.accountFace };
  controls = ctx;
  return <span data-testid="face">{ctx.face}</span>;
}

/* The door is the HOST's, and these cases are about what survives a reload — so they hand the
   provider one over jsdom's jar. `packages/ui` declares the shape and implements none of it; the
   double is in `storage-door.ts` and fails the way production fails. */
const mount = (faces = true) =>
  render(
    <ThemeProvider faces={faces} storage={jarDoor()}>
      <Probe />
    </ThemeProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.face;
  stubPlatform("", MAC_UA);
  seen = null;
  controls = null;
});

describe("linuxDesktopDevice", () => {
  it("is true for a Linux desktop browser and false for Android/ChromeOS/mac", () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    expect(linuxDesktopDevice()).toBe(true);
    stubPlatform("Linux x86_64", CROS_UA);
    expect(linuxDesktopDevice()).toBe(false);
    stubPlatform("Linux armv8l", ANDROID_UA);
    expect(linuxDesktopDevice()).toBe(false);
    stubPlatform("MacIntel", MAC_UA);
    expect(linuxDesktopDevice()).toBe(false);
  });
});

describe("the axis is OPT-IN per host", () => {
  it("a host that does not pass `faces` gets the pre-face provider — even on Linux with stored state", () => {
    // The landing and the admin mount this provider with no face controls (review-caught):
    // with the axis off, nothing detects, nothing stamps, storage is not even read.
    stubPlatform("Linux x86_64", LINUX_UA);
    window.localStorage.setItem("ohmail.face", "ohmarchy");
    window.localStorage.setItem("ohmail.face.account", "ohmarchy");
    mount(false);
    expect(seen?.face).toBe("paper");
    expect(document.documentElement.dataset.face).toBeUndefined();
  });
  it("the init script without `faces` stamps the theme only", () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    window.localStorage.setItem("ohmail.theme", "dark");
    window.localStorage.setItem("ohmail.face", "ohmarchy");
    (0, eval)(themeInitScript());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.face).toBeUndefined();
  });
});

describe("face resolution order", () => {
  it("defaults to paper on a non-Linux device, with no data-face stamped", () => {
    stubPlatform("MacIntel", MAC_UA);
    mount();
    expect(seen?.face).toBe("paper");
    expect(document.documentElement.dataset.face).toBeUndefined();
  });

  it("a Linux device with no choice anywhere defaults to ohmarchy, device-only", () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    mount();
    expect(seen?.face).toBe("ohmarchy");
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    // detection is a default, not a choice — nothing is stored anywhere
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(seen?.facePreference).toBeNull();
    expect(seen?.accountFace).toBeNull();
  });

  it("an explicit device pin beats the Linux detection", () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    window.localStorage.setItem("ohmail.face", "paper");
    mount();
    expect(seen?.face).toBe("paper");
    expect(document.documentElement.dataset.face).toBeUndefined();
  });

  it("the account mirror applies where no pin exists", () => {
    stubPlatform("MacIntel", MAC_UA);
    window.localStorage.setItem("ohmail.face.account", "ohmarchy");
    mount();
    expect(seen?.face).toBe("ohmarchy");
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
  });

  it("the device pin beats the account", () => {
    stubPlatform("MacIntel", MAC_UA);
    window.localStorage.setItem("ohmail.face", "paper");
    window.localStorage.setItem("ohmail.face.account", "ohmarchy");
    mount();
    expect(seen?.face).toBe("paper");
  });

  it("setFace persists the pin and stamps; null clears both", () => {
    stubPlatform("MacIntel", MAC_UA);
    mount();
    act(() => controls!.setFace("ohmarchy"));
    expect(window.localStorage.getItem("ohmail.face")).toBe("ohmarchy");
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    act(() => controls!.setFace(null));
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(document.documentElement.dataset.face).toBeUndefined();
  });

  it("keeps an explicit device choice across a reload with an account face", () => {
    const renderFace = () => render(
      <ThemeProvider faces preferAccountFace storage={jarDoor()}>
        <Probe />
      </ThemeProvider>,
    );
    window.localStorage.setItem("ohmail.face.account", "ohmarchy");
    const first = renderFace();
    expect(seen?.face).toBe("ohmarchy");
    act(() => controls!.setFace("paper", true));
    expect(seen?.face).toBe("paper");
    first.unmount();
    renderFace();
    expect(seen?.face).toBe("paper");
    expect(controls?.deviceFaceExplicit).toBe(true);
  });

  it("adoptAccountFace mirrors for the next boot; null clears the mirror", () => {
    stubPlatform("MacIntel", MAC_UA);
    mount();
    act(() => controls!.adoptAccountFace("ohmarchy"));
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
    expect(seen?.face).toBe("ohmarchy");
    act(() => controls!.adoptAccountFace(null));
    expect(window.localStorage.getItem("ohmail.face.account")).toBeNull();
    expect(seen?.face).toBe("paper");
  });
});

describe("themeInitScript's face half", () => {
  const run = () => {
    // The script is inline JS the browser runs before paint; executing it verbatim is the
    // only honest test of it. `faces` — this suite tests the face half, which is opt-in.
    // eslint-disable-next-line no-eval
    (0, eval)(themeInitScript("ohmail.theme", { faces: true }));
  };

  it("stamps the device pin", () => {
    stubPlatform("MacIntel", MAC_UA);
    window.localStorage.setItem("ohmail.face", "ohmarchy");
    run();
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
  });

  it("falls back to the account mirror", () => {
    stubPlatform("MacIntel", MAC_UA);
    window.localStorage.setItem("ohmail.face.account", "ohmarchy");
    run();
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
  });

  it("falls back to the Linux detection, and paper stamps nothing", () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    run();
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    delete document.documentElement.dataset.face;
    stubPlatform("MacIntel", MAC_UA);
    run();
    expect(document.documentElement.dataset.face).toBeUndefined();
  });

  it("an explicit paper pin on Linux stamps nothing — the prior choice wins over detection", () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    window.localStorage.setItem("ohmail.face", "paper");
    run();
    expect(document.documentElement.dataset.face).toBeUndefined();
  });

  it("keeps the theme half intact", () => {
    window.localStorage.setItem("ohmail.theme", "dark");
    run();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("a BLOCKED storage jar still reaches the Linux detection — no paper flash on sandboxed contexts", () => {
    // review-caught: with the reads and the detection in ONE try, a throwing getItem skipped
    // the detection and the page flashed paper until hydration re-skinned it.
    stubPlatform("Linux x86_64", LINUX_UA);
    const original = window.localStorage.getItem.bind(window.localStorage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.localStorage as any).getItem = () => { throw new Error("blocked"); };
    try {
      run();
      expect(document.documentElement.dataset.face).toBe("ohmarchy");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.localStorage as any).getItem = original;
    }
  });
});
