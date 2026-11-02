/** @vitest-environment jsdom */
/**
 * SETTINGS' SIGNATURES AND "YOUR NAME", rendered. A typed signature is what Save writes, blank
 * clears it, and a row with formatting or the organizer's signature in force is not offered for
 * change. A name saves through the phone's own engine's route; one past 100 characters is refused
 * in place and nothing is asked.
 */
import { act, createElement as h, forwardRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const React = await import("react");
  return {
    ...rnDom,
    TextInput: forwardRef<HTMLInputElement, { value: string; editable?: boolean; accessibilityLabel?: string; onChangeText?: (v: string) => void }>(
      (p, ref) => React.createElement("input", {
        ref, value: p.value, readOnly: p.editable === false, "data-label": p.accessibilityLabel,
        onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
      }),
    ),
  };
});
vi.mock("expo-router", () => ({ useNavigation: () => ({ dispatch: () => undefined }) }));
vi.mock("expo-router/react-navigation", () => ({ usePreventRemove: () => undefined }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), radius: new Proxy({}, { get: () => 8 }), type: new Proxy({}, { get: () => ({}) }), textCap: 2 }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const div = (p: { children?: ReactNode }) => h("div", null, p.children);
  return {
    Tap: rnDom.Pressable,
    Txt: (p: { children?: ReactNode }) => h("span", null, p.children),
    Button: (p: { label: string; disabled?: boolean; onPress?: () => void }) =>
      h("button", { "data-button": p.label, disabled: p.disabled, onClick: p.onPress }, p.label),
    Panel: div, Section: div, Rule: () => null,
  };
});
const scene = vi.hoisted(() => ({ world: null as unknown, session: null as unknown }));
vi.mock("../src/state/world", () => ({ useWorld: () => scene.world }));
vi.mock("../src/net/connection", () => ({
  useConnection: () => ({ state: { k: "live", session: scene.session }, syncNow: async () => undefined }),
}));

const { mount } = await import("./_rendered-dom");
const { SignaturesPanel } = await import("../src/ui/SignaturesPanel");
const { SenderNamePanel } = await import("../src/ui/SenderNamePanel");
const { writeSignature } = await import("../src/net/consent");
const { Copy } = await import("../src/copy");

/** A session whose every request is recorded and answered with `answer`'s body. */
function wire(answer: (body: Record<string, unknown>) => unknown) {
  const asked: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  scene.session = {
    profile: { origin: "https://srv.test", apiBase: null, accountId: "a" },
    fetch: async (url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      asked.push({ method: init?.method ?? "GET", url, body });
      return new Response(JSON.stringify(answer(body)), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return asked;
}

function rendered(node: ReactNode) {
  const r = mount(node);
  const q = (sel: string) => r.el.querySelector(sel) as HTMLElement | null;
  const type = (label: string, v: string) => act(() => {
    const input = q(`input[data-label="${label}"]`) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const press = async (label: string) => { await act(async () => { q(`button[data-button="${label}"]`)!.click(); }); };
  return { ...r, q, type, press };
}

let open: { unmount(): void } | null = null;
afterEach(() => {
  open?.unmount();
  open = null;
});

describe("the Signatures pane", () => {
  const box = (id: string, address: string, organizerRole: string | null = "organizer") =>
    ({ id, address, status: "connected", organizerRole });
  function pane() {
    const asked = wire((b) => ({ signatures: b.signatures, signaturesHtml: {}, signatureSources: {}, signatureChanges: {} }));
    const mailboxes = [box("own", "own@x.test"), box("rich", "rich@x.test"), box("read", "read@x.test", "reader")];
    scene.world = {
      mailboxes: { known: true, all: mailboxes },
      signatures: { own: "Old words", rich: "Rich", read: "Theirs" },
      signing: {
        html: { rich: "<p><i>Rich</i></p>" }, sources: { read: "organizer" }, changes: {},
        write: (id: string, text: string | null) => writeSignature(scene.session as never, id, text).then(() => true),
      },
    };
    const p = rendered(h(SignaturesPanel));
    open = p;
    return { ...p, asked };
  }

  it("Save writes the typed text for that mailbox", async () => {
    const p = pane();
    p.type(Copy.sigSettingsField("own@x.test"), "Ada, on the phone");
    await p.press(Copy.sigSettingsSave);
    expect(p.asked.map((a) => [a.method, a.url, a.body])).toEqual([
      ["PATCH", "https://srv.test/consent/settings", { signatures: { own: "Ada, on the phone" } }],
    ]);
    expect(p.q(`button[data-button="${Copy.sigSettingsSave}"]`), "saved: nothing left to save").toBeNull();
  });

  it("a blank signature is written as none", async () => {
    const p = pane();
    p.type(Copy.sigSettingsField("own@x.test"), "   ");
    await p.press(Copy.sigSettingsSave);
    expect(p.asked.map((a) => a.body)).toEqual([{ signatures: { own: null } }]);
  });

  it("a signature with formatting and the organizer's are shown, not offered for change", () => {
    const p = pane();
    for (const address of ["rich@x.test", "read@x.test"]) {
      expect((p.q(`input[data-label="${Copy.sigSettingsField(address)}"]`) as HTMLInputElement).readOnly, address).toBe(true);
    }
    expect((p.q(`input[data-label="${Copy.sigSettingsField("own@x.test")}"]`) as HTMLInputElement).readOnly).toBe(false);
    expect(p.el.textContent).toContain(Copy.sigSettingsMarkup);
    expect(p.el.textContent).toContain(Copy.sigSettingsRead);
  });
});

describe("Your name, on a standalone phone", () => {
  function pane() {
    const asked = wire((b) => ({ displayName: b.displayName }));
    scene.world = {
      standalone: true,
      mailboxes: { known: true, rows: [{ id: "mb-1", address: "ann@x.test", displayName: null }] },
    };
    const p = rendered(h(SenderNamePanel));
    open = p;
    return { ...p, asked };
  }

  it("Save sends the name to the phone's own route for that mailbox", async () => {
    const p = pane();
    p.type("ann@x.test", "Ann  Lee ");
    await p.press(Copy.senderNameSave);
    expect(p.asked.map((a) => [a.method, a.url, a.body])).toEqual([
      ["PATCH", "https://srv.test/local/mailboxes/mb-1/name", { displayName: "Ann Lee" }],
    ]);
    expect(p.el.textContent).toContain(Copy.senderNameSaved);
  });

  it("101 characters are refused in place, and nothing is asked", async () => {
    const p = pane();
    p.type("ann@x.test", "a".repeat(101));
    await p.press(Copy.senderNameSave);
    expect(p.asked).toEqual([]);
    expect(p.el.textContent).toContain(Copy.standaloneNameRefused);
  });
});
