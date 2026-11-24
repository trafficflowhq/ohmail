/** @vitest-environment jsdom */
/**
 * THE MAIL APP ON ITS OWN SCREENS KEEPS TODAY'S WELCOME. As it ships, with no surface named by its build, the mail
 * app shows its own screens (`mail-surface.ts`), and the door's route sends every such build back to the root
 * (`app/door.tsx`): a gate that opened the door there would send a fresh install from the root to the door and back
 * again, and it would never reach a way in. Only under the shell does the gate's welcome open the door's page; on its
 * own screens the welcome is today's, and its list of servers and a refusal are today's list. Rendered in the mail
 * app, as its switch module names it.
 */
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";

const scene = vi.hoisted(() => ({
  conn: null as unknown,
  pushed: [] as string[],
  /** Where the gate sent the app: a redirect's address, or the connect's own screen. */
  drawn: [] as string[],
  /** What the shell's screen handed its bridge: the act handler is read from here. */
  bridge: null as null | { act: (a: { act: string }) => Promise<unknown> },
}));

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  ActivityIndicator: () => null,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }), exitApp: () => undefined },
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  Linking: { openURL: async () => undefined },
}));
vi.mock("expo-router", () => ({
  router: { push: (to: string) => void scene.pushed.push(to), canGoBack: () => false, back: () => undefined, replace: () => undefined },
  Redirect: ({ href }: { href: string }) => (scene.drawn.push(href), null),
  usePathname: () => "/",
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
/* The mail app, as its switch module names it; no other native module is here. */
vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) => (name === "OhmailSwitch"
    ? { appId: "app.ohmail", addListener: () => ({ remove: () => undefined }), takeArrival: async () => null }
    : null),
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { HEX: "hex", BASE64: "base64" },
  digestStringAsync: async () => "0".repeat(64),
}));
vi.mock("expo-sqlite", () => ({ defaultDatabaseDirectory: "/data" }));
vi.mock("../src/state/servers-native", () => ({ nativeServerProfiles: () => null, nativeFamilyDigest: async () => "", secureKV: () => null }));
vi.mock("../src/engine/native", () => ({ nativeEngineDeps: () => null }));
vi.mock("../src/state/access-verdict-native", () => ({}));
/* The gate reads the connection it is handed; the surface is the real module's, for this app. */
vi.mock("../src/net/connection", async (original) => ({
  ...((await original()) as object),
  useConnection: () => scene.conn,
}));
vi.mock("../src/theme", () => ({ useTheme: () => ({ c: { ink: "#000", accent: "#000", canvas: "#fff" } }) }));
vi.mock("../src/ui/base", () => ({
  Txt: (p: { children?: unknown }) => h("span", null, p.children as never),
  Panel: () => null,
  Screen: () => null,
}));
vi.mock("../src/ui/Skeleton", () => ({ BootShell: () => (scene.drawn.push("the connect's own screen"), null) }));
vi.mock("../src/ui/AccountWall", () => ({ AccountWall: () => null }));
vi.mock("../src/ui/UpdateCard", () => ({ UpdateCard: () => null }));
vi.mock("../src/ui/LifecycleStrip", () => ({ LifecycleStrip: () => null }));
vi.mock("../src/ui/StorageNotice", () => ({ StorageNotice: () => null }));
vi.mock("../src/ui/Icon", () => ({ Wordmark: () => null }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({ hasFold: false, fold: null }) }));
vi.mock("../src/ui/posture/posture-native", () => ({ nativePosture: () => null }));
/* The shell's natives: a phone with no web view to give, so the screen draws its sentence; the bridge is recorded. */
vi.mock("../src/shell/shell-native", () => ({ shellNative: () => null, shellView: () => () => null }));
vi.mock("../src/shell/doors", () => ({
  askNoticePermission: async () => "default",
  measureShellBackup: async () => "unknown",
  noticePermission: async () => "default",
  onShellWake: () => () => undefined,
}));
vi.mock("../src/engine/notification-permission-native", () => ({ nativeNotificationPermission: () => null }));
vi.mock("../src/engine/backup-exclusion-native", () => ({ nativeBackupExclusion: () => null }));
vi.mock("../src/switch/switch-native", () => ({ switchNative: () => null }));
vi.mock("../src/shell/bridge-host", () => ({
  BridgeHost: class {
    constructor(deps: { act: (a: { act: string }) => Promise<unknown> }) {
      scene.bridge = deps;
    }
    send(): void {}
  },
}));

import { Gated } from "../src/ui/Gated";
import { MAIL_SURFACE, type ConnectionState } from "../src/net/connection";
import { refuse } from "../src/refusal";

afterEach(() => {
  scene.conn = null;
  scene.pushed.splice(0);
  scene.drawn.splice(0);
  scene.bridge = null;
  document.body.innerHTML = "";
});

describe("the mail app as it ships", () => {
  it("on its own screens: the gate's welcome is today's welcome, its list and a refusal today's list", () => {
    expect(MAIL_SURFACE, "the mail app shows its own screens until its build says shell").toBe("screens");
    const reached = (state: ConnectionState, paired: number): string | undefined => {
      scene.conn = { state, profiles: Array.from({ length: paired }, (_, i) => ({ id: `row-${i}` })) };
      scene.drawn.splice(0);
      const view = mount(h(Gated, { children: null }));
      view.unmount();
      return scene.drawn.at(-1);
    };
    expect({
      nothingPaired: reached({ k: "idle" }, 0),
      paired: reached({ k: "idle" }, 1),
      refused: reached({ k: "refused", reason: refuse("pairEnded") }, 1),
    }).toEqual({ nothingPaired: "/welcome", paired: "/servers", refused: "/servers" });
  });
});
