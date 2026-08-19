import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_PROBLEMS,
  armHostMode,
  disarmHostMode,
  getAutostart,
  hostState,
  hostStateOfPayload,
  openTailscaleDownload,
  setAutostart,
  tailscaleStatus,
  tailscaleStatusOfPayload,
} from "../src/host.js";

/**
 * HOST MODE'S WINDOW-SIDE HALF, driven rather than described.
 *
 * Two claims carry this file:
 *
 *  1. the bindings call the commands the shell declares — the exact names build.rs puts in the
 *     manifest and `LOCAL_ENGINE_CAPABILITY` grants, with the exact payload keys the Rust
 *     signatures take. A drifted name here is a button that rejects with "command not found" on
 *     every install, which no typecheck on either side can see.
 *  2. every answer is PARSED against a closed union, never cast — a shell one version ahead can
 *     name a state this bundle has never heard of, and the honest reading of that is null, not a
 *     screen rendering a word it does not know. The one deliberate asymmetry (an unknown problem
 *     inside a readable state degrades to null rather than voiding the answer) is pinned too.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: Invoke;
    transformCallback?: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}

const host = globalThis as unknown as Host;

interface Asked {
  command: string;
  payload?: Record<string, unknown>;
}

function shellAnswering(answer: (command: string) => unknown): Asked[] {
  const asked: Asked[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      asked.push(payload === undefined ? { command } : { command, payload });
      return Promise.resolve(answer(command));
    },
  };
  return asked;
}

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

const A_STATE = {
  enabled: true,
  port: 3311,
  origin: "https://mac.tail1234.ts.net",
  // The same-network half: the chosen address and its own closed state, null when off.
  lan: null,
  lanState: null,
  state: "serving",
  problem: null,
  autostart: true,
};

describe("the command bindings", () => {
  it("call the shell's exact command names with the exact payload keys", async () => {
    const asked = shellAnswering((command) =>
      command === "autostart_get" || command === "autostart_set" ? true : A_STATE,
    );
    await hostState();
    await tailscaleStatus();
    await armHostMode(3311, true);
    await disarmHostMode();
    await getAutostart();
    await setAutostart(false);
    await openTailscaleDownload();
    expect(asked).toEqual([
      { command: "host_state" },
      { command: "tailscale_status" },
      { command: "tailscale_serve_arm", payload: { port: 3311, autostart: true, lan: null } },
      { command: "tailscale_serve_disarm" },
      { command: "autostart_get" },
      { command: "autostart_set", payload: { enabled: false } },
      { command: "open_tailscale_download" },
    ]);
  });

  it("refuses a port outside the contract before anything crosses the bridge", async () => {
    const asked = shellAnswering(() => A_STATE);
    // 1–65535 is the frozen contract; 0 is "any free port", which a fixed tailnet registration
    // cannot point at — and a caller passing it is a bug, not a guided state.
    for (const bad of [0, -1, 65536, 3.5, Number.NaN]) {
      await expect(armHostMode(bad, true)).rejects.toThrow(RangeError);
    }
    expect(asked).toEqual([]);
  });

  it("answers null without a shell, because this bundle also loads outside the app", async () => {
    expect(await hostState()).toBeNull();
    expect(await tailscaleStatus()).toBeNull();
    expect(await getAutostart()).toBeNull();
    // …and the opener is a silent no-op, same as every native call in this situation.
    await openTailscaleDownload();
  });
});

describe("the host-state union", () => {
  it("reads the shell's answer, closed field by field", () => {
    expect(hostStateOfPayload(A_STATE)).toEqual(A_STATE);
    // Degraded with a typed problem — the shape the guidance screens key off.
    expect(
      hostStateOfPayload({ ...A_STATE, state: "degraded", problem: "not-logged-in" }),
    ).toMatchObject({ state: "degraded", problem: "not-logged-in" });
  });

  it("refuses what it does not recognise instead of rendering it", () => {
    // A state this bundle has never heard of is an answer it cannot read.
    expect(hostStateOfPayload({ ...A_STATE, state: "publishing" })).toBeNull();
    expect(hostStateOfPayload({ ...A_STATE, enabled: "yes" })).toBeNull();
    expect(hostStateOfPayload("serving")).toBeNull();
    expect(hostStateOfPayload(null)).toBeNull();
    // Ports that are not ports read as absent, never as numbers to dial.
    expect(hostStateOfPayload({ ...A_STATE, port: 0 })?.port).toBeNull();
    expect(hostStateOfPayload({ ...A_STATE, port: "3311" })?.port).toBeNull();
    expect(hostStateOfPayload({ ...A_STATE, port: 70000 })?.port).toBeNull();
  });

  it("degrades an unknown problem to null rather than voiding the whole answer", () => {
    // The deliberate asymmetry: "degraded for a reason this build cannot name" is still true and
    // still renderable — the screens show their generic guidance.
    const read = hostStateOfPayload({
      ...A_STATE,
      state: "degraded",
      problem: "some-future-reason",
    });
    expect(read).not.toBeNull();
    expect(read?.state).toBe("degraded");
    expect(read?.problem).toBeNull();
  });

  it("mirrors the shell's problem vocabulary exactly", () => {
    // The Rust side's `Problem::as_str` values, pinned there by its own test. A rename on either
    // side must fail one of the two.
    expect([...HOST_PROBLEMS]).toEqual([
      "no-cli",
      "not-running",
      "not-logged-in",
      "no-dns-name",
      "serve-refused",
      "local-door-required",
      "engine-not-serving",
      "listener-pending",
      "listener-skipped",
      "listener-failed",
      "host-config-invalid",
    ]);
  });
});

describe("the tailscale-status union", () => {
  it("reads a running tailnet and each guided state", () => {
    expect(
      tailscaleStatusOfPayload({ state: "running", dnsName: "mac.tail1234.ts.net", version: "1.86.2" }),
    ).toEqual({ state: "running", dnsName: "mac.tail1234.ts.net", version: "1.86.2" });
    for (const guided of ["no-cli", "not-running", "not-logged-in", "no-dns-name"]) {
      expect(tailscaleStatusOfPayload({ state: guided })).toEqual({ state: guided });
    }
  });

  it("refuses a running claim without a name, and states it has never heard of", () => {
    // Running with no DNS name is not a state the shell emits — it maps that to no-dns-name —
    // so an answer shaped that way is one this window does not know.
    expect(tailscaleStatusOfPayload({ state: "running", dnsName: "" })).toBeNull();
    expect(tailscaleStatusOfPayload({ state: "running" })).toBeNull();
    expect(tailscaleStatusOfPayload({ state: "funneling" })).toBeNull();
    expect(tailscaleStatusOfPayload(undefined)).toBeNull();
  });
});
