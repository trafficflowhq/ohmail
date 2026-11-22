/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot } from "@ohmail/app/account";
import { en, json, refusal, serve, settle, Words, type Server } from "./account-harness";
import { PasswordForm, usePassword } from "../../../../packages/app/src/account/account/password-entry.js";
import { usePasswordDoor } from "../../app/(product)/mailbox/password-door";
import { PasswordSection } from "../../app/(product)/mailbox/PasswordSection";

/**
 * THE CALLS OF ONE VISIT, BEFORE AND AFTER. The shipped section and the new form over the web's filling are each
 * walked through the same visit over the same scripted server: open; a change the server refuses (the current one
 * is wrong); a change refused for the factor, the factor verified, sent again and taken; leave. The two ordered
 * lists of method, path and body keys are equal, and so is what each request carried. The factor's own ceremony is
 * the doors' dialog's (both stand in for it here, so neither list carries it).
 */

/** The shipped section's factor prompt, stood in for: the case answers it as the dialog would. */
const prompt = vi.hoisted(() => ({ verified: null as null | (() => void) }));
vi.mock("../../app/(product)/mailbox/StepUp", () => ({
  StepUp: (props: { onVerified: () => void }) => {
    prompt.verified = props.onVerified;
    return null;
  },
}));

const CHANGE = "POST /api/auth/password";
const CURRENT = "kestrel-over-the-quarry-41";
const NEXT = "nine-lamps-in-a-wet-harbour";

let server: Server;
let verify: (() => void) | null = null;
const factor: FactorSlot = (ask) => {
  verify = ask.onVerified;
  return null;
};

/** The visit's script, the same for both. */
function scripted(): Server {
  const visited = serve({ [CHANGE]: () => json({ revoked: 1 }) });
  visited.answer(CHANGE, refusal(401, "credential_refused"), refusal(403, "step_up_required"));
  return visited;
}

beforeEach(() => {
  verify = null;
  prompt.verified = null;
  server = scripted();
});
afterEach(() => {
  cleanup();
  server.restore();
});

async function attempt(current: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(en.passwordChange.currentLabel), { target: { value: current } });
    fireEvent.change(screen.getByLabelText(en.passwordChange.nextLabel), { target: { value: NEXT } });
    fireEvent.change(screen.getByLabelText(en.passwordChange.repeatLabel), { target: { value: NEXT } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en.passwordChange.submit }));
  });
  await settle();
}

async function walk(form: ReactNode, factorVerified: () => void) {
  const { unmount } = render(<Words>{form}</Words>);
  await settle();
  await attempt("not-the-current-one-at-all");
  await attempt(CURRENT);
  await act(async () => factorVerified());
  await settle();
  unmount();
  await settle();
  return { asked: server.asked(), carried: server.sent.map((s) => s.body) };
}

describe("one visit to the password change asks the server the same things, in the same order", () => {
  it("the shipped section and the new form", async () => {
    const before = await walk(<PasswordSection />, () => prompt.verified!());
    cleanup();
    server.restore();
    server = scripted();

    function Anew() {
      return <PasswordForm model={usePassword(usePasswordDoor())} factor={factor} />;
    }
    const after = await walk(<Anew />, () => verify!());

    const line = `${CHANGE} {currentPassword,newPassword}`;
    expect(before.asked).toEqual([line, line, line]);
    expect(after.asked).toEqual(before.asked);
    expect(after.carried).toEqual(before.carried);
  });
});
