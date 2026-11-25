import { PROVIDERS } from "@ohmail/app-logic/mailboxes/connect/providers";
import { createElement } from "react";
import { Platform, screen as device, StyleSheet } from "./helpers/rn-host";
import { act, cleanupAsync, fireEvent, render, screen } from "@testing-library/react-native/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import StandaloneScreen from "../app/standalone";
import ScanScreen from "../app/scan";
import { design } from "@ohmail/tokens/design";
import { Copy } from "../src/copy";
import { refuse } from "../src/refusal";
import { ThemeProvider } from "../src/theme";
import { Doors } from "../src/ui/Doors";
import { NavDrawnContext } from "../src/ui/nav-drawn";
import { OnboardingPage } from "../src/ui/OnboardingPage";
import { derivePosture } from "../src/ui/posture/derive";
import { scaffoldPlan } from "../src/ui/scaffold/plan";

const camera = vi.hoisted(() => ({ granted: true, ask: vi.fn() }));
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: camera.granted }, camera.ask],
}));

const seam = vi.hoisted(() => ({ ask: vi.fn(), open: vi.fn(), leave: vi.fn(), release: vi.fn() }));
vi.mock("react-native", async () => {
  const host = await import("./helpers/rn-host");
  return {
    ...host,
    Modal: host.View,
    Pressable: (props: React.ComponentProps<typeof host.View>) => createElement("View", { accessible: true, ...props }),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native-svg", () => ({ default: () => null, Circle: () => null }));
vi.mock("../src/ui/UnsavedChanges", () => ({ UnsavedChanges: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/posture", async () => {
  const { derivePosture } = await import("../src/ui/posture/derive");
  return {
    useAppWindow: () => device,
    usePosture: () => derivePosture({ ...device, platform: "android", folds: [] }),
  };
});
vi.mock("expo-router", () => ({ router: { canGoBack: () => false, replace: () => seam.leave() } }));
vi.mock("../src/net/connection", () => ({ useConnection: () => ({ ask: seam.ask }) }));
vi.mock("../src/net/account", () => ({ WEB_APP_URL: "https://mailbox.example" }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/engine/engine-artifact", () => ({ phoneEngineStart: () => () => undefined }));
vi.mock("../src/engine/standalone-door", () => ({
  standaloneAvailable: () => true,
  openStandaloneMailbox: seam.open,
}));
vi.mock("../src/engine/engine-log", () => ({ engineLogSink: () => undefined }));
vi.mock("../src/engine/organizer-session", () => ({
  takeStandaloneLaunch: () => "taken",
  armConsentPress: () => undefined,
  releaseStandaloneLaunch: seam.release,
}));
vi.mock("../src/ui/useNotifyPermission", () => ({ useNotifyPermission: () => ({ open: false }) }));
vi.mock("../src/ui/NotifyPermission", () => ({ NotifyPermission: () => null }));
vi.mock("../src/net/network-door", () => ({ networkNow: () => true }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../src/net/host-pinning", () => ({ canPin: () => true, isNotTls: () => false }));

function draw(node: React.ReactNode, rail: boolean) {
  return render(<ThemeProvider pref="light"><NavDrawnContext.Provider value={rail}>{node}</NavDrawnContext.Provider></ThemeProvider>);
}

const button = (name: string) => screen.getByRole("button", { name });
const press = (name: string) => fireEvent.press(button(name));

afterEach(async () => {
  await cleanupAsync();
  Object.assign(device, { width: 400, height: 800 });
  Platform.OS = "android";
  camera.granted = true;
  vi.resetAllMocks();
});

it.each([
  { os: "ios", width: 390, height: 844, granted: true },
  { os: "android", width: 412, height: 915, granted: false },
])("renders the square QR view and manual pairing at $width × $height on $os", ({ os, width, height, granted }) => {
  Object.assign(device, { width, height });
  Platform.OS = os;
  camera.granted = granted;
  draw(<ScanScreen />, false);
  const scan = screen.getByLabelText(granted ? Copy.scanHint : Copy.scanCameraOff);
  expect(StyleSheet.flatten(scan.props.style)).toMatchObject({
    aspectRatio: 1,
    backgroundColor: design.faces.paper.light.solid,
  });
  expect(screen.getByText(Copy.scanDevices)).toBeTruthy();
  press(Copy.scanManual);
  expect(seam.leave).toHaveBeenCalledOnce();
  if (!granted) {
    press(Copy.scanAllow);
    expect(camera.ask).toHaveBeenCalledOnce();
  }
});

describe("leaving phone setup", () => {
  it("draws and presses Back in a rail posture when the rail is absent", async () => {
    Object.assign(device, { width: 850, height: 400 });
    expect(scaffoldPlan(derivePosture({ ...device, platform: "android", folds: [] }), "android").nav).toBe("rail");
    const back = vi.fn();
    const page = <OnboardingPage back={back}>Setup</OnboardingPage>;
    draw(page, false);
    press(Copy.back);
    expect(back).toHaveBeenCalledTimes(1);
    await cleanupAsync();
    draw(page, true);
    expect(screen.queryByRole("button", { name: Copy.back })).toBeNull();
  });

  it("lets a person choose differently after Cloud refuses to pair", async () => {
    seam.ask.mockResolvedValue({ kind: "hello", hello: { pairing: false, flavor: "managed" } });
    const scan = vi.fn();
    const typeToken = vi.fn();
    draw(<Doors onScan={scan} onTypeToken={typeToken} />, false);
    press(Copy.ariaNameThenSentence(Copy.doorCloud, Copy.doorCloudSay));
    await act(async () => {});
    expect(screen.getByText(Copy.managedDeferred)).toBeTruthy();
    press(Copy.phoneStandaloneBack);
    expect(screen.queryByText(Copy.managedDeferred)).toBeNull();
    expect(seam.ask).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
    expect(typeToken).not.toHaveBeenCalled();
  });

  it("keeps Back on a server door that covers the rail of an open mailbox", () => {
    Object.assign(device, { width: 850, height: 400 });
    draw(<Doors onScan={vi.fn()} onTypeToken={vi.fn()} />, true);
    press(Copy.ariaNameThenSentence(Copy.doorOwnServer, Copy.doorOwnServerSay));
    expect(screen.getByLabelText(Copy.doorSelfAddress)).toBeTruthy();
    press(Copy.back);
    expect(screen.queryByLabelText(Copy.doorSelfAddress)).toBeNull();
    expect(seam.ask).not.toHaveBeenCalled();
  });

  const appCodeProvider = PROVIDERS.find((preset) => preset.authHints === true)!.label;

  function credentials() {
    draw(<StandaloneScreen />, false);
    press(Copy.phoneStandaloneGo);
    press(appCodeProvider);
  }

  it("explains where the mailbox password is kept before connecting", () => {
    credentials();
    expect(screen.getByText(Copy.phoneStandaloneFormLead)).toBeTruthy();
  });

  it("keeps editable server settings behind the chosen provider’s title", () => {
    credentials();
    expect(screen.queryByRole("button", { name: Copy.phoneStandaloneAdvanced })).toBeNull();
    const provider = Copy.phoneMailboxProvider(appCodeProvider);
    press(provider);
    expect(screen.getByLabelText(Copy.phoneStandaloneImapHost)).toBeTruthy();
    expect(screen.getByLabelText(Copy.phoneStandaloneSmtpPort)).toBeTruthy();
    press(provider);
    expect(screen.queryByLabelText(Copy.phoneStandaloneImapHost)).toBeNull();
  });

  it("announces whether the manual server options are expanded", () => {
    draw(<StandaloneScreen />, false);
    press(Copy.phoneStandaloneGo);
    press(Copy.phoneStandaloneOther);
    const disclosure = () => button(Copy.phoneStandaloneAdvanced);
    expect(disclosure().props.accessibilityState.expanded).toBe(false);
    fireEvent.press(disclosure());
    expect(disclosure().props.accessibilityState.expanded).toBe(true);
    fireEvent.press(disclosure());
    expect(disclosure().props.accessibilityState.expanded).toBe(false);
  });

  it("keeps the credentials open during Connect and gives Back back after a refusal", async () => {
    let finish!: (answer: unknown) => void;
    seam.open.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    credentials();
    fireEvent.changeText(screen.getByLabelText(Copy.phoneStandaloneAddress), "fixture@example.test");
    fireEvent.changeText(screen.getByLabelText(Copy.phoneStandaloneAppPassword), "fixture-password");
    press(Copy.phoneStandaloneConnect);
    press(Copy.back);
    expect(screen.getByLabelText(Copy.phoneStandaloneAddress)).toBeTruthy();
    expect(seam.open).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: false, reason: refuse("standaloneSignInRefused") }); });
    expect(seam.release).toHaveBeenCalledTimes(1);
    press(Copy.back);
    expect(button(appCodeProvider)).toBeTruthy();
    expect(seam.leave).not.toHaveBeenCalled();
  });
});
