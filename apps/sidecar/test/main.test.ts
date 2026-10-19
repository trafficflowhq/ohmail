import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectOverStdio } from "../src/client.js";
import { serveOverStdio } from "../src/host.js";
import { claimStdout, configFromEnv, standDownFromEnv } from "../src/main.js";
import {
  ENGINE_VITALS_INTERVAL_MS,
  VITALS_INTERVAL_MAX_MS,
  VITALS_INTERVAL_MIN_MS,
} from "../src/vitals.js";

/**
 * THE PROCESS ENTRY POINT'S TWO SHARP EDGES.
 *
 * 1. Anything printed to stdout lands INSIDE a frame. There is no resync point in a
 *    length-prefixed stream, so one `console.log` from any dependency ends the connection with a
 *    symptom that points nowhere near its cause.
 * 2. The configuration comes from the shell. A sidecar that invents a mailbox, a data directory or
 *    a key is a sidecar that quietly does the wrong thing on somebody's real mail.
 */

const realStdoutWrite = process.stdout.write.bind(process.stdout);
afterEach(() => {
  process.stdout.write = realStdoutWrite;
  vi.restoreAllMocks();
});

describe("claimStdout", () => {
  it("sends everything written to process.stdout to stderr instead", () => {
    const toStderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      toStderr.push(String(chunk));
      return true;
    });

    const sink = claimStdout();
    try {
      // `process.stdout.write` is the choke point: `console.log` and every library's progress
      // line go through it in a real process. (It cannot be demonstrated with `console.log`
      // HERE — vitest swaps `console` out for its own reporter, so under the runner it never
      // reaches this stream at all.)
      process.stdout.write("a stray debug line\n");
      process.stdout.write(Buffer.from("and some bytes\n"));
      expect(toStderr.join("")).toContain("a stray debug line");
      expect(toStderr.join("")).toContain("and some bytes");
    } finally {
      sink.end();
    }
  });

  it("hands back a REAL Writable, because the frame writer needs its events", () => {
    // The bug this pins: a façade object that only forwards `write` registers `drain`/`error`
    // listeners on itself while the underlying stream emits on the underlying object. The frame
    // writer would then wait forever for a `drain` that goes somewhere else, and the sidecar
    // would hang on the first response bigger than a pipe buffer.
    const sink = claimStdout();
    try {
      expect(sink).toBeInstanceOf(Writable);
      const seen: string[] = [];
      // A BLOCK body, not `=> seen.push(...)`: `push` returns the new length, and an arrow
      // annotated `(): void` may not have a concise body that produces a value.
      const handler = (): void => { seen.push("drain"); };
      sink.on("drain", handler);
      expect(sink.listenerCount("drain")).toBe(1);
      sink.removeListener("drain", handler);
      expect(sink.listenerCount("drain")).toBe(0);
      expect(sink).not.toBe(process.stdout);
    } finally {
      sink.end();
    }
  });

  it("a log written DURING a request does not corrupt the frame stream", async () => {
    const toStderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      toStderr.push(String(chunk));
      return true;
    });
    const sink = claimStdout();
    sink.end(); // this test is about the redirect, not about the sink

    const toHost = new PassThrough({ highWaterMark: 256 });
    const toClient = new PassThrough({ highWaterMark: 256 });
    const host = serveOverStdio({
      handle: async () => {
        // Exactly the accident this mechanism exists for.
        process.stdout.write("PROGRESS: fetching 200" + " messages\n");
        return Response.json({ ok: true });
      },
      input: toHost,
      output: toClient,
    });
    const client = connectOverStdio({ input: toClient, output: toHost });
    try {
      const res = await client.fetch("/x");
      expect(await res.json()).toEqual({ ok: true });
      expect(toStderr.join("")).toContain("PROGRESS: fetching 200" + " messages");
    } finally {
      client.close();
      host.stop();
    }
  });
});

describe("configFromEnv", () => {
  const base = {
    OHMAIL_DATA_DIR: "/tmp/ohmail",
    OHMAIL_IMAP_HOST: "imap.fastmail.com",
    OHMAIL_IMAP_USER: "mila@example.test",
    OHMAIL_IMAP_PASS: "app-password",
  };

  it("defaults to TLS on 993 and takes the mailbox address from the IMAP user", () => {
    const cfg = configFromEnv(base as NodeJS.ProcessEnv);
    expect(cfg.imap).toMatchObject({ host: "imap.fastmail.com", port: 993, secure: true });
    expect(cfg.imap.auth).toEqual({ user: "mila@example.test", pass: "app-password" });
    expect(cfg.address).toBeUndefined(); // the engine falls back to the IMAP user
    expect(cfg.keks).toBeUndefined();
    expect(cfg.imap.smtp).toBeUndefined();
  });

  it("refuses to start without the mailbox the shell is supposed to hand it", () => {
    // The PASSWORD is deliberately not in this list. Host, user and data directory are settings
    // the shell always knows; the password is a secret that, after the launch on which the user
    // types it, lives encrypted in the local store — so a launch without one is the steady state
    // and requiring it here would make a restart impossible by construction.
    for (const missing of ["OHMAIL_DATA_DIR", "OHMAIL_IMAP_HOST", "OHMAIL_IMAP_USER"]) {
      const env = { ...base } as Record<string, string>;
      delete env[missing];
      expect(() => configFromEnv(env as NodeJS.ProcessEnv), missing).toThrow(new RegExp(missing));
    }
  });

  it("carries the shell's build commit through, and composes none when nothing was handed one", () => {
    // The engine half of the one-artifact rule: the Rust shell bakes its commit and passes
    // `OHMAIL_BUILD_COMMIT` at spawn, `/health` publishes it, and the repro gate compares it with
    // the source it reproduced. Read here exactly as the other knobs are — no validation, because
    // the literal `unknown` is a real answer a build can give about itself and swallowing it here
    // would turn "this build cannot name itself" into "nobody told this engine".
    const sha = "d".repeat(40);
    expect(configFromEnv({ ...base, OHMAIL_BUILD_COMMIT: sha } as NodeJS.ProcessEnv).buildCommit)
      .toBe(sha);
    expect(configFromEnv({ ...base, OHMAIL_BUILD_COMMIT: "unknown" } as NodeJS.ProcessEnv).buildCommit)
      .toBe("unknown");
    // The positive control on the absence — an engine nobody told carries no key at all, which
    // is what makes `/health` able to say "nothing told me" apart from "unknown".
    expect(configFromEnv(base as NodeJS.ProcessEnv).buildCommit).toBeUndefined();
    expect(configFromEnv({ ...base, OHMAIL_BUILD_COMMIT: "  " } as NodeJS.ProcessEnv).buildCommit)
      .toBeUndefined();
  });

  it("reads OHMAIL_BLANK_REPAIR as the hosted worker does, composes none when unset, and refuses another value", () => {
    // The engine hands it to every cycle (`SidecarConfig.blankRepair`); absent is the engine's apply.
    expect(configFromEnv(base as NodeJS.ProcessEnv).blankRepair).toBeUndefined();
    expect(configFromEnv({ ...base, OHMAIL_BLANK_REPAIR: " " } as NodeJS.ProcessEnv).blankRepair).toBeUndefined();
    expect(configFromEnv({ ...base, OHMAIL_BLANK_REPAIR: "off" } as NodeJS.ProcessEnv).blankRepair).toBe("off");
    expect(configFromEnv({ ...base, OHMAIL_BLANK_REPAIR: "DRY" } as NodeJS.ProcessEnv).blankRepair).toBe("dry");
    expect(configFromEnv({ ...base, OHMAIL_BLANK_REPAIR: "apply" } as NodeJS.ProcessEnv).blankRepair).toBe("apply");
    // A mistyped `off` read as the default would repair: the boot refuses, naming the variable.
    expect(() => configFromEnv({ ...base, OHMAIL_BLANK_REPAIR: "of" } as NodeJS.ProcessEnv)).toThrow(/OHMAIL_BLANK_REPAIR/);
  });

  it("a launch with no password is configured, not refused", () => {
    const env = { ...base } as Record<string, string>;
    delete env.OHMAIL_IMAP_PASS;
    const cfg = configFromEnv(env as NodeJS.ProcessEnv);
    expect(cfg.imap.auth).toEqual({ user: "mila@example.test" });
  });

  it("refuses a key that is not 32 bytes rather than silently deriving one", () => {
    // A short or mistyped key would encrypt credentials under something nobody can reproduce.
    expect(() => configFromEnv({ ...base, OHMAIL_KEK: "abc" } as NodeJS.ProcessEnv)).toThrow(/64 hex/);
    const ok = configFromEnv({ ...base, OHMAIL_KEK: "ab".repeat(32) } as NodeJS.ProcessEnv);
    // The unversioned spelling IS version 1 — one key, in the ring shape the rest of the stack
    // reads, so nothing downstream has to know which spelling the host used.
    expect(Object.keys(ok.keks!)).toEqual(["1"]);
    expect(ok.keks![1]).toHaveLength(32);
  });

  it("reads a versioned ring, so a key can be rotated rather than only replaced", () => {
    const cfg = configFromEnv({
      ...base, OHMAIL_KEK_V1: "ab".repeat(32), OHMAIL_KEK_V2: "cd".repeat(32),
    } as NodeJS.ProcessEnv);
    expect(Object.keys(cfg.keks!).sort()).toEqual(["1", "2"]);
    expect(cfg.keks![2]!.toString("hex")).toBe("cd".repeat(32));
  });

  it("refuses a GAP in the versions, because the missing one is the one some row needs", () => {
    expect(() => configFromEnv({ ...base, OHMAIL_KEK_V2: "ab".repeat(32) } as NodeJS.ProcessEnv))
      .toThrow(/OHMAIL_KEK_V1 is missing/);
  });

  it("refuses two spellings of version 1 that disagree", () => {
    // A host that passes both and means different things cannot know which key sealed its
    // stored credentials, and guessing is how one becomes unopenable.
    expect(() => configFromEnv({
      ...base, OHMAIL_KEK: "ab".repeat(32), OHMAIL_KEK_V1: "cd".repeat(32),
    } as NodeJS.ProcessEnv)).toThrow(/both set and differ/);
    // The SAME value under both spellings is not a conflict.
    const same = configFromEnv({
      ...base, OHMAIL_KEK: "ab".repeat(32), OHMAIL_KEK_V1: "ab".repeat(32),
    } as NodeJS.ProcessEnv);
    expect(Object.keys(same.keks!)).toEqual(["1"]);
  });

  it("treats an empty value as absent, not as a broken key", () => {
    // A launcher that materializes every declared variable as "" must not look misconfigured.
    expect(configFromEnv({ ...base, OHMAIL_KEK: "" } as NodeJS.ProcessEnv).keks).toBeUndefined();
  });

  it("carries SMTP only when the shell configures it", () => {
    const cfg = configFromEnv({ ...base, OHMAIL_SMTP_HOST: "smtp.fastmail.com", OHMAIL_SMTP_PORT: "465" } as NodeJS.ProcessEnv);
    expect(cfg.imap.smtp).toMatchObject({ host: "smtp.fastmail.com", port: 465, secure: true });
  });

  it("sends through the SAME login it reads with — one credential per mailbox", () => {
    // The widening's invariant: send authenticates with the IMAP user and password, not a second
    // SMTP secret. There is no OHMAIL_SMTP_USER/PASS to read, so the only credential in play is the
    // one already sealed for the mailbox.
    const cfg = configFromEnv({
      ...base, OHMAIL_SMTP_HOST: "smtp.gmail.com", OHMAIL_SMTP_PORT: "465",
    } as NodeJS.ProcessEnv);
    expect(cfg.imap.smtp?.auth).toEqual({ user: "mila@example.test", pass: "app-password" });
    expect(cfg.imap.smtp?.auth?.user).toBe(cfg.imap.auth.user);
    expect(cfg.imap.smtp?.auth?.pass).toBe(cfg.imap.auth.pass);
  });

  it("reads 587 as STARTTLS when the shell spells secure as 0 (iCloud)", () => {
    // iCloud's send port is STARTTLS, so the shell passes OHMAIL_SMTP_SECURE=0 — spelled exactly,
    // because an unset value means implicit TLS.
    const cfg = configFromEnv({
      ...base, OHMAIL_SMTP_HOST: "smtp.mail.me.com", OHMAIL_SMTP_PORT: "587", OHMAIL_SMTP_SECURE: "0",
    } as NodeJS.ProcessEnv);
    expect(cfg.imap.smtp).toMatchObject({ host: "smtp.mail.me.com", port: 587, secure: false });
  });

  it("omits SMTP auth on a launch that carries no password, exactly as IMAP does", () => {
    // Steady state: the password lives sealed in the store, not in the environment, so neither IMAP
    // nor SMTP carries one here — the send adapter reads the sealed credential back.
    const env = { ...base, OHMAIL_SMTP_HOST: "smtp.gmail.com" } as Record<string, string>;
    delete env.OHMAIL_IMAP_PASS;
    const cfg = configFromEnv(env as NodeJS.ProcessEnv);
    expect(cfg.imap.smtp?.auth).toBeUndefined();
    expect(cfg.imap.auth).toEqual({ user: "mila@example.test" });
  });
});

describe("the engine vitals interval knob", () => {
  const base = {
    OHMAIL_DATA_DIR: "/tmp/ohmail",
    OHMAIL_IMAP_HOST: "imap.fastmail.com",
    OHMAIL_IMAP_USER: "mila@example.test",
  };

  /**
   * THE SHIPPED DEFAULT IS READ FROM THE CODE, NEVER FROM A LITERAL HERE. An absent knob leaves
   * the field absent, which is how `startEngineVitals` comes to use its own constant — a test
   * that asserted 300000 would go on passing after somebody changed the shipped cadence.
   */
  it("is absent by default, so the shipped interval stands", () => {
    expect(configFromEnv(base as NodeJS.ProcessEnv).vitalsIntervalMs).toBeUndefined();
    expect(configFromEnv({ ...base, OHMAIL_ENGINE_VITALS_MS: "  " } as NodeJS.ProcessEnv)
      .vitalsIntervalMs).toBeUndefined();
    expect(ENGINE_VITALS_INTERVAL_MS).toBeGreaterThanOrEqual(VITALS_INTERVAL_MIN_MS);
    expect(ENGINE_VITALS_INTERVAL_MS).toBeLessThanOrEqual(VITALS_INTERVAL_MAX_MS);
  });

  it("takes a value inside the range", () => {
    for (const ms of [VITALS_INTERVAL_MIN_MS, 5_000, VITALS_INTERVAL_MAX_MS]) {
      expect(configFromEnv({ ...base, OHMAIL_ENGINE_VITALS_MS: ` ${ms} ` } as NodeJS.ProcessEnv)
        .vitalsIntervalMs).toBe(ms);
    }
  });

  /* Each refusal names the VARIABLE and the range, and the value itself is never echoed: the
     operator knows what they set, and an environment value is not this process's to repeat. */
  it("refuses a value outside the range, and garbage, by name", () => {
    for (const raw of [
      String(VITALS_INTERVAL_MIN_MS - 1),
      String(VITALS_INTERVAL_MAX_MS + 1),
      "0",
      "-5000",
      "nonsense",
      "5000.5",
      "",
    ]) {
      const env = { ...base, OHMAIL_ENGINE_VITALS_MS: raw || "x" } as NodeJS.ProcessEnv;
      expect(() => configFromEnv(env), raw).toThrow(/OHMAIL_ENGINE_VITALS_MS/);
      expect(() => configFromEnv(env), raw)
        .toThrow(new RegExp(`${VITALS_INTERVAL_MIN_MS}.*${VITALS_INTERVAL_MAX_MS}`));
    }
  });
});

describe("standDownFromEnv", () => {
  it("reads the stand-down knob alone — it composes nothing, so it is not a sidecar config field", () => {
    expect(standDownFromEnv({} as NodeJS.ProcessEnv)).toEqual({});
    expect(standDownFromEnv({ OHMAIL_HOST_STAND_DOWN: " 8799 " } as NodeJS.ProcessEnv))
      .toEqual({ standDownPort: 8799 });
    // Garbage is carried THROUGH, not judged here: `resolveStandDownPort` is the one place that
    // rules on the value, and its refusal names the variable rather than killing the boot.
    expect(standDownFromEnv({ OHMAIL_HOST_STAND_DOWN: "nonsense" } as NodeJS.ProcessEnv).standDownPort)
      .toBeNaN();
    // Armed is carried through too, because "armed AND holding" is a contradiction the resolver
    // must be able to SEE in order to refuse it by name.
    expect(standDownFromEnv({
      OHMAIL_HOST_MODE: "1", OHMAIL_HOST_STAND_DOWN: "8799",
    } as NodeJS.ProcessEnv)).toEqual({ hostMode: true, standDownPort: 8799 });
    expect(standDownFromEnv({ OHMAIL_HOST_MODE: "true" } as NodeJS.ProcessEnv)).toEqual({});
  });
});
