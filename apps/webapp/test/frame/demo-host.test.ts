import { describe, expect, it } from "vitest";
import { CANNOT, FEATURE_NAMES, NONE, type FrameSupplies, type HostContract } from "@ohmail/app/host";
import { DEMO_STORAGE_OWNER } from "@ohmail/app-logic/storage/storage-owner";
import { DEMO_NOW } from "@ohmail/testing/adapter";
import { demoHost } from "../../app/(product)/demo/host";

/** The invented world has its own About and reaches no account service. */
const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const frame = {
  places: named("places"), stages: named("stages"), above: named("above"), overs: named("overs"), address: named("address"),
  window: named("window"), appearance: named("appearance"), recover: NONE,
} as FrameSupplies;
const engine = named<HostContract["engine"]>("engine");

describe("the demo's host", () => {
  const host = demoHost(engine, frame, { service: "managed", sendCeiling: "strict" }, NONE);

  it("hands the invented world its own features and no account feature, wire, read or signal", () => {
    expect(Object.values(host.wires).every((w) => w === NONE)).toBe(true);
    expect(host.wires.connect).toBe(NONE);
    expect(host.reads).toEqual({ mailboxes: NONE, copyAge: NONE, access: NONE });
    expect(FEATURE_NAMES.filter((f) => host.features[f] !== NONE)).toEqual(["about", "stageCard"]);
    expect(host.features.stageCard).toMatchObject({ notice: expect.any(Function) });
    expect(Object.values(host.signals).every((s) => s === NONE)).toBe(true);
    /* The one member the demo says beside its partition: its frozen day (the demo keeps it, as today's did). */
    expect(host.session).toEqual({
      resolve: NONE, confirmed: NONE, state: NONE, scope: DEMO_STORAGE_OWNER, mirrorAccount: null, account: null, accountAddress: null, recover: NONE, signOut: NONE,
      today: DEMO_NOW,
    });
  });

  it("says its service and its ceiling as the page names them, and marks its rules", () => {
    expect(host.capabilities).toEqual({ ...CANNOT, service: "managed", sendCeiling: "strict", rulesMarked: true });
    expect(demoHost(engine, frame, { service: "self", sendCeiling: 1024 }, NONE).capabilities).toMatchObject({ service: "self", sendCeiling: 1024 });
  });

  it("stands in a browser: the frame's address, window and look, and the browser's notifications", () => {
    expect(host.device).toMatchObject({ address: frame.address, window: frame.window, appearance: frame.appearance });
    expect(host.features).toMatchObject({ places: frame.places, stages: frame.stages, above: frame.above });
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
