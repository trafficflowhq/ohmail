import { describe, expect, it } from "vitest";
import { CalendarAdmission } from "../src/calendar/live-port";

const A = "p0000001";
const B = "p0000002";

function native() {
  const calls: string[] = [];
  return {
    calls,
    setLive: async (id: string | null) => { calls.push("open " + id); return true; },
    forget: async (id: string) => { calls.push("forget " + id); return true; },
    recover: async () => true,
  };
}

describe("calendar admission follows the connection", () => {
  it("keeps only the authorized pairing across a switch and sign-out", async () => {
    const admission = new CalendarAdmission();
    const device = native();
    expect(admission.allows(A)).toBe(false);
    await admission.open(device, A);
    expect(admission.allows(A)).toBe(true);
    await admission.revoke(device, A);
    await admission.open(device, B);
    expect(admission.allows(A)).toBe(false);
    expect(admission.allows(B)).toBe(true);
    await admission.revoke(device, B);
    expect(admission.allows(B)).toBe(false);
    expect(device.calls).toEqual(["open " + A, "forget " + A, "open " + B, "forget " + B]);
  });

  it("stops outgoing publications before native cleanup finishes", async () => {
    const admission = new CalendarAdmission();
    const device = native();
    let finish: (ok: boolean) => void = () => {};
    device.forget = () => new Promise((resolve) => { finish = resolve; });
    await admission.open(device, A);
    const departure = admission.revoke(device, A);
    expect(admission.allows(A)).toBe(false);
    finish(true);
    expect(await departure).toBe(true);
  });

  it("keeps a refused operation closed", async () => {
    const admission = new CalendarAdmission();
    const denied = { ...native(), setLive: async () => false, forget: async () => false };
    await admission.open(denied, A);
    expect(admission.allows(A)).toBe(false);
    expect(await admission.revoke(denied, A)).toBe(false);
  });

  it("does not re-admit a pairing that leaves while native is still opening it", async () => {
    const admission = new CalendarAdmission();
    const device = native();
    let finish: (ok: boolean) => void = () => {};
    device.setLive = () => new Promise((resolve) => { finish = resolve; });
    const opening = admission.open(device, A);
    await admission.revoke(device, A);
    finish(true);
    await opening;
    expect(admission.allows(A)).toBe(false);
  });

  it("cleans an inactive pairing without giving it the active pairing's admission", async () => {
    const admission = new CalendarAdmission();
    const device = native();
    await admission.open(device, B);
    await admission.revoke(device, A);
    expect(admission.allows(A)).toBe(false);
    expect(admission.allows(B)).toBe(true);
    expect(device.calls).toEqual(["open " + B, "forget " + A]);
  });
});
