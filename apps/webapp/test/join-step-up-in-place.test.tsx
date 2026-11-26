/** @vitest-environment jsdom */
/**
 * THE STEP-UP WINDOW CLOSES WHERE PEOPLE LEAVE. `POST /mailboxes` wants a second factor from the last
 * five minutes, and making an app password takes longer than that. The mailbox step used to end on
 * "That took a little too long — sign in again", whose `/login` forwarded the still-signed-in browser
 * to an empty Ohbox with the setup gone. Now the factor is asked for in place (Settings' own prompt),
 * the very connect that was refused is sent again once, and everything typed stays; a second refusal
 * right after a verified factor is the sign-in screen, and its link resumes `/join`.
 */
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import { fixture, MAILBOX_DTO, mountJoin, signInFrom, STEP_UP, unmountJoin } from "./join-step-up-fixture.js";
import { mailboxProbes } from "./join-mailbox-probes.js";

async function atTheMailboxStep() {
  const { host, act, settle } = await mountJoin();
  /* The step is the one connect form, and the second factor is asked by the one dialog: the form's fields by their
     labels, the dialog by its role, its code field by its label, its presses by their words (a key's hint aside). */
  const probes = mailboxProbes(host, en, act);
  const prompt = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const codeField = (): HTMLInputElement | null => {
    const label = [...(prompt()?.querySelectorAll("label") ?? [])].find((l) => l.textContent === en.stepUp.codeLabel);
    return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : null;
  };
  const type = async (id: string, value: string) => {
    const input = id === "stepup-code" ? codeField() : probes.input(id);
    expect(input, `#${id} is not on screen`).toBeTruthy();
    await probes.typeInto(input, value, id);
  };
  const press = async (label: string, scope: ParentNode = host) => {
    const buttons = [...scope.querySelectorAll("button")];
    const button = buttons.find((b) => b.textContent === label) ?? buttons.find((b) => b.textContent?.startsWith(label));
    expect(button, `no "${label}" button`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const h1 = () => (host.querySelector("[data-page-filling-form] h1") ?? host.querySelector("h1"))?.textContent ?? "";
  const value = (id: string) => probes.input(id)?.value ?? null;
  const connectButton = () => probes.button(en.join.manualConnect);

  expect(h1().trim()).toBe(en.onboarding.providerFirst);
  await probes.choose(en.providerPicker.otherShort);
  expect(h1()).toBe(en.join.manualTitle);
  await type("join-mb-address", "pat@family.example");
  await type("join-imap", "mail.family.example");
  await type("join-smtp", "smtp.family.example");
  await type("join-mb-pass", "app-password-fixture");
  return { host, type, press, h1, prompt, value, connectButton, settle };
}

describe("the mailbox step asks for the second factor in place", () => {
  it("a closed window opens the prompt; the verified code re-sends the same connect once; the step ends connected", async () => {
    fixture.creates = [{ status: 403, body: STEP_UP }, { status: 201, body: MAILBOX_DTO }];
    const ui = await atTheMailboxStep();
    await ui.press(en.join.manualConnect);

    expect(ui.h1(), "the refusal is not the sign-in screen").toBe(en.join.manualTitle);
    expect(ui.prompt(), "the step-up prompt is on screen").toBeTruthy();
    expect(ui.value("join-mb-pass"), "the typed password is still there").toBe("app-password-fixture");
    expect(ui.connectButton()?.disabled, "Connect waits for the factor").toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(ui.prompt()!.contains(document.activeElement), "focus is not in the prompt").toBe(true);

    await ui.type("stepup-code", "123456");
    await ui.press(en.stepUp.verify, ui.prompt()!);

    expect(fixture.stepUps).toEqual([{ code: "123456" }]);
    expect(fixture.createBodies, "exactly the refused connect, sent again once").toHaveLength(2);
    expect(fixture.createBodies[1]).toEqual(fixture.createBodies[0]);
    expect(ui.h1()).toBe(en.join.myMailboxes.replace(/\.$/, ""));
  });

  it("Cancel keeps everything typed and sends nothing more", async () => {
    fixture.creates = [{ status: 403, body: STEP_UP }];
    const ui = await atTheMailboxStep();
    await ui.press(en.join.manualConnect);
    expect(ui.prompt()).toBeTruthy();
    await ui.press(en.stepUp.cancel, ui.prompt()!);
    expect(ui.prompt()).toBeNull();
    expect(fixture.createBodies).toHaveLength(1);
    expect(ui.h1()).toBe(en.join.manualTitle);
    expect(ui.value("join-mb-address")).toBe("pat@family.example");
    expect(ui.value("join-imap")).toBe("mail.family.example");
    expect(ui.value("join-mb-pass")).toBe("app-password-fixture");
    expect(ui.connectButton()?.disabled).toBe(false);
  });

  it("a second refusal right after a verified factor is the sign-in screen, and its link resumes /join", async () => {
    fixture.creates = [{ status: 403, body: STEP_UP }];
    const ui = await atTheMailboxStep();
    await ui.press(en.join.manualConnect);
    await ui.type("stepup-code", "123456");
    await ui.press(en.stepUp.verify, ui.prompt()!);
    expect(fixture.createBodies).toHaveLength(2);
    expect(ui.h1()).toBe(en.join.expiredTitle);
    const signIn = [...ui.host.querySelectorAll("a")].find((a) => a.textContent === en.join.signIn);
    expect(signIn?.getAttribute("href")).toBe("/login?next=join&fresh=1");
    const retry = new URL(signIn!.getAttribute("href")!, "https://example.test").href;
    await unmountJoin();

    expect(await signInFrom(retry)).toEqual(["/join"]);
    expect(fixture.recentFactor).toBe(true);
    const { host } = await mountJoin();
    expect(host.querySelector("h1")?.textContent?.trim()).toBe(en.onboarding.providerFirst);
    expect(fixture.codesRequests).toEqual([]);
  });
});

describe("the trial mail's button, for an account that never connected a mailbox", () => {
  it("signs in, resumes the wizard on the mailbox step, and a closed step-up window is asked for in place", async () => {
    fixture.signedIn = false;
    // The link as MailService renders it on Cloud (`mail-service.test.ts` holds it there).
    const left = await signInFrom("https://ohmail.app/login?next=join");
    expect(left, "the sign-in continues to the wizard").toEqual(["/join"]);
    expect(fixture.routed, "and not to the app's empty Ohbox").toEqual([]);

    fixture.creates = [{ status: 403, body: STEP_UP }, { status: 201, body: MAILBOX_DTO }];
    const ui = await atTheMailboxStep();
    await ui.press(en.join.manualConnect);
    expect(ui.prompt(), "the factor is asked for on the step, not a dead end").toBeTruthy();
    await ui.type("stepup-code", "123456");
    await ui.press(en.stepUp.verify, ui.prompt()!);
    expect(fixture.createBodies).toHaveLength(2);
    expect(ui.h1()).toBe(en.join.myMailboxes.replace(/\.$/, ""));
  });
});
