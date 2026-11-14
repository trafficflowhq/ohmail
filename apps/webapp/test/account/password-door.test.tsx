/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, GatedAsk } from "@ohmail/app/account";
import {
  catchConsole,
  en,
  foundIn,
  json,
  OFFLINE,
  refusal,
  serve,
  settle,
  Words,
  type Server,
} from "./account-harness";
import { PasswordForm, usePassword } from "../../../../packages/app/src/account/account/password-entry.js";
import { ApiError } from "../../app/api-client";
import { passwordRefusal, usePasswordDoor } from "../../app/(product)/mailbox/password-door";

/**
 * THE PASSWORD CHANGE OVER THE WEB'S REAL FILLING and a server that records what it is asked. What was typed is
 * checked first and a failed check sends nothing; the change is one request whose body is the two typed values; a
 * wrong current one and a lock are read before the gate's words; only the server's refusal asks the factor, and the
 * verified factor sends the same change once. Every attempt empties the three blanks, and the typed values are
 * nowhere but in that request's body.
 */

const CHANGE = "POST /api/auth/password";
const REFRESH = "POST /auth/refresh";
const STEP_UP = () => refusal(403, "step_up_required");

/* What a person types. Each is unlike the other and unlike any sentence, so a kept copy is found by its letters. */
const CURRENT = "kestrel-over-the-quarry-41";
const NEXT = "nine-lamps-in-a-wet-harbour";
/** One character outside the basic plane: two code units, one code point. */
const ASTRAL = "\u{1F511}";

let server: Server;
let written: ReturnType<typeof catchConsole>;
const slot = { asked: null as GatedAsk | null };
/** The factor's dialog, stood in for: its ceremony is the doors' own. What is held here is what the form asks. */
const factor: FactorSlot = (ask) => {
  slot.asked = ask;
  return <p>the factor is asked: {ask.line}</p>;
};
const factorAsked = () => screen.queryByText(/the factor is asked/) !== null;

beforeEach(() => {
  slot.asked = null;
  written = catchConsole();
  server = serve({ [CHANGE]: () => json({ revoked: 2 }) });
});
afterEach(() => {
  cleanup();
  server.restore();
  written.restore();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function Form() {
  return <PasswordForm model={usePassword(usePasswordDoor())} factor={factor} />;
}
const opened = () =>
  render(
    <Words>
      <Form />
    </Words>,
  );
const blank = (key: "currentLabel" | "nextLabel" | "repeatLabel") =>
  screen.getByLabelText(en.passwordChange[key]) as HTMLInputElement;
const blanks = () => [blank("currentLabel"), blank("nextLabel"), blank("repeatLabel")];
const said = (sentence: string): boolean => (document.body.textContent ?? "").includes(sentence);
/** The three blanks typed into, and Change pressed. */
async function attempt(current = CURRENT, next = NEXT, again = next) {
  await act(async () => {
    fireEvent.change(blank("currentLabel"), { target: { value: current } });
    fireEvent.change(blank("nextLabel"), { target: { value: next } });
    fireEvent.change(blank("repeatLabel"), { target: { value: again } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en.passwordChange.submit }));
  });
  await settle();
}
const sentBodies = () => server.on(CHANGE).map((s) => s.body);
const TYPED = { currentPassword: CURRENT, newPassword: NEXT };

describe("a refused change, as its word", () => {
  const say = (): string => "said by the renderer";
  const word = (err: unknown) => passwordRefusal(err, say);
  const locked = (details?: unknown) => new ApiError(423, "account_locked", "x", details);

  it("reads a wrong current one and a lock before the gate's words", () => {
    expect(word(new ApiError(401, "credential_refused", "x"))).toEqual({ ok: false, word: "wrong_current" });
    expect(word(locked({ retryAfter: 600 }))).toEqual({ ok: false, word: "locked", minutes: 10 });
    expect(word(locked({ retryAfter: 61 }))).toEqual({ ok: false, word: "locked", minutes: 2 });
    expect(word(locked())).toEqual({ ok: false, word: "locked", minutes: 15 });
    expect(word(locked({ retryAfter: 0 }))).toEqual({ ok: false, word: "locked", minutes: 15 });
  });

  it("then the gate: the factor for a closed window, the way back in for a dead session or an open enrolment", () => {
    expect(word(new ApiError(403, "step_up_required", "x"))).toEqual({ ok: false, word: "factor" });
    expect(word(new ApiError(401, "unauthorized", "x"))).toEqual({ ok: false, word: "sign_in" });
    expect(word(new ApiError(403, "enrollment_incomplete", "x"))).toEqual({ ok: false, word: "sign_in" });
  });

  it("then a request no server answered, the throttle, a change made elsewhere, and any other refusal", () => {
    expect(word(new Error("x"))).toEqual({ ok: false, word: "said", said: "said by the renderer" });
    expect(word(new ApiError(0, "network_unreachable", "x"))).toEqual({
      ok: false,
      word: "said",
      said: "said by the renderer",
    });
    expect(word(new ApiError(429, "sign_in_slowed", "x"))).toEqual({ ok: false, word: "slowed" });
    expect(word(new ApiError(409, "conflict", "x"))).toEqual({ ok: false, word: "conflict" });
    expect(word(new ApiError(403, "forbidden", "x"))).toEqual({ ok: false, word: "refused" });
    expect(word(new ApiError(500, "internal", "x"))).toEqual({ ok: false, word: "refused" });
  });
});

describe("the change", () => {
  it("drawing the form asks nothing", async () => {
    opened();
    await settle();
    expect(server.asked()).toEqual([]);
  });

  it("is one request whose body is the two typed values, and says how many sessions it ended", async () => {
    opened();
    await attempt();
    expect(server.asked()).toEqual([`${CHANGE} {currentPassword,newPassword}`]);
    expect(sentBodies()).toEqual([TYPED]);
    expect(said("2 other sessions were signed out")).toBe(true);
    expect(blanks().map((b) => b.value)).toEqual(["", "", ""]);
  });

  it("a check that fails is said, empties the blanks and sends nothing", async () => {
    opened();
    await attempt("", NEXT);
    expect(said(en.passwordChange.needCurrent)).toBe(true);
    await attempt(CURRENT, NEXT, `${NEXT}x`);
    expect(said(en.passwordChange.mismatch)).toBe(true);
    await attempt(CURRENT, "too-short-1");
    expect(said(en.passwordChange.tooShort)).toBe(true);
    await attempt(CURRENT, CURRENT);
    expect(said(en.passwordChange.same)).toBe(true);
    expect(blanks().map((b) => b.value)).toEqual(["", "", ""]);
    expect(server.asked()).toEqual([]);
  });

  it("counts the new one in characters as a person counts them: twelve pass, eleven do not", async () => {
    opened();
    await attempt(CURRENT, ASTRAL.repeat(11));
    expect(said(en.passwordChange.tooShort)).toBe(true);
    expect(server.asked()).toEqual([]);
    await attempt(CURRENT, ASTRAL.repeat(12));
    expect(server.on(CHANGE)).toHaveLength(1);
    expect(said(en.passwordChange.tooShort)).toBe(false);
  });

  it("a wrong current one is said in place: no renewal, no second request, no dialog, the blanks empty", async () => {
    server.answer(CHANGE, refusal(401, "credential_refused"));
    opened();
    await attempt();
    expect(said(en.passwordChange.wrongCurrent)).toBe(true);
    expect(said(en.devices.stepUpExpired)).toBe(false);
    expect(server.on(REFRESH)).toHaveLength(0);
    expect(server.on(CHANGE)).toHaveLength(1);
    expect(factorAsked()).toBe(false);
    expect(blanks().map((b) => b.value)).toEqual(["", "", ""]);
  });

  it("a lock says how long to wait", async () => {
    server.answer(CHANGE, refusal(423, "account_locked", { retryAfter: 600 }));
    opened();
    await attempt();
    expect(said("Try again in 10 minutes")).toBe(true);
    expect(factorAsked()).toBe(false);
  });

  it("a request that never reached the server is said by the shell's own sentence", async () => {
    server.answer(CHANGE, OFFLINE, OFFLINE, OFFLINE);
    opened();
    await attempt();
    // The shell's own sentence, said over the form's answer; the page's other announcers stay silent.
    expect(screen.getAllByRole("status").filter((line) => line.textContent !== "")).toHaveLength(1);
    expect(said(en.passwordChange.refused)).toBe(false);
    expect(said("other session")).toBe(false);
  });
});

describe("the change, guarded by the factor", () => {
  it("is tried as it is; the refusal asks the factor under its line; nothing more leaves before it verifies; then once more, the same", async () => {
    server.answer(CHANGE, STEP_UP());
    opened();
    await attempt();
    expect(server.on(CHANGE)).toHaveLength(1);
    expect(said(`the factor is asked: ${en.passwordChange.factorBody}`)).toBe(true);
    expect(blanks().map((b) => b.value)).toEqual(["", "", ""]);
    await settle();
    expect(server.on(CHANGE)).toHaveLength(1);
    await act(async () => slot.asked!.onVerified());
    await settle();
    expect(sentBodies()).toEqual([TYPED, TYPED]);
    expect(factorAsked()).toBe(false);
    expect(said("2 other sessions were signed out")).toBe(true);
  });

  it("refused again after the factor: the way back in, no second dialog, no third request", async () => {
    server.answer(CHANGE, STEP_UP(), STEP_UP());
    opened();
    await attempt();
    await act(async () => slot.asked!.onVerified());
    await settle();
    expect(server.on(CHANGE)).toHaveLength(2);
    expect(factorAsked()).toBe(false);
    expect(said(en.devices.stepUpExpired)).toBe(true);
  });

  it("Cancel sends nothing more; a factor that lands after it says nothing was changed", async () => {
    server.answer(CHANGE, STEP_UP());
    opened();
    await attempt();
    const asked = slot.asked!;
    await act(async () => asked.onCancel());
    expect(factorAsked()).toBe(false);
    await act(async () => asked.onDiscarded());
    await act(async () => asked.onVerified());
    await settle();
    expect(server.on(CHANGE)).toHaveLength(1);
    expect(said(en.passwordChange.cancelled)).toBe(true);
  });

  it("after a refusal, a factor said later sends nothing", async () => {
    server.answer(CHANGE, STEP_UP(), refusal(401, "credential_refused"));
    opened();
    await attempt();
    const asked = slot.asked!;
    await act(async () => asked.onVerified());
    await settle();
    expect(said(en.passwordChange.wrongCurrent)).toBe(true);
    await act(async () => asked.onVerified());
    await settle();
    expect(server.on(CHANGE)).toHaveLength(2);
  });

  it("a form left while the factor is asked sends nothing afterwards", async () => {
    server.answer(CHANGE, STEP_UP());
    const view = opened();
    await attempt();
    const asked = slot.asked!;
    view.unmount();
    server.forget();
    await act(async () => asked.onVerified());
    await settle();
    expect(server.asked()).toEqual([]);
  });
});

describe("where the typed values are", () => {
  const SECRETS = [CURRENT, NEXT];
  const nowhere = () => {
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    for (const secret of SECRETS) expect(document.body.innerHTML).not.toContain(secret);
  };

  it("in the request's body alone: after a refusal, while the factor is asked, and after the change lands", async () => {
    server.answer(CHANGE, refusal(401, "credential_refused"), STEP_UP());
    opened();
    await attempt();
    nowhere();
    await attempt();
    expect(factorAsked()).toBe(true);
    nowhere();
    await act(async () => slot.asked!.onVerified());
    await settle();
    nowhere();
    expect(sentBodies()).toEqual([TYPED, TYPED, TYPED]);
  });
});
