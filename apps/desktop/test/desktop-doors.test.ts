import { afterEach, describe, expect, it } from "vitest";

import {
  CLOUD_URL,
  EMPTY_LOCAL,
  beginBrowserSignIn,
  enterCloudDoor,
  enterCloudDoorWithCode,
  enterLocalDoor,
  gateFor,
  handoffProblem,
  implicitTls,
  localProblem,
  cloudProblem,
  portOr,
  settle,
  signInToCloud,
  signInToCloudWithCode,
} from "../src/doors.js";
import { providerById } from "../../webapp/app/shell/providers.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * THE TWO DOORS, driven against a stand-in shell.
 *
 * What is asserted here is the part of onboarding that decides rather than the part that draws:
 * which screen a given engine state routes to, what the settings payload contains, and — the one
 * that matters most — WHERE the password goes. `desktop-shell.test.ts` asserts what the
 * declarations say; this asserts what the code does when a person fills the form in.
 *
 * ── THE ASSERTION WORTH THE WHOLE FILE ──────────────────────────────────────────────────────
 *
 * A mailbox password is never an argument to a shell command. It travels over the bridge,
 * addressed to the engine, and is sealed there under this install's key. The shell refuses a
 * configuration carrying a secret-shaped field, so the failure mode is loud — but "loud at
 * runtime, on somebody's first launch" is not the same as "cannot be written", and the check
 * below is the one that fails in CI instead.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: unknown };
}

const host = globalThis as Host;

/** Encode an answer exactly as the shell's `engine_request` does. */
function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked {
  command: string;
  payload?: Record<string, unknown>;
}

const SERVING: EngineStatus = {
  state: "serving",
  mode: "local",
  address: "mila@example.com",
  mailboxId: "mbx-1",
  credentialState: "absent",
};

/**
 * A shell that accepts a configuration, comes up, and answers every bridge request 200.
 *
 * `engine_configure` answers `starting`, which is what the real one answers: it replaces the
 * engine, and the replacement has not announced itself yet. The `engine_status` that follows is
 * the settle loop.
 */
function shellThatWorks(status: EngineStatus = SERVING, requestStatus = 200): Asked[] {
  const asked: Asked[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      asked.push({ command, payload });
      if (command === "engine_configure") return { state: "starting", mode: status.mode };
      if (command === "engine_status") return status;
      if (command === "engine_request") return encode(requestStatus, '{"ok":true}');
      throw new Error(`unexpected command ${command}`);
    },
  };
  return asked;
}

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("what the window shows", () => {
  const gate = (status: Partial<EngineStatus>) =>
    gateFor({ kind: "status", status: status as EngineStatus }).kind;

  it("sends a fresh install to the chooser, by either spelling of 'no door'", () => {
    // The shell has nothing to start…
    expect(gate({ state: "not_configured", mode: null })).toBe("choose");
    // …and a running engine that no settings file names is the same answer. Both happen: the
    // first is a sign-out, the second is a settings file that could not be read.
    expect(gate({ state: "serving", mode: null })).toBe("choose");
  });

  it("shows the client for every state a door HAS been chosen in", () => {
    for (const state of ["serving", "starting", "restarting", "stopped"] as const) {
      expect(gate({ state, mode: "local" }), state).toBe("app");
    }
  });

  /**
   * NEVER A SAMPLE WORLD IN PLACE OF A FAILURE. Each of these is a state where the app cannot open
   * a mailbox, and each one renders a sentence — not fixture mail, and not an empty client that
   * looks like a mailbox with nothing in it.
   */
  it("says what is wrong rather than showing something else", () => {
    expect(gate({ state: "failed", mode: "local", reason: "the engine failed 4 starts" })).toBe("notice");
    expect(gate({ state: "no_key", mode: "local", reason: "the keystore would not answer" })).toBe("notice");
    expect(gate({ state: "absent" })).toBe("notice");
    expect(gateFor({ kind: "unreachable", reason: "no answer" }).kind).toBe("notice");
    // …and the reason travels rather than being replaced with a category.
    const notice = gateFor({
      kind: "status",
      status: { state: "failed", mode: "local", reason: "another copy is running" } as EngineStatus,
    });
    expect(notice.kind === "notice" && notice.reason).toBe("another copy is running");
  });

  /**
   * "NO SHELL AT ALL" IS NOT A FAILURE AND IS NOT ROUTED TO ONE.
   *
   * It means the bundle is loaded outside the app — a development server, or the render check that
   * loads the built files in a headless DOM. The packaged app always has a command channel, so
   * this branch is unreachable there; treating it as an error would put a notice on the one
   * surface whose whole job is to render the client.
   */
  it("leaves the preview alone when there is no shell to ask", () => {
    expect(gateFor({ kind: "none" }).kind).toBe("app");
  });
});

describe("the local door", () => {
  const filled = {
    ...EMPTY_LOCAL,
    providerId: "fastmail",
    address: "mila@example.com",
    password: "app-password-1234",
    imapHost: "imap.fastmail.com",
    imapPort: "993",
    smtpHost: "smtp.fastmail.com",
    smtpPort: "465",
  };

  it("sends the settings to the shell and the password to the engine — never the other way", async () => {
    const asked = shellThatWorks();

    const result = await enterLocalDoor(filled, providerById("fastmail"));
    expect(result.problem).toBeNull();

    const configure = asked.find((a) => a.command === "engine_configure")!;
    const config = configure.payload!.config as Record<string, unknown>;
    expect(config.mode).toBe("local");
    expect(config.imap).toEqual({
      host: "imap.fastmail.com",
      user: "mila@example.com",
      port: 993,
      secure: true,
    });
    expect(config.address).toBe("mila@example.com");

    /* THE PASSWORD IS NOT IN THE COMMAND. Not under that name, not under any other, and not at
       any depth — the shell writes its argument to a settings file in the user's home. */
    expect(JSON.stringify(configure.payload)).not.toContain("app-password-1234");
    expect(JSON.stringify(configure.payload)).not.toMatch(/pass|secret|token|credential/i);

    /* IT IS IN THE BRIDGE REQUEST, addressed to the mailbox the engine announced. */
    const request = asked.find((a) => a.command === "engine_request")!;
    expect(request.payload!.method).toBe("PATCH");
    expect(request.payload!.url).toBe("/mailboxes/mbx-1");
    const body = new TextDecoder().decode(Uint8Array.from(request.payload!.body as number[]));
    expect(JSON.parse(body)).toEqual({ imap: { pass: "app-password-1234" } });
  });

  it("waits for the reconfigured engine before addressing anything to it", async () => {
    /* `engine_configure` answers `starting`, and a `starting` engine has no mailbox id and no
       bridge. Sending the password against that answer would address `/mailboxes/undefined`. */
    const asked = shellThatWorks();
    await enterLocalDoor(filled, providerById("fastmail"));
    const order = asked.map((a) => a.command);
    expect(order.indexOf("engine_status")).toBeGreaterThan(order.indexOf("engine_configure"));
    expect(order.indexOf("engine_request")).toBeGreaterThan(order.indexOf("engine_status"));
  });

  it("reports the engine's own words when the password is refused", async () => {
    const asked = shellThatWorks(SERVING, 401);
    host.__TAURI_INTERNALS__!.invoke = async (command, payload) => {
      asked.push({ command, payload });
      if (command === "engine_configure") return { state: "starting", mode: "local" };
      if (command === "engine_status") return SERVING;
      return encode(401, '{"error":{"code":"imap_auth","message":"the mail server refused that password"}}', "Unauthorized");
    };

    const result = await enterLocalDoor(filled, providerById("fastmail"));
    expect(result.problem).toBe("the mail server refused that password");
    // The settings still landed: the door is chosen, and only the password has to be retyped.
    expect(result.status?.state).toBe("serving");
  });

  it("refuses an incomplete form before it touches the shell", async () => {
    const asked = shellThatWorks();
    const result = await enterLocalDoor({ ...filled, password: "" }, providerById("fastmail"));
    expect(result.problem).toBe("Your mailbox password is missing.");
    expect(asked).toHaveLength(0);
  });

  it("names the first missing thing, in the order the form asks for it", () => {
    expect(localProblem(EMPTY_LOCAL)).toBe("Choose where your mail lives.");
    expect(localProblem({ ...EMPTY_LOCAL, providerId: "fastmail" })).toMatch(/address is missing/);
    expect(localProblem({ ...EMPTY_LOCAL, providerId: "fastmail", address: "mila" }))
      .toMatch(/does not look like/);
    expect(localProblem(filled)).toBeNull();
  });

  it("falls back to the preset's own ports rather than to zero", () => {
    expect(portOr("", 993)).toBe(993);
    expect(portOr("not a port", 993)).toBe(993);
    expect(portOr("0", 993)).toBe(993);
    expect(portOr("70000", 993)).toBe(993);
    expect(portOr(" 143 ", 993)).toBe(143);
  });

  /** Implicit TLS, not "is it encrypted": 587 upgrades through STARTTLS and is `false` here. */
  it("reads 993 and 465 as implicit TLS and nothing else", () => {
    expect(implicitTls(993)).toBe(true);
    expect(implicitTls(465)).toBe(true);
    expect(implicitTls(587)).toBe(false);
    expect(implicitTls(143)).toBe(false);
  });
});

describe("the cloud door", () => {
  it("configures the door with an address and no secret, then signs in over the bridge", async () => {
    const asked = shellThatWorks({ ...SERVING, mode: "cloud" });

    const result = await enterCloudDoor("mila@ohmail.app", "hunter2-and-then-some", "123456");
    expect(result.problem).toBeNull();

    const configure = asked.find((a) => a.command === "engine_configure")!;
    expect(configure.payload!.config).toEqual({
      mode: "cloud",
      cloudUrl: CLOUD_URL,
      address: "mila@ohmail.app",
    });
    expect(JSON.stringify(configure.payload)).not.toContain("hunter2");
    expect(JSON.stringify(configure.payload)).not.toContain("123456");

    const request = asked.find((a) => a.command === "engine_request")!;
    expect(request.payload!.method).toBe("POST");
    expect(request.payload!.url).toBe("/cloud/signin");
    const body = new TextDecoder().decode(Uint8Array.from(request.payload!.body as number[]));
    expect(JSON.parse(body)).toEqual({
      email: "mila@ohmail.app",
      password: "hunter2-and-then-some",
      totp: "123456",
    });
  });

  /**
   * THE HOSTED ADDRESS IS A CONSTANT, NOT A FIELD.
   *
   * "Which ohmail is this" is not a question anybody signing in to ohmail can answer, and a text
   * box for it would be a phishing surface wearing the app's own chrome.
   */
  it("names one hosted service and takes no other", () => {
    expect(CLOUD_URL).toBe("https://api.ohmail.app");
    expect(CLOUD_URL.startsWith("https://")).toBe(true);
  });

  it("checks the code is six digits before spending a sign-in attempt", async () => {
    const asked = shellThatWorks({ ...SERVING, mode: "cloud" });
    expect((await enterCloudDoor("mila@ohmail.app", "pw", "12345")).problem)
      .toMatch(/six digits/);
    expect((await enterCloudDoor("mila@ohmail.app", "pw", "abcdef")).problem)
      .toMatch(/six digits/);
    expect(cloudProblem("mila@ohmail.app", "pw", "123456")).toBeNull();
    expect(asked).toHaveLength(0);
  });

  /** Signing in again on a door that is already chosen reconfigures nothing. */
  it("re-signs in without touching the configuration", async () => {
    const asked = shellThatWorks({ ...SERVING, mode: "cloud" });
    const result = await signInToCloud("mila@ohmail.app", "pw", "123456");
    expect(result.problem).toBeNull();
    expect(asked.some((a) => a.command === "engine_configure")).toBe(false);
    expect(asked.find((a) => a.command === "engine_request")!.payload!.url).toBe("/cloud/signin");
  });
});

/**
 * THE BROWSER HANDOFF — the same door, entered with a code instead of a password.
 *
 * The point of the path is what is NOT in it, so that is what these assert: no password anywhere
 * in the traffic, and the code carried in the one field the engine branches on. A body that also
 * sent empty `password`/`totp` keys would still work and would still be wrong — the engine would
 * be reading a shape nobody meant to send.
 */
describe("door two, entered with a code from the browser", () => {
  it("configures the engine for the address and sends ONLY the code over the bridge", async () => {
    const asked = shellThatWorks({ ...SERVING, mode: "cloud" });
    const result = await enterCloudDoorWithCode("mila@ohmail.app", "  handoff-code-9  ");
    expect(result.problem).toBeNull();

    const configure = asked.find((a) => a.command === "engine_configure")!;
    expect(configure.payload!.config).toEqual({
      mode: "cloud", cloudUrl: CLOUD_URL, address: "mila@ohmail.app",
    });

    const request = asked.find((a) => a.command === "engine_request")!;
    expect(request.payload!.url).toBe("/cloud/signin");
    const body = new TextDecoder().decode(Uint8Array.from(request.payload!.body as number[]));
    // Trimmed, because a code read off a screen and retyped picks up whitespace — and the exact
    // object, because a stray `password: ""` beside it would send the engine down neither branch
    // cleanly.
    expect(JSON.parse(body)).toEqual({ handoffCode: "handoff-code-9" });
  });

  it("NO PASSWORD FIELD LEAVES THIS PROCESS ON THIS PATH — over the DECODED bytes", async () => {
    const asked = shellThatWorks({ ...SERVING, mode: "cloud" });
    await enterCloudDoorWithCode("mila@ohmail.app", "handoff-code-9");

    // DECODED, and the reason is worth the extra line: `engine_request` carries its body as a
    // NUMBER ARRAY, so a string search over `JSON.stringify(payload)` finds nothing whatever the
    // body contains — the assertion would pass while a password sat in the request. Watched: a
    // planted `password: ""` on the handoff body left the stringified payload untouched.
    const wire = asked.map((a) => {
      const p = (a.payload ?? {}) as Record<string, unknown>;
      const body = Array.isArray(p.body)
        ? new TextDecoder().decode(Uint8Array.from(p.body as number[]))
        : "";
      return `${JSON.stringify({ ...p, body: undefined })}${body}`;
    }).join("|");

    for (const secretish of ["password", "totp", "hunter2"]) {
      expect(wire, `"${secretish}" reached the shell on the handoff path`).not.toContain(secretish);
    }
  });

  it("refuses a missing address or a blank code before spending an attempt", async () => {
    const asked = shellThatWorks({ ...SERVING, mode: "cloud" });
    expect((await enterCloudDoorWithCode("", "code")).problem).toMatch(/address is missing/);
    expect((await enterCloudDoorWithCode("not-an-address", "code")).problem).toMatch(/does not look like/);
    expect((await enterCloudDoorWithCode("mila@ohmail.app", "   ")).problem).toMatch(/code the browser showed/);
    expect(asked).toHaveLength(0);
  });

  it("does not second-guess the SHAPE of a code the server minted", () => {
    // The tempting extra check, and the reason it is absent: a length or character-class rule
    // here is a quieter second definition of what `POST /auth/desktop-link` issues, and it keeps
    // working until the issuer changes — at which point every valid code is refused locally with
    // a sentence about a format nobody can see.
    expect(handoffProblem("mila@ohmail.app", "short")).toBeNull();
    expect(handoffProblem("mila@ohmail.app", "a".repeat(200))).toBeNull();
    expect(handoffProblem("mila@ohmail.app", "has-dashes_and_underscores")).toBeNull();
  });

  it("re-signs in with a code without touching the configuration", async () => {
    const asked = shellThatWorks({ ...SERVING, mode: "cloud" });
    const result = await signInToCloudWithCode("mila@ohmail.app", "handoff-code-9");
    expect(result.problem).toBeNull();
    expect(asked.some((a) => a.command === "engine_configure")).toBe(false);
    expect(asked.find((a) => a.command === "engine_request")!.payload!.url).toBe("/cloud/signin");
  });
});

/**
 * STARTING THE HANDOFF — the half that has to happen before the browser is opened at all.
 *
 * ── THE ORDER IS THE WHOLE OF IT, AND GETTING IT WRONG IS SILENT ────────────────────────────
 *
 * The PKCE verifier the handoff rests on lives in the ENGINE's memory, and `engine_configure`
 * REPLACES the engine. So the door has to be configured BEFORE the commitment is minted, and
 * nothing may reconfigure between minting it and claiming the code: a restart in that window takes
 * the verifier with it, and the account then answers a perfectly good code with the same sentence
 * it gives an expired one — because telling those two apart is exactly what it refuses to do.
 *
 * Nothing fails loudly when the order is wrong. That is why it is a test rather than a comment.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · mint the commitment before the configure → the ordering case goes red;
 *  · configure on a door that is already serving → the "signIn" case goes red (an install whose
 *    mail is on screen would lose it for the length of a restart to change nothing);
 *  · return the page's address anyway when the engine answered no challenge → the refusal case
 *    goes red, and that is the one that would ship an UNBOUND code to a scheme anybody can claim.
 */
describe("starting a browser handoff", () => {
  /** As `shellThatWorks`, but the bridge answers the challenge route with a commitment. */
  function shellThatMints(challenge: string | null, status: EngineStatus = { ...SERVING, mode: "cloud" }): Asked[] {
    const asked: Asked[] = [];
    host.__TAURI_INTERNALS__ = {
      invoke: async (command, payload) => {
        asked.push({ command, payload });
        if (command === "engine_configure") return { state: "starting", mode: status.mode };
        if (command === "engine_status") return status;
        if (command === "engine_request") {
          return encode(200, JSON.stringify(challenge === null ? {} : { challenge }));
        }
        throw new Error(`unexpected command ${command}`);
      },
    };
    return asked;
  }

  const CHALLENGE = "0123456789abcdefghijklmnopqrstuvwxyzABCDEF_";

  it("configures the door FIRST, then mints the commitment, on a fresh install", async () => {
    const asked = shellThatMints(CHALLENGE);
    const started = await beginBrowserSignIn("  mila@ohmail.app  ");
    expect(started.problem).toBeNull();
    expect(started.challenge).toBe(CHALLENGE);

    const configureAt = asked.findIndex((a) => a.command === "engine_configure");
    const mintAt = asked.findIndex(
      (a) => a.command === "engine_request" && a.payload!.url === "/cloud/signin/challenge",
    );
    expect(configureAt, "the door was never configured").toBeGreaterThanOrEqual(0);
    expect(mintAt, "the commitment was never minted").toBeGreaterThanOrEqual(0);
    expect(configureAt, "the commitment was minted before the engine it lives in existed")
      .toBeLessThan(mintAt);

    expect(asked[configureAt]!.payload!.config).toEqual({
      mode: "cloud", cloudUrl: CLOUD_URL, address: "mila@ohmail.app",
    });
    expect(asked[mintAt]!.payload!.method).toBe("POST");
  });

  it("touches nothing on a door that is already chosen and serving", async () => {
    const asked = shellThatMints(CHALLENGE);
    const started = await beginBrowserSignIn("mila@ohmail.app", true);
    expect(started.challenge).toBe(CHALLENGE);
    // A configure here would restart the engine — and take somebody's mail off the screen for the
    // length of a first launch — to change nothing at all.
    expect(asked.some((a) => a.command === "engine_configure")).toBe(false);
    expect(asked.map((a) => a.payload?.url)).toEqual(["/cloud/signin/challenge"]);
  });

  it("REFUSES rather than answering a page with no commitment on it", async () => {
    const asked = shellThatMints(null);
    const started = await beginBrowserSignIn("mila@ohmail.app", true);
    /* The page without a commitment mints a code any program that claimed `ohmail://` could spend,
       while this install goes on waiting for a link — every party believing the binding is on. The
       honest answer is that the handoff could not be started, with the retype field still on
       screen behind it. */
    expect(started.challenge).toBeNull();
    expect(started.problem).toMatch(/Type the code in instead/);
    expect(asked.map((a) => a.payload?.url)).toEqual(["/cloud/signin/challenge"]);
  });

  it("refuses a missing or malformed address before it configures anything", async () => {
    const asked = shellThatMints(CHALLENGE);
    expect((await beginBrowserSignIn("")).problem).toMatch(/address is missing/);
    expect((await beginBrowserSignIn("not-an-address")).problem).toMatch(/does not look like/);
    expect(asked).toHaveLength(0);
  });

  it("says what the engine said when the mint is refused", async () => {
    const asked: Asked[] = [];
    host.__TAURI_INTERNALS__ = {
      invoke: async (command, payload) => {
        asked.push({ command, payload });
        if (command === "engine_status") return { ...SERVING, mode: "cloud" };
        if (command === "engine_request") {
          return encode(409, '{"error":{"code":"already_signed_in","message":"this install already holds a session"}}', "Conflict");
        }
        throw new Error(`unexpected command ${command}`);
      },
    };
    const started = await beginBrowserSignIn("mila@ohmail.app", true);
    expect(started.challenge).toBeNull();
    // The ENGINE's own words, not a category — the same rule every other refusal on this screen
    // follows.
    expect(started.problem).toBe("this install already holds a session");
  });

  it("reports an engine that was reconfigured and never came up", async () => {
    host.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "engine_configure") return { state: "starting", mode: "cloud" };
        if (command === "engine_status") return { state: "failed", mode: "cloud", reason: "another copy is running" };
        throw new Error(`unexpected command ${command}`);
      },
    };
    const started = await beginBrowserSignIn("mila@ohmail.app");
    expect(started.challenge).toBeNull();
    expect(started.problem).toBe("another copy is running");
  });
});

describe("waiting for a reconfigured engine", () => {
  it("returns the first answer that is not still coming up", async () => {
    const answers: EngineStatus[] = [
      { state: "starting" },
      { state: "starting" },
      { state: "serving", mode: "local", mailboxId: "mbx-1" },
    ];
    let at = 0;
    const settled = await settle(
      async () => answers[Math.min(at++, answers.length - 1)]!,
      async () => {},
    );
    expect(settled.state).toBe("serving");
    expect(at).toBe(3);
  });

  /**
   * AN ENGINE THAT NEVER COMES UP IS SAID OUT LOUD, NOT SPUN ON.
   *
   * The bound returns the LAST status seen rather than a fabricated one, so the caller can report
   * what the shell actually said. A locked data directory and a failed migration both look like
   * this, and both need a sentence rather than a spinner.
   */
  it("gives up on the bound and answers with what it last saw", async () => {
    let clock = 0;
    let reads = 0;
    const settled = await settle(
      async () => { reads++; return { state: "starting", attempt: 2 } as EngineStatus; },
      async () => { clock += 10_000; },
      30_000,
      () => clock,
    );
    expect(settled.state).toBe("starting");
    // It polled rather than returning at once, and it stopped rather than polling for ever.
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThan(10);
  });
});
