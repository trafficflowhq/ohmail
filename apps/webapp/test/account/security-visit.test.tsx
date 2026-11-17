/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot } from "@ohmail/app/account";
import { en, json, refusal, serve, session, settle, Words, type Server } from "./account-harness";
import { SecurityPane, useSecurity } from "../../../../packages/app/src/account/security/index.js";
import { useSecurityDoor } from "../../app/(product)/mailbox/security-door";
import { SecuritySection } from "../../app/(product)/mailbox/SecuritySection";

/**
 * THE CALLS OF ONE VISIT, BEFORE AND AFTER. The shipped section and the new pane over the web's filling are each
 * walked through the same visit over the same scripted server: open; new recovery codes, refused for the factor,
 * the factor verified, made; Done; an authenticator started; its code refused once, then taken; the authenticator
 * removed; leave. The two ordered lists of method, path and body keys are equal. The factor's own ceremony is the
 * doors' dialog's (both stand in for it here, so neither list carries it); what is compared is what the pane asks.
 */

/** The shipped section's factor prompt, stood in for: the case answers it as the dialog would. */
const prompt = vi.hoisted(() => ({ verified: null as null | (() => void) }));
vi.mock("../../app/(product)/mailbox/StepUpPrompt", () => ({
  StepUpPrompt: (props: { onVerified: () => void }) => {
    prompt.verified = props.onVerified;
    return null;
  },
}));

const SESSION = "GET /api/auth/session";
const CODES = "POST /api/auth/2fa/recovery-codes";
const ENROLL = "POST /api/auth/2fa/totp/enroll";
const ACTIVATE = "POST /api/auth/2fa/totp/activate";
const REMOVE = "DELETE /api/auth/2fa/totp";
/* An enrolment's answer: the key an authenticator is typed with, and the address a scanner would read. */
const KEY = "JBSWY3DPEHPK3PXP";
const SCAN = "otpauth://totp/ohmail:mila";

let server: Server;
let verify: (() => void) | null = null;
const factor: FactorSlot = (ask) => {
  verify = ask.onVerified;
  return null;
};

/** The visit's script, the same for both: a server whose session answers what the visit has enrolled so far. */
function scripted(): Server {
  const enrolled = { webauthn: true, totp: false, recoveryCodes: true };
  const visited = serve({
    [SESSION]: () => json(session({ twofaEnrolled: { ...enrolled } })),
    [CODES]: () => json({ codes: ["58049-86391", "88255-40533"] }),
    [ENROLL]: () => json({ secret: KEY, otpauthUrl: SCAN }),
    [ACTIVATE]: () => {
      enrolled.totp = true;
      return json({ twofaEnrolled: { ...enrolled } });
    },
    [REMOVE]: () => {
      enrolled.totp = false;
      return new Response(null, { status: 204 });
    },
  });
  visited.answer(CODES, refusal(403, "step_up_required"));
  visited.answer(ACTIVATE, refusal(400, "validation_failed"));
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

const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await settle();
};

async function walk(pane: ReactNode, factorVerified: () => void): Promise<string[]> {
  const { unmount } = render(<Words>{pane}</Words>);
  await settle();
  await press(en.security.codesReplace);
  await press(en.security.codesConfirm);
  await act(async () => factorVerified());
  await settle();
  await press(en.security.codesDone);
  await press(en.security.totpAdd);
  await act(async () => {
    fireEvent.change(screen.getByLabelText(en.security.totpCodeLabel), { target: { value: "123456" } });
  });
  await press(en.security.totpActivate);
  await press(en.security.totpActivate);
  await press(en.security.totpRemove);
  unmount();
  await settle();
  return server.asked();
}

describe("one visit to Settings › Security asks the server the same things, in the same order", () => {
  it("the shipped section and the new pane", async () => {
    const before = await walk(<SecuritySection />, () => prompt.verified!());
    cleanup();
    server.restore();
    server = scripted();

    function Anew() {
      return <SecurityPane model={useSecurity(useSecurityDoor())} factor={factor} />;
    }
    const after = await walk(<Anew />, () => verify!());

    expect(before).toEqual([
      `${SESSION} {}`,
      `${CODES} {}`,
      `${CODES} {}`,
      `${SESSION} {}`,
      `${ENROLL} {}`,
      `${ACTIVATE} {code}`,
      `${ACTIVATE} {code}`,
      `${SESSION} {}`,
      `${REMOVE} {}`,
      `${SESSION} {}`,
    ]);
    expect(after).toEqual(before);
  });
});
