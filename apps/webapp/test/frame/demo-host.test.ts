import { describe, expect, it } from "vitest";
import { CANNOT, FEATURE_NAMES, NONE, type FrameSupplies, type HostContract } from "@ohmail/app/host";
import { DEMO_STORAGE_OWNER } from "@ohmail/app-logic/storage/storage-owner";
import { demoHost } from "../../app/(product)/demo/host";

/** The invented world reaches nothing: every wire, read, feature and signal is none, and it says its own service. */
const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const frame = {
  places: named("places"), stages: named("stages"), address: named("address"), window: named("window"),
  appearance: named("appearance"), recover: NONE,
} as FrameSupplies;
const engine = named<HostContract["engine"]>("engine");

describe("the demo's host", () => {
  const host = demoHost(engine, frame, { service: "managed", sendCeiling: "strict" });

  it("hands no wire, read, feature or signal to the invented world", () => {
    expect(Object.values(host.wires).every((w) => w === NONE)).toBe(true);
    expect(host.wires.connect).toBe(NONE);
    expect(host.reads).toEqual({ mailboxes: NONE, copyAge: NONE, access: NONE });
    expect(FEATURE_NAMES.filter((f) => host.features[f] !== NONE)).toEqual([]);
    expect(Object.values(host.signals).every((s) => s === NONE)).toBe(true);
    expect(host.session).toEqual({ resolve: NONE, confirmed: NONE, state: NONE, scope: DEMO_STORAGE_OWNER, account: null, recover: NONE, signOut: NONE });
  });

  it("says its service and its ceiling as the page names them, and marks its rules", () => {
    expect(host.capabilities).toEqual({ ...CANNOT, service: "managed", sendCeiling: "strict", rulesMarked: true });
    expect(demoHost(engine, frame, { service: "self", sendCeiling: 1024 }).capabilities).toMatchObject({ service: "self", sendCeiling: 1024 });
  });

  it("stands in a browser: the frame's address, window and look, and the browser's notifications", () => {
    expect(host.device).toMatchObject({ address: frame.address, window: frame.window, appearance: frame.appearance });
    expect(host.device.build.surface).toBe("web");
    expect(host.device.notifications).not.toBe(NONE);
  });
});

describe("the demo's document", () => {
  it("is the product's empty gate on the server: the frame lays out by a window the server does not know", async () => {
    const { createElement: h } = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { DemoShell } = await import("../../app/(product)/demo/DemoShell");
    const html = renderToString(h(DemoShell, { serverDemo: true, says: { service: "managed", sendCeiling: "strict" } }));
    expect(html).toBe('<div class="gate" aria-busy="true" data-demo=""></div>');
  });

  it("names the demo only where the server decided it: the same gate unmarked when the page's word is not the demo", async () => {
    const { createElement: h } = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { DemoShell } = await import("../../app/(product)/demo/DemoShell");
    const html = renderToString(h(DemoShell, { serverDemo: false, says: { service: "managed", sendCeiling: "strict" } }));
    expect(html).toBe('<div class="gate" aria-busy="true"></div>');
  });
});
