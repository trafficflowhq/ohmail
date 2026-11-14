/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Answered,
  Connected,
  ConnectKept,
  ConnectTyped,
} from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE } from "../../../src/host/index.js";
import type { ConnectGuard, ConnectSubject } from "../../../src/mailboxes/connect/contract.js";
import { useConnectKept } from "../../../src/mailboxes/connect/index.js";
import {
  D,
  J,
  M,
  MARKER,
  O,
  P,
  REFUSED_PASSWORD,
  WINDOW_CLOSED,
  draw,
  fakeDoor,
  id,
  later,
  no,
  noEncryption,
  ownCertificate,
  refusal,
  MICROSOFT,
} from "./support.js";

/**
 * THE ONE CONNECT FORM over a wire double, driven as a person drives it: by role and name. What it sends is read off
 * the double; what it says is the catalogue's sentence.
 */
afterEach(cleanup);

const type = (label: string, value: string): void =>
  void fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string): void => void fireEvent.click(screen.getByRole("button", { name }));
const settle = (): Promise<void> => act(async () => {});
const A = "mail-a.home.arpa";
const B = "mail-b.home.arpa";
const C = "mail-c.home.arpa";
const ADDRESS = "me@lichtgrat.example";
const CONNECTED = { ok: true as const, value: { mailboxId: id("mbx-new"), address: ADDRESS } };
const SUBJECT: ConnectSubject = {
  id: id("mbx-7"),
  address: "old@lichtgrat.example",
  provider: "imap",
  signsIn: "password",
};
const SHA = `${"7A:".repeat(31)}7A`;
const SHA_NEW = `${"3C:".repeat(31)}3C`;

/** The join's form on the manual entry, filled. */
function fillJoin(imap = A, smtp = B): void {
  type(J.mailboxAddress, ADDRESS);
  press(P.otherLabel);
  type(J.imapHost, imap);
  type(J.smtpHost, smtp);
  type(J.appPasswordLabel, MARKER);
}
const body = (imap: object, smtp: object) => ({ provider: "imap", address: ADDRESS, imap, smtp });
const leg = (host: string, more: object = {}) => ({ host, user: ADDRESS, pass: MARKER, ...more });

describe("each purpose sends what its shipped form sent", () => {
  it("the join connects a first mailbox: the body as typed, the mode `seed`, and the wire's id in the answer", async () => {
    const { door, of } = fakeDoor({ connect: [CONNECTED] });
    const view = draw(door, { purpose: { kind: "join" } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    expect(of("connect").map((call) => call.sent)).toEqual([{ input: body(leg(A), leg(B)), mode: "seed" }]);
    expect(of("probe")).toEqual([]);
    expect(view.done).toEqual([
      { kind: "connected", mailboxId: id("mbx-new"), address: ADDRESS, created: true },
    ]);
  });

  it("the first run connects with `seed` and a further mailbox with `add`; neither is ever a default", async () => {
    for (const [kind, mode] of [
      ["firstRun", "seed"],
      ["add", "add"],
    ] as const) {
      const { door, of } = fakeDoor({ connect: [CONNECTED] });
      draw(door, { purpose: { kind } });
      type(O.address, ADDRESS);
      press(P.otherLabel);
      type(O.imapHost, A);
      type(O.smtpHost, B);
      type(O.password, MARKER);
      press(O.connect);
      await settle();
      expect(of("connect").map((call) => call.sent)).toEqual([{ input: body(leg(A), leg(B)), mode }]);
      cleanup();
    }
  });

  it("a test dials what the connect dials, field for field, and stores nothing", async () => {
    const { door, of } = fakeDoor({ probe: [{ ok: true, value: { host: A, user: ADDRESS, folders: 12 } }] });
    const view = draw(door, { purpose: { kind: "add" } });
    type(O.address, ADDRESS);
    press(P.otherLabel);
    type(O.imapHost, `${A}:1143`);
    type(O.smtpHost, B);
    type(O.user, "postbox7");
    type(O.password, MARKER);
    press(O.test);
    await settle();
    expect(of("probe").map((call) => call.sent)).toEqual([
      {
        provider: "imap",
        address: ADDRESS,
        imap: { host: A, port: 1143, user: "postbox7", pass: MARKER },
        smtp: { host: B, user: "postbox7", pass: MARKER },
      },
    ]);
    expect(of("connect")).toEqual([]);
    expect(view.done).toEqual([]);
    expect(screen.getByText(/answered\. Signed in as postbox7|answered\. Signed in as me@/)).toBeTruthy();
    expect((screen.getByLabelText(O.password) as HTMLInputElement).value).toBe(MARKER);
  });

  it("the join has no test: a press there is a connect", () => {
    const { door } = fakeDoor();
    draw(door, { purpose: { kind: "join" } });
    fillJoin();
    expect(screen.queryByRole("button", { name: O.test })).toBeNull();
  });

  it("an edit sends the password alone when nothing else was typed, for the mailbox it was opened for", async () => {
    const { door, of } = fakeDoor({ edit: [{ ok: true, value: null }] });
    const view = draw(door, { purpose: { kind: "edit", mailbox: SUBJECT } });
    expect(screen.getByRole("button", { name: M.continue })).toHaveProperty("disabled", true);
    type(M.passwordLabel, MARKER);
    press(M.continue);
    await settle();
    expect(of("edit").map((call) => call.sent)).toEqual([
      { mailboxId: "mbx-7", patch: { imap: { pass: MARKER } } },
    ]);
    expect(view.done).toEqual([{ kind: "saved", mailboxId: id("mbx-7") }]);
  });

  it("an edit with a port that is no port sends nothing and says so", async () => {
    const { door, calls } = fakeDoor();
    draw(door, { purpose: { kind: "edit", mailbox: SUBJECT } });
    type(M.passwordLabel, MARKER);
    type(M.imapPortLabel, "99999");
    press(M.continue);
    await settle();
    expect(calls.filter((call) => call.verb !== "ways")).toEqual([]);
    expect(screen.getByText(M.portInvalid)).toBeTruthy();
  });

  it("Cancel on an edit ends with `left` and sends nothing", () => {
    const { door, calls } = fakeDoor({ ways: "none" });
    const view = draw(door, { purpose: { kind: "edit", mailbox: SUBJECT } });
    type(M.passwordLabel, MARKER);
    press(M.cancel);
    expect(view.done).toEqual([{ kind: "left" }]);
    expect(calls).toEqual([]);
  });

  it("a shell with no edit draws no edit form", () => {
    const { door } = fakeDoor();
    draw({ ...door, edit: NONE }, { purpose: { kind: "edit", mailbox: SUBJECT } });
    expect(screen.queryByLabelText(M.passwordLabel)).toBeNull();
    expect(screen.queryByRole("button", { name: M.continue })).toBeNull();
  });
});

describe("a refusal stands at the press", () => {
  it("says its sentence, keeps every word typed and the password, and ends nothing", async () => {
    const { door } = fakeDoor({ connect: [REFUSED_PASSWORD] });
    const view = draw(door, { purpose: { kind: "join" } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    expect(screen.getByText(M.probe_auth)).toBeTruthy();
    expect((screen.getByLabelText(J.mailboxAddress) as HTMLInputElement).value).toBe(ADDRESS);
    expect((screen.getByLabelText(J.imapHost) as HTMLInputElement).value).toBe(A);
    expect((screen.getByLabelText(J.appPasswordLabel) as HTMLInputElement).value).toBe(MARKER);
    expect(view.done).toEqual([]);
  });

  it("a refusal nobody words is said in the server's own sentence", async () => {
    const { door } = fakeDoor({
      connect: [
        no(
          refusal(
            "validation_failed",
            { field: "u" },
            422,
            "That incoming (IMAP) server address could not be found. Check the host name for a typo.",
          ),
        ),
      ],
    });
    draw(door, { purpose: { kind: "join" } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    expect(
      screen.getByText(
        "That incoming (IMAP) server address could not be found. Check the host name for a typo.",
      ),
    ).toBeTruthy();
  });

  it("a form that left steps nothing: a late answer ends nothing and sends nothing", async () => {
    const answer = later<typeof CONNECTED>();
    const { door, calls } = fakeDoor({ connect: [answer.promise] });
    const view = draw(door, { purpose: { kind: "join" } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    const sent = calls.length;
    view.unmount();
    answer.resolve(CONNECTED);
    await settle();
    expect(view.done).toEqual([]);
    expect(calls).toHaveLength(sent);
  });
});

describe("whose browser this is, before every press that carries a credential", () => {
  it("a changed account sends nothing and says the wizard's sentence", async () => {
    const guard: ConnectGuard = { before: vi.fn(() => Promise.resolve(false)), said: null, clear: vi.fn() };
    const { door, calls } = fakeDoor({ connect: [CONNECTED] });
    const view = draw(door, { purpose: { kind: "join" }, guard });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    expect(guard.before).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.verb === "connect")).toEqual([]);
    view.redraw({ guard: { ...guard, said: "This browser is signed in to another account now." } });
    expect(screen.getByText("This browser is signed in to another account now.")).toBeTruthy();
    expect(view.done).toEqual([]);
  });

  it("is asked again before the press a verified factor sends", async () => {
    const before = vi.fn(() => Promise.resolve(true));
    const { door, of } = fakeDoor({ connect: [WINDOW_CLOSED, CONNECTED] });
    draw(door, { purpose: { kind: "join" }, guard: { before, said: null, clear: () => undefined } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    press("verify");
    await settle();
    expect(before).toHaveBeenCalledTimes(2);
    expect(of("connect")).toHaveLength(2);
  });
});

describe("a consent is a press, for one server", () => {
  it("is never drawn until the server offered it for this press, and then stands unticked", async () => {
    const { door, of } = fakeDoor({ connect: [noEncryption("imap"), CONNECTED] });
    draw(door, { purpose: { kind: "join" } });
    fillJoin();
    expect(screen.queryByRole("switch")).toBeNull();
    press(J.connectMailbox);
    await settle();
    const line = screen.getByRole("switch", { name: M.insecureConsentLabel });
    expect(line.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(M.insecureConsentWarning)).toBeTruthy();
    expect(of("connect")[0]!.sealed).not.toContain("allowInsecure");
    fireEvent.click(line);
    press(J.connectMailbox);
    await settle();
    expect(of("connect")[1]!.sent).toEqual({
      input: body(leg(A, { allowInsecure: true }), leg(B)),
      mode: "seed",
    });
  });

  it("a new host withdraws the line and the tick, and the old host typed again is asked again", async () => {
    const { door, of } = fakeDoor({ connect: [noEncryption("imap"), CONNECTED] });
    draw(door, { purpose: { kind: "join" } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: M.insecureConsentLabel }));
    type(J.imapHost, B);
    expect(screen.queryByRole("switch")).toBeNull();
    type(J.imapHost, A);
    expect(screen.queryByRole("switch")).toBeNull();
    press(J.connectMailbox);
    await settle();
    expect(of("connect")[1]!.sealed).not.toContain("allowInsecure");
  });

  it("a new provider withdraws it too", async () => {
    const { door } = fakeDoor({ connect: [noEncryption("smtp")] });
    draw(door, { purpose: { kind: "join" } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    expect(screen.getByRole("switch", { name: M.insecureConsentLabelSmtp })).toBeTruthy();
    press("Gmail");
    press(P.otherLabel);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("one host for both servers is one line for both, and one tick claims both", async () => {
    const { door, of } = fakeDoor({ connect: [noEncryption("imap"), CONNECTED] });
    draw(door, { purpose: { kind: "join" } });
    fillJoin(A, A);
    press(J.connectMailbox);
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: M.insecureConsentLabelBoth }));
    press(J.connectMailbox);
    await settle();
    expect(of("connect")[1]!.sent).toEqual({
      input: body(leg(A, { allowInsecure: true }), leg(A, { allowInsecure: true })),
      mode: "seed",
    });
  });

  it("a certificate is trusted by the fingerprint shown, and one that changed stands unticked again", async () => {
    const { door, of } = fakeDoor({
      connect: [ownCertificate("imap", SHA), ownCertificate("imap", SHA_NEW), CONNECTED],
    });
    draw(door, { purpose: { kind: "add" } });
    type(O.address, ADDRESS);
    press(P.otherLabel);
    type(O.imapHost, A);
    type(O.smtpHost, B);
    type(O.password, MARKER);
    press(O.connect);
    await settle();
    const first = screen.getByRole("switch", { name: M.trustCertificateLabel.replace("{fingerprint}", SHA) });
    fireEvent.click(first);
    expect(first.getAttribute("aria-checked")).toBe("true");
    press(O.connect);
    await settle();
    expect(of("connect")[1]!.sent).toMatchObject({ input: { imap: { trustCertificate: SHA } } });
    const changed = screen.getByRole("switch", {
      name: M.trustCertificateLabel.replace("{fingerprint}", SHA_NEW),
    });
    expect(changed.getAttribute("aria-checked")).toBe("false");
    press(O.connect);
    await settle();
    expect(of("connect")[2]!.sealed).not.toContain("trustCertificate");
  });
});

describe("the second factor, asked in place and once", () => {
  it("is asked only on the server's refusal, with the form's own line; verified, the same connect runs once more", async () => {
    const { door, of } = fakeDoor({ connect: [WINDOW_CLOSED, CONNECTED] });
    const view = draw(door, { purpose: { kind: "join" } });
    fillJoin();
    expect(screen.queryByRole("dialog")).toBeNull();
    press(J.connectMailbox);
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(view.asks.at(-1)!.line).toBe(M.factorBody);
    press("verify");
    await settle();
    const sent = of("connect");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.sent).toEqual(sent[0]!.sent);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.done).toHaveLength(1);
  });

  it("refused again right after the factor: the sign-in sentence, and no second dialog", async () => {
    const { door, of } = fakeDoor({ connect: [WINDOW_CLOSED, WINDOW_CLOSED] });
    draw(door, { purpose: { kind: "add" } });
    type(O.address, ADDRESS);
    press("Gmail");
    type(O.password, MARKER);
    press(O.connect);
    await settle();
    press("verify");
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(D.stepUpExpired)).toBeTruthy();
    expect(of("connect")).toHaveLength(2);
  });

  it("Cancel sends nothing more and keeps what was typed; a factor that lands after it says nothing ran", async () => {
    const { door, of } = fakeDoor({ connect: [WINDOW_CLOSED] });
    const view = draw(door, { purpose: { kind: "join" } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    const late = view.asks.at(-1)!;
    press("cancel");
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => late.onVerified());
    await settle();
    expect(of("connect")).toHaveLength(1);
    expect((screen.getByLabelText(J.appPasswordLabel) as HTMLInputElement).value).toBe(MARKER);
    act(() => late.onDiscarded());
    expect(screen.getByText(D.stepUpCancelledNothingRan)).toBeTruthy();
  });

  it("typing while it is asked withdraws the waiting press: the dialog goes and a late factor sends nothing", async () => {
    const { door, of } = fakeDoor({ connect: [WINDOW_CLOSED] });
    const view = draw(door, { purpose: { kind: "join" } });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    const late = view.asks.at(-1)!;
    type(J.appPasswordLabel, `${MARKER}x`);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => late.onVerified());
    await settle();
    expect(of("connect")).toHaveLength(1);
  });

  it("a consent withdrawn while the press is on its way is not sent by the factor's re-send: no factor is asked, and nothing ran", async () => {
    const second = later<Answered<Connected>>();
    const { door, of } = fakeDoor({ connect: [noEncryption("imap"), second.promise] });
    draw(door, { purpose: { kind: "join" } });
    fillJoin(A, A);
    press(J.connectMailbox);
    await settle();
    const line = (): HTMLElement => screen.getByRole("switch", { name: M.insecureConsentLabelBoth });
    fireEvent.click(line());
    press(J.connectMailbox);
    await settle();
    expect(of("connect")).toHaveLength(2);
    expect(of("connect")[1]!.sealed).toContain("allowInsecure");
    // The person withdraws the consent while the press is still on its way.
    fireEvent.click(line());
    expect(line().getAttribute("aria-checked")).toBe("false");
    // The server then asks for the second factor.
    await act(async () => second.resolve(WINDOW_CLOSED));
    await settle();
    const asked = screen.queryByRole("dialog") !== null;
    if (asked) {
      press("verify");
      await settle();
    }
    const resentWithConsent = of("connect")
      .slice(2)
      .filter((call) => call.sealed.includes("allowInsecure")).length;
    expect({ asked, resentWithConsent, lineNow: line().getAttribute("aria-checked") }).toEqual({
      asked: false,
      resentWithConsent: 0,
      lineNow: "false",
    });
    // Nothing ran, said as the join says it; the next press tries the form as it stands.
    expect(screen.getByText(D.stepUpCancelledNothingRan)).toBeTruthy();
    press(J.connectMailbox);
    await settle();
    expect(of("connect")).toHaveLength(3);
    expect(of("connect")[2]!.sealed).not.toContain("allowInsecure");
  });

  it("a host corrected while the press is on its way is never sent the password by the factor's re-send", async () => {
    const first = later<Answered<Connected>>();
    const { door, of } = fakeDoor({ connect: [first.promise] });
    draw(door, { purpose: { kind: "join" } });
    fillJoin(A, B);
    press(J.connectMailbox);
    await settle();
    expect(of("connect")).toHaveLength(1);
    // The person corrects the incoming server while the press is still on its way.
    type(J.imapHost, C);
    await act(async () => first.resolve(WINDOW_CLOSED));
    await settle();
    const asked = screen.queryByRole("dialog") !== null;
    if (asked) {
      press("verify");
      await settle();
    }
    const dialled = (call: { sent: unknown }): string =>
      (call.sent as { input: { imap: { host: string } } }).input.imap.host;
    const toTheOldHost = of("connect")
      .slice(1)
      .filter((call) => dialled(call) === A).length;
    expect({ asked, toTheOldHost }).toEqual({ asked: false, toTheOldHost: 0 });
    expect(screen.getByText(D.stepUpCancelledNothingRan)).toBeTruthy();
    // What was typed stands, the password too; the next press dials the corrected host.
    expect((screen.getByLabelText(J.appPasswordLabel) as HTMLInputElement).value).toBe(MARKER);
    press(J.connectMailbox);
    await settle();
    expect(of("connect").map(dialled)).toEqual([A, C]);
  });

  it("a change while the press a verified factor sent is on its way asks nothing new: refused again, it is the sign-in sentence", async () => {
    const again = later<Answered<Connected>>();
    const { door, of } = fakeDoor({ connect: [WINDOW_CLOSED, again.promise] });
    draw(door, { purpose: { kind: "add" } });
    type(O.address, ADDRESS);
    press("Gmail");
    type(O.password, MARKER);
    press(O.connect);
    await settle();
    press("verify");
    await settle();
    type(O.address, `x${ADDRESS}`);
    await act(async () => again.resolve(WINDOW_CLOSED));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(D.stepUpExpired)).toBeTruthy();
    expect(of("connect")).toHaveLength(2);
  });

  it("with no dialog to ask, the refusal says sign in again and nothing waits", async () => {
    const { door, of } = fakeDoor({ connect: [WINDOW_CLOSED] });
    draw(door, { purpose: { kind: "join" } }, { factor: NONE });
    fillJoin();
    press(J.connectMailbox);
    await settle();
    expect(screen.getByText(J.stepUpExpired)).toBeTruthy();
    expect(of("connect")).toHaveLength(1);
  });

  it("a test parks with its own line, and its factor re-runs the test, never a connect", async () => {
    const { door, of } = fakeDoor({
      probe: [WINDOW_CLOSED, { ok: true, value: { host: A, user: ADDRESS, folders: 2 } }],
    });
    const view = draw(door, { purpose: { kind: "add" } });
    type(O.address, ADDRESS);
    press("Gmail");
    type(O.password, MARKER);
    press(O.test);
    await settle();
    expect(view.asks.at(-1)!.line).toBe(O.mailboxStepUp);
    press("verify");
    await settle();
    expect(of("probe")).toHaveLength(2);
    expect(of("connect")).toEqual([]);
  });
});

describe("a provider that signs in", () => {
  const OPEN = { microsoft: { redirect: true, device: false } } as const;

  it("is shut until read: the password form stands, and nothing offers a sign-in", async () => {
    const { door } = fakeDoor({ ways: { microsoft: { redirect: false, device: false } } });
    draw(door, { purpose: { kind: "join" } });
    type(J.mailboxAddress, ADDRESS);
    press(MICROSOFT);
    await settle();
    expect(screen.queryByRole("button", { name: M.oauthContinue })).toBeNull();
    expect(screen.getByLabelText(J.appPasswordLabel)).toBeTruthy();
  });

  it("where the shell runs it, the tile signs in: no password field, and one press leaves for the provider", async () => {
    const { door, of, stillWanted } = fakeDoor({ ways: OPEN, start: [{ ok: true, value: "leaving" }] });
    const view = draw(door, { purpose: { kind: "join" } });
    await settle();
    press(MICROSOFT);
    expect(screen.queryByLabelText(J.appPasswordLabel)).toBeNull();
    expect(screen.getByText(M.microsoftOauthNote)).toBeTruthy();
    expect(of("start")).toEqual([]);
    press(M.oauthContinue);
    await settle();
    expect(of("start").map((call) => call.sent)).toEqual([{ provider: "microsoft", purpose: "join" }]);
    expect(stillWanted[0]!()).toBe(true);
    expect(screen.getByRole("button", { name: M.oauthContinue })).toHaveProperty("disabled", true);
    expect(view.done).toEqual([]);
  });

  it("a press retired by a new choice records nothing and leaves nowhere", async () => {
    const answer = later<{ ok: true; value: "leaving" }>();
    const { door, stillWanted } = fakeDoor({ ways: OPEN, start: [answer.promise] });
    draw(door, { purpose: { kind: "join" } });
    await settle();
    press(MICROSOFT);
    press(M.oauthContinue);
    await settle();
    press("Gmail");
    expect(stillWanted[0]!()).toBe(false);
  });

  it("offers the password way as a second press, and a fresh choice of the tile offers the sign-in first again", async () => {
    const { door } = fakeDoor({ ways: OPEN });
    draw(door, { purpose: { kind: "join" } });
    await settle();
    press(MICROSOFT);
    press(M.microsoftUseAppPassword);
    expect(screen.getByLabelText(J.appPasswordLabel)).toBeTruthy();
    press(MICROSOFT);
    expect(screen.queryByLabelText(J.appPasswordLabel)).toBeNull();
  });

  it("a sign-in that came back refused is said, its tile chosen, and never started again without a press", async () => {
    const { door, of } = fakeDoor({
      ways: OPEN,
      returned: { kind: "refused", reason: "admin_consent_required" },
    });
    draw(door, { purpose: { kind: "join" } });
    await settle();
    expect(screen.getByText(M.oauth_admin_consent_required)).toBeTruthy();
    expect(screen.getByRole("button", { name: MICROSOFT }).getAttribute("aria-pressed")).toBe("true");
    expect(of("start")).toEqual([]);
    expect(of("begin")).toEqual([]);
  });

  it("a failed return on the join is said in the wizard's words", async () => {
    const { door } = fakeDoor({
      ways: OPEN,
      returned: { kind: "failed", reason: "no_refresh_token", message: "Start again from Settings." },
    });
    draw(door, { purpose: { kind: "join" } });
    await settle();
    expect(screen.getByText(J.mailboxOauth_no_refresh_token)).toBeTruthy();
  });

  it("a reconnect of a mailbox that signs in at its provider takes no password, and names the mailbox to the provider", async () => {
    const { door, of } = fakeDoor({ ways: OPEN, start: [{ ok: true, value: "leaving" }] });
    draw(door, {
      purpose: { kind: "reconnect", mailbox: { ...SUBJECT, provider: "microsoft", signsIn: "provider" } },
    });
    await settle();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    press(M.oauthReconnect);
    await settle();
    expect(of("start").map((call) => call.sent)).toEqual([
      { provider: "microsoft", purpose: "reconnect", mailboxId: "mbx-7" },
    ]);
  });

  it("a shell with no sign-in at all draws none, whatever the tile", async () => {
    const { door, calls } = fakeDoor({ ways: "none" });
    draw(door, { purpose: { kind: "add" } });
    await settle();
    press(MICROSOFT);
    expect(screen.queryByRole("button", { name: M.oauthContinue })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("what was typed survives a trip to another step, the password apart", () => {
  it("a caller that outlives the form hands the words back; the password is typed again", () => {
    const { door } = fakeDoor();
    let held: ConnectTyped | null = null;
    const kept: ConnectKept = { read: () => held, write: (typed) => void (held = typed) };
    const first = draw(door, { purpose: { kind: "join" }, kept });
    fillJoin();
    first.unmount();
    expect(held).toMatchObject({ address: ADDRESS, provider: "imap", imapHost: A, smtpHost: B });
    expect(JSON.stringify(held)).not.toContain("MARKER");
    draw(door, { purpose: { kind: "join" }, kept });
    expect((screen.getByLabelText(J.mailboxAddress) as HTMLInputElement).value).toBe(ADDRESS);
    expect((screen.getByLabelText(J.imapHost) as HTMLInputElement).value).toBe(A);
    expect((screen.getByLabelText(J.appPasswordLabel) as HTMLInputElement).value).toBe("");
  });

  it("the holder a wizard keeps is one object for its whole life, in memory alone", () => {
    const seen: ConnectKept[] = [];
    function Wizard(): null {
      seen.push(useConnectKept());
      return null;
    }
    const view = render(<Wizard />);
    view.rerender(<Wizard />);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]!.read()).toBeNull();
    const typed = { address: ADDRESS } as ConnectTyped;
    seen[0]!.write(typed);
    expect(seen[1]!.read()).toBe(typed);
  });
});
