/** @vitest-environment jsdom */
import { act, createElement as h, useEffect, useImperativeHandle, type Ref } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ShellSession } from "../src/net/pairing";
import type { ShellViewHandle, ShellViewProps } from "../src/shell/shell-port";
import { mount } from "./_rendered-dom";

const fixture = vi.hoisted(() => {
  vi.stubEnv("EXPO_PUBLIC_OHMAIL_MAIL_SURFACE", "shell");
  return {
    session: null as ShellSession | null,
    ask: null as ((request: object) => void) | null,
    posted: [] as Record<string, unknown>[],
  };
});

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  ActivityIndicator: () => null,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }), exitApp: () => undefined },
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  Linking: { openURL: async () => undefined },
}));
vi.mock("expo-router", () => ({
  Redirect: () => null, router: {}, usePathname: () => "/shell", useFocusEffect: useEffect,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { HEX: "hex", BASE64: "base64" },
  digestStringAsync: async () => "0".repeat(64),
}));
vi.mock("expo-sqlite", () => ({ defaultDatabaseDirectory: "/data" }));
vi.mock("../src/state/servers-native", () => ({
  nativeServerProfiles: () => ({
    active: async () => fixture.session?.profile ?? null,
    list: async () => fixture.session ? [fixture.session.profile] : [],
  }),
  nativeFamilyDigest: async () => "",
  secureKV: () => null,
}));
vi.mock("../src/state/install-marker", () => ({ settleInstallGeneration: async () => ({ kind: "same-install" }) }));
vi.mock("../src/engine/native", () => ({ nativeEngineDeps: () => null }));
vi.mock("../src/state/access-verdict-native", () => ({}));
vi.mock("../src/ui/base", () => ({ Txt: ({ children }: { children: string }) => h("span", null, children), useTopPad: () => 0 }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({ hasFold: false, fold: null }) }));
vi.mock("../src/ui/posture/posture-native", () => ({ nativePosture: () => null }));
vi.mock("../src/switch/switch-native", () => ({ switchNative: () => null }));
vi.mock("../src/variant-native", async () => ({ APP: (await import("../src/variant")).variantOfAppId("app.ohmail") }));
vi.mock("../src/shell/doors", () => ({
  askNoticePermission: async () => "default",
  measureShellBackup: async () => "unknown",
  noticePermission: async () => "default",
  onShellWake: () => () => undefined,
}));
vi.mock("../src/engine/notification-permission-native", () => ({ nativeNotificationPermission: () => null }));
vi.mock("../src/engine/diagnostics-native", () => ({
  nativePhoneDiagnosticDeps: vi.fn(),
  shareDiagnosticFile: vi.fn(),
}));
vi.mock("../src/engine/backup-exclusion-native", () => ({ nativeBackupExclusion: () => null }));
vi.mock("../src/net/pairing", async (original) => ({
  ...await original<typeof import("../src/net/pairing")>(),
  connectShellById: async () => ({ kind: "shell", session: fixture.session }),
  drainPendingWipes: async () => undefined,
  drainPendingSignOuts: async () => undefined,
  drainPendingWakeDrops: async () => undefined,
}));
vi.mock("../src/shell/shell-native", () => {
  const native = {
    webViewCheck: () => ({ installed: true, major: 133, listener: true, sealed: true }),
    setFamilies: async () => true,
    storagePaths: () => ({ keeper: "/keeper", webData: "/page" }),
  };
  return { shellNative: () => native, shellView: () => WebView };
});

import { BearerManagerRN } from "../src/net/bearer";
import { ConnectionProvider, useConnection } from "../src/net/connection";
import { shellSessionOf } from "../src/net/pairing";
import { ShellScreen } from "../src/shell/ShellScreen";
import { WakeProvider } from "../src/state/wake";

function WebView({ scope, onEpoch, onMessage, ref }: ShellViewProps & { ref?: Ref<ShellViewHandle> }) {
  useImperativeHandle(ref, () => ({
    post: async (_epoch, text) => { fixture.posted.push(JSON.parse(text)); },
    openHeld: async () => false,
  }));
  useEffect(() => {
    if (scope === null) return;
    onEpoch({ nativeEvent: { epoch: "current" } });
    fixture.ask = (request) => onMessage({
      nativeEvent: {
        epoch: "current", origin: "https://appassets.androidplatform.net", mainFrame: true,
        data: JSON.stringify({ epoch: "current", scope, ...request }),
      },
    });
    fixture.ask({ id: 1, kind: "ready", place: "#/ohbox" });
  }, [scope]);
  return scope === null ? null : h("section", { role: "region", "aria-label": "Ohbox" });
}

function MailView() {
  const { state } = useConnection();
  return state.k === "shell" ? h(ShellScreen, { session: state.session }) : null;
}

afterEach(() => {
  fixture.session = null;
  fixture.ask = null;
  fixture.posted.length = 0;
  vi.unstubAllEnvs();
});

it("removes the mail view on completed sign-out while a mailbox answer is pending", async () => {
  const origin = ["https:", "", "example.invalid"].join("/");
  let answerRead!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { answerRead = resolve; });
  let readStarted = false;
  const bearer = new BearerManagerRN({
    origin,
    accessToken: ["fixture", "access"].join("-"),
    refreshToken: ["fixture", "refresh"].join("-"),
    vault: {
      save: async () => "landed", clear: async () => "landed",
      armAttempt: async () => "landed", oweSignOut: async () => false,
    },
    fetchImpl: async (url) => {
      switch (new URL(url).pathname) {
        case "/auth/session": return Response.json({ user: { accountId: "own" } });
        case "/auth/logout": return new Response(null, { status: 204 });
        case "/mailboxes": readStarted = true; return pending;
        default: throw new Error("Unexpected fixture request");
      }
    },
  });
  const profile = {
    id: "pairing", accountId: "own", origin, flavor: "managed", apiBase: null, pin: null,
    refreshToken: null, refreshAttempt: null,
  };
  const session = shellSessionOf({ kind: "paired", profile, bearer, fetch: bearer.fetch, apiBase: null });
  fixture.session = session;
  const view = mount(h(ConnectionProvider, null, h(WakeProvider, null, h(MailView))));
  const ohbox = () => view.el.querySelector('[role="region"][aria-label="Ohbox"]');
  try {
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(fixture.ask).not.toBeNull();
    });
    expect(ohbox()).not.toBeNull();
    await vi.waitFor(() => expect(session.boundAccount()).toBe("own"));
    fixture.ask!({ id: 2, kind: "http", path: "/mailboxes", method: "GET", headers: [], body: null });
    await vi.waitFor(() => expect(readStarted).toBe(true));
    await act(async () => {
      expect(await bearer.signOut()).toBe("told");
      answerRead(Response.json({ items: [] }));
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(ohbox()).toBeNull();
    expect(fixture.posted.some((entry) => entry.id === 2 && entry.ok === true)).toBe(false);
  } finally {
    answerRead(Response.json({ items: [] }));
    view.unmount();
  }
});
