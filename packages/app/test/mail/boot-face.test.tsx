/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type FaceName, type StorageDoor } from "@ohmail/ui/theme";
import type { ReactNode } from "react";
import { useFaceAtBoot } from "../../src/mail/ground/boot-face.js";

const frame = vi.hoisted(() => ({
  session: { scope: "account", account: null as string | null },
  build: { surface: "web" as "web" | "desktop" },
  consent: {
    standalone: true,
    themeFaceKnown: false,
    themeFace: null as FaceName | null,
    setThemeFace: null,
  },
}));

vi.mock("@ohmail/app-logic/consent", () => ({ useConsent: () => frame.consent }));
vi.mock("@ohmail/app-logic/engine", () => ({ useDemoMode: () => false }));
vi.mock("../../src/frame/commands.js", () => ({
  useFrame: () => ({ host: { session: frame.session, device: { build: frame.build } } }),
}));
vi.mock("../../src/text/index.js", () => ({ useText: () => (key: string) => key }));

const mirror = "ohmail.face.account";

function mount(saved: FaceName | null) {
  const jar = new Map<string, string>();
  if (saved !== null) jar.set(mirror, saved);
  const storage: StorageDoor = {
    get: (key) => jar.get(key) ?? null,
    set: (key, value) => {
      jar.set(key, value);
      return "stored";
    },
    remove: (key) => {
      jar.delete(key);
      return "stored";
    },
  };
  const view = renderHook(
    () => {
      useFaceAtBoot();
      return useTheme().face;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ThemeProvider faces deferLinuxFace storage={storage}>
          {children}
        </ThemeProvider>
      ),
    },
  );
  return { ...view, jar };
}

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  frame.session = { scope: "account", account: null };
  frame.build.surface = "web";
  frame.consent = { standalone: true, themeFaceKnown: false, themeFace: null, setThemeFace: null };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.face;
});

it.each([null, "paper"] as const)("holds paper while the web wire is pending with mirror %s", (saved) => {
  const { result, rerender, jar } = mount(saved);
  expect(result.current).toBe("paper");
  expect(jar.get(mirror) ?? null).toBe(saved);

  frame.session.account = frame.session.scope;
  frame.consent.standalone = false;
  rerender();
  expect(result.current).toBe("paper");
  expect(jar.get(mirror) ?? null).toBe(saved);
});

it("clears the mirror when the live consent answer has no account face", () => {
  frame.session.account = frame.session.scope;
  frame.consent.standalone = false;
  const { result, rerender, jar } = mount("paper");
  expect(result.current).toBe("paper");
  expect(jar.get(mirror)).toBe("paper");

  frame.consent.themeFaceKnown = true;
  rerender();
  expect(result.current).toBe("ohmarchy");
  expect(jar.has(mirror)).toBe(false);
});

it("clears the account face when the desktop switches to standalone", () => {
  frame.build.surface = "desktop";
  frame.session.account = frame.session.scope;
  frame.consent = { standalone: false, themeFaceKnown: true, themeFace: "paper", setThemeFace: null };
  const { result, rerender, jar } = mount(null);
  expect(result.current).toBe("paper");
  expect(jar.get(mirror)).toBe("paper");

  frame.session = { scope: "local-mailbox", account: null };
  frame.consent = { standalone: true, themeFaceKnown: false, themeFace: null, setThemeFace: null };
  rerender();
  expect(result.current).toBe("ohmarchy");
  expect(jar.has(mirror)).toBe(false);
});
