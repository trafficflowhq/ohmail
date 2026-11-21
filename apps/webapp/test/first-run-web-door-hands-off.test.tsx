/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { FirstRunWire } from "../../../packages/app/src/host/index.js";
import { O, fakeDoor } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * ON A WEB DOOR THE SETUP STAGE HANDS THE FIRST CONNECT TO THE SETUP PAGE. Its own Connect and Test
 * have no step-up prompt, so a person who took longer than the step-up window met a refusal they
 * could not answer there; `/join` has the provider tiles and the in-place prompt. The desktop's
 * stage keeps its form.
 *
 * RE-POINTED (the switch's older tests, sorted once): the first run is the new frame's stage
 * (`_first-run-stage.tsx`) over the first-run wire a web host hands (`setupHref` and `resume`: the
 * hand-off's two verbs) or a desktop's (neither), its mailbox step the one connect form over a scripted wire whose
 * connects are counted; an add run stands at `#/first-run/add`. The form is found as a person finds it: the
 * password field a form shows, or, where the new form asks for a provider first, its provider tiles. Every
 * expectation is as it stood.
 */
const t = O;

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

type Door = "cloud" | "selfhost" | "local";

async function mount(o: { door: Door; web: boolean; add?: boolean }) {
  let resumes = 0;
  const wire = fakeDoor({ probe: [{ ok: true, value: { host: "h", user: "u", folders: 1 } }] });
  const verbs: Partial<FirstRunWire> = {
    ai: "on",
    ...(o.web ? { setupHref: "/join", resume: () => { resumes += 1; } } : {}),
  };
  const st = await mountStage({
    rows: [], door: o.door, connect: wire.door, verbs, ...(o.add ? { at: "#/first-run/add" } : {}),
  });
  const el = st.el;
  const press = async (label: string) => {
    const b = [...el.querySelectorAll("button")].find((x) => (x.textContent ?? "").includes(label));
    expect(b, `no "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  };
  // A first run opens on the welcome; its one verb walks on to the mailbox step.
  if (!o.add) await press(t.welcomeStart);
  return { el, press, resumes: () => resumes, connects: () => wire.of("connect").length };
}

/** The connect form, as a person meets it: a password field, or the provider tiles that come before it. */
const formOf = (el: HTMLElement): Element | null =>
  el.querySelector("input[type=password]") ?? el.querySelector('[role="group"] button');

describe("the mailbox step with no mailbox", () => {
  it("on the Cloud door is a hand-off to the setup page, not a form", async () => {
    const s = await mount({ door: "cloud", web: true });
    expect(s.el.querySelector("h1")?.textContent).toBe(t.mailboxTitle);
    expect(s.el.textContent).toContain(t.mailboxHandoffLead);
    expect(formOf(s.el), "the connect form is still here").toBeNull();
    await s.press(t.mailboxHandoffGo);
    expect(s.resumes()).toBe(1);
    expect(s.connects()).toBe(0);
  });

  it("on a self-hosted server too", async () => {
    const s = await mount({ door: "selfhost", web: true });
    expect(s.el.textContent).toContain(t.mailboxHandoffLead);
  });

  it("the desktop's stage keeps its form", async () => {
    const s = await mount({ door: "local", web: false });
    expect(s.el.textContent).not.toContain(t.mailboxHandoffLead);
    expect(formOf(s.el)).not.toBeNull();
  });

  it("an add run keeps its form: the setup page is for a first mailbox", async () => {
    const s = await mount({ door: "cloud", web: true, add: true });
    expect(s.el.textContent).not.toContain(t.mailboxHandoffLead);
    expect(formOf(s.el)).not.toBeNull();
  });
});
