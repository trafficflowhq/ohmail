/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE STEP-UP DIALOG ON THE WEB'S OWN DOOR, over a recorded wire: it reads the factors once and sends one verify per
 * press, nothing else; it signs nobody in or out, and leaves the cookies, both storages and the address as they were.
 * The server's refusals arrive as the words the prompt said them by.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
/* The server client reads its base as it loads: the binding is asked for once the base is set. */
let StepUp: typeof import("../app/(product)/mailbox/StepUp").StepUp;
beforeAll(async () => {
  ({ StepUp } = await import("../app/(product)/mailbox/StepUp"));
});

const SESSION = "GET /api/auth/session";
const TOTP = "POST /api/auth/step-up/totp";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let wire: string[] = [];
let answer: (line: string) => Response;
let originalFetch: typeof globalThis.fetch;

function session(totp = true): Response {
  return json(200, {
    user: { id: "u1", accountId: "acct-1", email: "a@example.test", twofaEnrolled: { webauthn: false, totp, recoveryCodes: true } },
    scope: "full",
  });
}

function draw(messages: typeof en | typeof de = en, locale: "en" | "de" = "en") {
  const hands = { onVerified: vi.fn(), onCancel: vi.fn(), onDiscarded: vi.fn(), onOwnerAbsent: vi.fn() };
  render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <StepUp {...hands} />
    </NextIntlClientProvider>,
  );
  return hands;
}

const settle = () => act(async () => {});
const W = en.stepUp;

async function typeAndVerify(code: string): Promise<void> {
  await settle();
  fireEvent.change(screen.getByRole("textbox", { name: W.codeLabel }), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(W.verify) }));
  await settle();
}

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  wire = [];
  answer = (line) => (line === SESSION ? session() : line === TOTP ? json(200, { ok: true }) : json(404, {}));
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input), "http://localhost").pathname}`;
    wire.push(line);
    return answer(line);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("the step-up dialog on the web's door", () => {
  it("reads the factors once, sends one verify, and changes no cookie, storage or address", async () => {
    document.cookie = "tf_probe=kept; path=/";
    localStorage.setItem("probe", "local");
    sessionStorage.setItem("probe", "session");
    const before = [document.cookie, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), location.href];
    const { onVerified } = draw();
    await typeAndVerify(" 123456 ");
    expect(wire).toEqual([SESSION, TOTP]);
    expect(onVerified).toHaveBeenCalledTimes(1);
    expect([document.cookie, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), location.href]).toEqual(before);
  });

  it("sends the code trimmed, as the prompt did", async () => {
    let body = "";
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input), "http://localhost").pathname}`;
      wire.push(line);
      if (line === TOTP) body = String(init?.body ?? "");
      return answer(line);
    }) as typeof fetch;
    draw();
    await typeAndVerify(" 123456 ");
    expect(JSON.parse(body)).toEqual({ code: "123456" });
  });

  it("the lock says the server's minutes, and fifteen where it names none", async () => {
    answer = (line) =>
      line === SESSION ? session() : json(429, { error: { code: "account_locked", message: "locked", details: { retryAfter: 120 } } });
    draw();
    await typeAndVerify("111111");
    expect(screen.getByRole("dialog").textContent).toContain("in 2 minutes.");
    cleanup();
    answer = (line) => (line === SESSION ? session() : json(429, { error: { code: "account_locked", message: "locked" } }));
    draw();
    await typeAndVerify("111111");
    expect(screen.getByRole("dialog").textContent).toContain("in 15 minutes.");
  });

  it("a code the server refused says the code's sentence, and the verb does not run", async () => {
    answer = (line) => (line === SESSION ? session() : json(401, { error: { code: "unauthorized", message: "two-factor verification failed" } }));
    const { onVerified } = draw();
    await typeAndVerify("111111");
    expect(screen.getByRole("dialog").textContent).toContain(W.badCode);
    expect(screen.getByRole("dialog").textContent).not.toContain("two-factor verification failed");
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("the throttle has its own sentence, and anything else the one refusal", async () => {
    answer = (line) => (line === SESSION ? session() : json(429, { error: { code: "sign_in_slowed", message: "slow down" } }));
    draw();
    await typeAndVerify("111111");
    expect(screen.getByRole("dialog").textContent).toContain(W.slowed);
    cleanup();
    answer = (line) => (line === SESSION ? session() : json(500, { error: { code: "internal", message: "internal error" } }));
    draw();
    await typeAndVerify("111111");
    expect(screen.getByRole("dialog").textContent).toContain(W.refused);
  });

  it("speaks German where the reader is German", async () => {
    draw(de, "de");
    await settle();
    expect(screen.getByRole("textbox", { name: de.stepUp.codeLabel })).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain(de.stepUp.door);
  });
});
