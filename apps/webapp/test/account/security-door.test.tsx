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
  session,
  settle,
  Words,
  type Server,
} from "./account-harness";
import { SecurityPane, useSecurity } from "../../../../packages/app/src/account/security/index.js";
import ownEn from "../../../../packages/app/messages/account-security.en.json";
import { ApiError, auth } from "../../app/api-client";
import { securityDoor, securityRefusal, useSecurityDoor } from "../../app/(product)/mailbox/security-door";

/**
 * SETTINGS › SECURITY OVER THE WEB'S REAL FILLING and a server that records what it is asked. Each verb the server
 * guards with a fresh factor is tried as it is; only the server's refusal asks the factor; the verified factor
 * sends the same request once more; Cancel, a factor that lands late and a pane that was left send nothing.
 */

const SESSION = "GET /api/auth/session";
const CODES = "POST /api/auth/2fa/recovery-codes";
const ENROLL = "POST /api/auth/2fa/totp/enroll";
const ACTIVATE = "POST /api/auth/2fa/totp/activate";
const REMOVE = "DELETE /api/auth/2fa/totp";
const STEP_UP = () => refusal(403, "step_up_required");

/* What only the person may see: the new set, the authenticator's key, and the address a scanner would read. */
const FRESH = ["58049-86391", "88255-40533", "75220-66993"];
const KEY = "JBSWY3DPEHPK3PXP";
const SCAN = `otpauth://totp/ohmail:mila?secret=${KEY}&issuer=ohmail`;

let enrolled = { webauthn: true, totp: false, recoveryCodes: true };
let server: Server;
let written: ReturnType<typeof catchConsole>;
const slot = { asked: null as GatedAsk | null };
/** The factor's dialog, stood in for: its ceremony is the doors' own. What is held here is what the pane asks. */
const factor: FactorSlot = (ask) => {
  slot.asked = ask;
  return <p>the factor is asked</p>;
};
const factorAsked = () => screen.queryByText("the factor is asked") !== null;

beforeEach(() => {
  enrolled = { webauthn: true, totp: false, recoveryCodes: true };
  slot.asked = null;
  written = catchConsole();
  server = serve({
    [SESSION]: () => json(session({ twofaEnrolled: enrolled })),
    [CODES]: () => json({ codes: FRESH }),
    [ENROLL]: () => json({ secret: KEY, otpauthUrl: SCAN }),
    [ACTIVATE]: () => json({ twofaEnrolled: { ...enrolled, totp: true } }),
    [REMOVE]: () => new Response(null, { status: 204 }),
  });
});
afterEach(() => {
  cleanup();
  server.restore();
  written.restore();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function Pane() {
  return <SecurityPane model={useSecurity(useSecurityDoor())} factor={factor} />;
}
async function opened() {
  const view = render(
    <Words>
      <Pane />
    </Words>,
  );
  await settle();
  return view;
}
const button = (name: string) => screen.getByRole("button", { name });
const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(button(name));
  });
  await settle();
};
const typeCode = (code: string) =>
  act(async () => {
    fireEvent.change(screen.getByLabelText(en.security.totpCodeLabel), { target: { value: code } });
  });

/** The four guarded verbs: what the account has, how the verb is reached, the press that sends it, the request it is. */
const VERBS: readonly {
  readonly name: string;
  readonly line: string;
  readonly keys: readonly string[];
  readonly has: typeof enrolled;
  readonly reach: () => Promise<void>;
  readonly send: () => Promise<void>;
}[] = [
  {
    name: "new recovery codes",
    line: CODES,
    keys: [],
    has: { webauthn: true, totp: false, recoveryCodes: true },
    reach: async () => {},
    send: async () => {
      await press(en.security.codesReplace);
      await press(en.security.codesConfirm);
    },
  },
  {
    name: "an authenticator's enrolment",
    line: ENROLL,
    keys: [],
    has: { webauthn: true, totp: false, recoveryCodes: true },
    reach: async () => {},
    send: () => press(en.security.totpAdd),
  },
  {
    name: "the code that turns the authenticator on",
    line: ACTIVATE,
    keys: ["code"],
    has: { webauthn: true, totp: false, recoveryCodes: true },
    reach: async () => {
      await press(en.security.totpAdd);
      await typeCode("123456");
    },
    send: () => press(en.security.totpActivate),
  },
  {
    name: "the authenticator's removal",
    line: REMOVE,
    keys: [],
    has: { webauthn: true, totp: true, recoveryCodes: true },
    reach: async () => {},
    send: () => press(en.security.totpRemove),
  },
];

/** The pane opened on an account that has what a verb needs, the verb reached, and the server about to refuse it. */
async function refusedOnce(verb: (typeof VERBS)[number], ...more: Response[]) {
  enrolled = verb.has;
  const view = await opened();
  await verb.reach();
  server.answer(verb.line, STEP_UP(), ...more);
  await verb.send();
  return view;
}

describe("a refused verb, as its word", () => {
  const say = (): string => "said by the renderer";
  const word = (err: unknown) => securityRefusal(err, say);

  it("reads the refusal in the order the pane always did", () => {
    expect(word(new ApiError(403, "step_up_required", "x"))).toEqual({ ok: false, word: "factor" });
    expect(word(new ApiError(403, "enrollment_incomplete", "x"))).toEqual({ ok: false, word: "sign_in" });
    expect(word(new ApiError(403, "forbidden", "x"))).toEqual({ ok: false, word: "sign_in" });
    expect(word(new ApiError(401, "unauthorized", "x"))).toEqual({ ok: false, word: "sign_in" });
    expect(word(new ApiError(401, "step_up_required", "x"))).toEqual({ ok: false, word: "sign_in" });
    for (const other of [new ApiError(400, "validation_failed", "x"), new ApiError(500, "internal", "x"), new Error("x")])
      expect(word(other)).toEqual({ ok: false, word: "said", said: "said by the renderer" });
  });

  it("each verb answers that word, and a read that failed is said whatever refused it", async () => {
    const door = securityDoor(say);
    const refused = new ApiError(403, "forbidden", "x");
    vi.spyOn(auth, "recoveryCodes").mockRejectedValueOnce(refused);
    vi.spyOn(auth, "totpEnroll").mockRejectedValueOnce(refused);
    vi.spyOn(auth, "totpActivate").mockRejectedValueOnce(refused);
    vi.spyOn(auth, "totpRemove").mockRejectedValueOnce(refused);
    expect(await door.newCodes()).toEqual({ ok: false, word: "sign_in" });
    expect(await door.startAuthenticator()).toEqual({ ok: false, word: "sign_in" });
    expect(await door.activate("123456")).toEqual({ ok: false, word: "sign_in" });
    expect(await door.removeAuthenticator()).toEqual({ ok: false, word: "sign_in" });
    for (const failed of [refused, new ApiError(403, "step_up_required", "x"), new ApiError(503, "internal", "x")]) {
      vi.spyOn(auth, "session").mockRejectedValueOnce(failed);
      expect(await door.read()).toEqual({ ok: false, word: "said", said: "said by the renderer" });
    }
  });

  it("answers what is enrolled from the session's own answer, and the key alone of an enrolment", async () => {
    const door = securityDoor(say);
    enrolled = { webauthn: false, totp: true, recoveryCodes: false };
    expect(await door.read()).toEqual({
      ok: true,
      value: { passkey: false, authenticator: true, recoveryCodes: false },
    });
    expect(await door.startAuthenticator()).toEqual({ ok: true, value: { key: KEY } });
    expect(await door.newCodes()).toEqual({ ok: true, value: FRESH });
  });
});

describe("opening the pane", () => {
  it("asks who is enrolled once, and sends nothing else", async () => {
    await opened();
    expect(server.asked()).toEqual([`${SESSION} {}`]);
  });

  it("over a session that could not be read: the reason, and none of the verbs that change it", async () => {
    server.answer(SESSION, refusal(503, "internal"), refusal(503, "internal"), refusal(503, "internal"));
    await opened();
    for (const name of [
      en.security.codesGenerate,
      en.security.codesReplace,
      en.security.totpAdd,
      en.security.totpReplace,
      en.security.totpRemove,
    ])
      expect(screen.queryByRole("button", { name }), name).toBeNull();
    expect(server.sent.filter((s) => s.line !== SESSION)).toEqual([]);
  });

  it("a request that never reached the server is a read that failed too", async () => {
    server.answer(SESSION, OFFLINE, OFFLINE, OFFLINE);
    await opened();
    expect(screen.queryByRole("button", { name: en.security.codesReplace })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("offers the authenticator's removal only while a passkey is enrolled beside it", async () => {
    enrolled = { webauthn: false, totp: true, recoveryCodes: true };
    await opened();
    expect(screen.queryByRole("button", { name: en.security.totpReplace })).not.toBeNull();
    expect(screen.queryByRole("button", { name: en.security.totpRemove })).toBeNull();
  });

  it("new codes are asked for first: no request leaves before the question's own Confirm", async () => {
    await opened();
    await press(en.security.codesReplace);
    expect(server.on(CODES)).toHaveLength(0);
    await press(en.security.cancel);
    expect(server.on(CODES)).toHaveLength(0);
  });
});

for (const verb of VERBS) {
  describe(`${verb.name}, guarded by the factor`, () => {
    it("is tried as it is; the refusal asks the factor; nothing more leaves before it verifies; then once more, the same", async () => {
      await refusedOnce(verb);
      expect(server.on(verb.line)).toHaveLength(1);
      expect(factorAsked()).toBe(true);
      await settle();
      expect(server.on(verb.line)).toHaveLength(1);
      await act(async () => slot.asked!.onVerified());
      await settle();
      expect(server.on(verb.line).map((s) => s.keys)).toEqual([verb.keys, verb.keys]);
      expect(factorAsked()).toBe(false);
      expect(document.body.textContent).not.toContain(en.security.stepUpExpired);
    });

    it("refused again after the factor: the way back in, no second dialog, no third request", async () => {
      await refusedOnce(verb, STEP_UP());
      await act(async () => slot.asked!.onVerified());
      await settle();
      expect(server.on(verb.line)).toHaveLength(2);
      expect(factorAsked()).toBe(false);
      expect(document.body.textContent).toContain(en.security.stepUpExpired);
    });

    it("Cancel sends nothing more, and a factor that lands after it says nothing ran", async () => {
      await refusedOnce(verb);
      const asked = slot.asked!;
      await act(async () => asked.onCancel());
      expect(factorAsked()).toBe(false);
      await act(async () => asked.onDiscarded());
      await act(async () => asked.onVerified());
      await settle();
      expect(server.on(verb.line)).toHaveLength(1);
      expect(document.body.textContent).toContain(en.devices.stepUpCancelledNothingRan);
    });

    it("a pane left while the factor is asked sends nothing afterwards", async () => {
      const view = await refusedOnce(verb);
      const asked = slot.asked!;
      view.unmount();
      server.forget();
      await act(async () => asked.onVerified());
      await settle();
      expect(server.asked()).toEqual([]);
    });
  });
}

describe("what only the person may see", () => {
  const SECRETS = [...FRESH, KEY, SCAN];

  it("the new set is shown once, and is nowhere but in what is read; Done takes it off the page", async () => {
    await opened();
    await press(en.security.codesReplace);
    await press(en.security.codesConfirm);
    for (const code of FRESH) expect(document.body.textContent).toContain(code);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    await press(en.security.codesDone);
    for (const code of FRESH) expect(document.body.innerHTML).not.toContain(code);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });

  it("the new set made and the read after it refused: shown with the failure beside it, nowhere else, until Done", async () => {
    await opened();
    server.answer(SESSION, refusal(503, "internal"));
    await press(en.security.codesReplace);
    await press(en.security.codesConfirm);
    expect(server.on(SESSION)).toHaveLength(2);
    for (const code of FRESH) expect(document.body.textContent).toContain(code);
    expect(document.body.textContent).toContain(ownEn.accountSecurity.notRead);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    await press(en.security.codesDone);
    for (const code of FRESH) expect(document.body.innerHTML).not.toContain(code);
    expect(document.body.textContent).toContain(ownEn.accountSecurity.notRead);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });

  it("the set is the pane's alone: left while it stands, it is kept nowhere, and a pane opened again draws none", async () => {
    const view = await opened();
    server.answer(SESSION, refusal(503, "internal"));
    await press(en.security.codesReplace);
    await press(en.security.codesConfirm);
    for (const code of FRESH) expect(document.body.textContent).toContain(code);
    view.unmount();
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    await opened();
    // Opened again, it has read what is enrolled, and draws it.
    expect(screen.queryByRole("group", { name: en.security.codesTitle })).not.toBeNull();
    for (const code of FRESH) expect(document.body.innerHTML).not.toContain(code);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });

  it("the authenticator's key is shown to type, the scanner's address is kept nowhere, and both go with Cancel", async () => {
    await opened();
    await press(en.security.totpAdd);
    expect(document.body.textContent).toContain(KEY);
    expect(document.body.innerHTML).not.toContain("otpauth:");
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    await press(en.security.cancel);
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });

  it("the code is sent trimmed, in the request's body alone", async () => {
    await opened();
    await press(en.security.totpAdd);
    await typeCode("  123456 ");
    await press(en.security.totpActivate);
    expect(server.on(ACTIVATE).map((s) => s.body)).toEqual([{ code: "123456" }]);
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  /** An enrolment started, new codes made while its key stands, and the read after them refused. */
  async function keyOverAFailedRead() {
    const view = await opened();
    await press(en.security.totpAdd);
    server.answer(SESSION, refusal(503, "internal"));
    await press(en.security.codesReplace);
    await press(en.security.codesConfirm);
    expect(server.on(SESSION)).toHaveLength(2);
    return view;
  }

  it("a new key and the read after it refused: shown with the failure beside it, nowhere else; Cancel takes it", async () => {
    const view = await keyOverAFailedRead();
    expect(document.body.textContent).toContain(KEY);
    expect(document.body.textContent).toContain(ownEn.accountSecurity.notRead);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    await press(en.security.cancel);
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(document.body.textContent).toContain(ownEn.accountSecurity.notRead);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    view.unmount();
    await opened();
    // Opened again, it has read what is enrolled, and draws no key.
    expect(screen.queryByRole("group", { name: en.security.totpTitle })).not.toBeNull();
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });

  it("over that failed read the code that finishes the enrolment is still taken, trimmed, in the request's body alone", async () => {
    await keyOverAFailedRead();
    await typeCode("  123456 ");
    await press(en.security.totpActivate);
    expect(server.on(ACTIVATE).map((s) => s.body)).toEqual([{ code: "123456" }]);
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });

  it("the key is the pane's alone: left while it stands over the failed read, it is kept nowhere, and a pane opened again draws none", async () => {
    const view = await keyOverAFailedRead();
    expect(document.body.textContent).toContain(KEY);
    view.unmount();
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    await opened();
    expect(screen.queryByRole("group", { name: en.security.totpTitle })).not.toBeNull();
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });
});
