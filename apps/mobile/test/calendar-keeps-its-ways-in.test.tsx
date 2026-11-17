/** @vitest-environment jsdom */
/**
 * THE CALENDAR APP KEEPS ITS WAYS IN until the door's pages are built. That app carries no screens and is always the
 * shell (`mail-surface.ts`), so a route to the door before the page it lands on exists would leave it on an empty
 * stage: no way to pair, no list of servers, nothing after a sign-out. Each route moves to the door with the pull
 * request that fills its page: the gate's welcome has (the ways in); until then its list and connect in flight, and
 * the shell page's two acts that open the list, reach what they reached before the door. Rendered in the calendar
 * app, as its switch module names it.
 */
import { act, createElement as h } from "react";
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
/* The calendar app, as its switch module names it; no other native module is here. */
vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) => (name === "OhmailSwitch"
    ? { appId: "app.ohcal", addListener: () => ({ remove: () => undefined }), takeArrival: async () => null }
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
import type { ShellSession } from "../src/net/pairing";
import { refuse } from "../src/refusal";
import { ShellScreen } from "../src/shell/ShellScreen";

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

afterEach(() => {
  scene.conn = null;
  scene.pushed.splice(0);
  scene.drawn.splice(0);
  scene.bridge = null;
  document.body.innerHTML = "";
});

describe("the calendar app before the door's pages are built", () => {
  it("is the shell, and its gate sends it to the welcome, its list of servers and the connect's own screen", () => {
    expect(MAIL_SURFACE, "the calendar app carries no screens").toBe("shell");
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
      connecting: reached({ k: "connecting", origin: "https://mail.example.test" }, 1),
    }).toEqual({
      nothingPaired: "/door", paired: "/servers", refused: "/servers", connecting: "the connect's own screen",
    });
  });

  it("its shell page's two acts that open the list of servers push the list, as before the door", async () => {
    const session = {
      profile: { id: "row-1", origin: "https://mail.example.test", flavor: "selfhost", accountId: "account-1", pin: null },
      ownerKey: "owner-1", standalone: false,
    } as unknown as ShellSession;
    const view = mount(h(ShellScreen, { session }));
    await settle();
    expect(scene.bridge, "the screen handed its bridge the acts").not.toBeNull();
    for (const name of ["openServers", "signOut"]) expect(await scene.bridge!.act({ act: name }), name).toEqual({});
    expect(scene.pushed).toEqual(["/servers", "/servers"]);
    view.unmount();
  });
});
