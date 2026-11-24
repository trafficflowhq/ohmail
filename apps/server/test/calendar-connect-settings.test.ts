import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { MANAGED_ENV, PLAIN_ENV, PROCESS_DOOR, env, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";

/**
 * THE CONNECT DOOR'S SETTINGS, on both services. A way that signs in at its provider is offered
 * only on its switch's exact word, and a value that is neither that word nor off refuses the start,
 * so a typo cannot pass for either. What a typed address may name is the managed service's `cloud`
 * whatever its environment holds, and a self-hosted server's own network only on the operator's
 * exact word. The door is handed its port only beside the calendar, and no resolver with it.
 */

const open: Program[] = [];
afterEach(async () => { for (const p of open.splice(0)) await p.close(); });

const managed = (extra: Record<string, string> = {}) => loadSettings(env(MANAGED_ENV, extra), functionDoor()).calendar;
const plain = (extra: Record<string, string> = {}) => loadSettings(env(PLAIN_ENV, extra), PROCESS_DOOR).calendar;
const OFF = { on: false, configured: false };

describe("OHCAL_CONNECT_GOOGLE and OHCAL_CONNECT_MICROSOFT", () => {
  it("are off unset and at 0, on at exactly 1, and say whether the provider's client is configured", () => {
    for (const read of [managed, plain]) {
      expect(read().connect).toEqual({ google: OFF, microsoft: OFF });
      expect(read({ OHCAL_CONNECT_GOOGLE: "0", OHCAL_CONNECT_MICROSOFT: "0" }).connect).toEqual({ google: OFF, microsoft: OFF });
      expect(read({ OHCAL_CONNECT_GOOGLE: "1", OHCAL_CONNECT_MICROSOFT: "1" }).connect)
        .toEqual({ google: { on: true, configured: false }, microsoft: { on: true, configured: false } });
      // A variable handed on empty is one that is not set.
      expect(read({ OHCAL_CONNECT_GOOGLE: "", OHCAL_CONNECT_MICROSOFT: "" }).connect).toEqual({ google: OFF, microsoft: OFF });
      // A configured client alone switches nothing on.
      const client = { OHCAL_GOOGLE_CLIENT_ID: "id.example", OHCAL_GOOGLE_CLIENT_SECRET: ["calendar", "google", "fixture"].join("-"), OHCAL_MICROSOFT: "1" };
      expect(read(client).connect).toEqual({ google: { on: false, configured: true }, microsoft: { on: false, configured: true } });
      expect(read({ OHCAL_GOOGLE_CLIENT_ID: "id.example" }).connect.google).toEqual(OFF);
    }
  });

  it("refuse the start on any other value, by the variable's name and never its value", () => {
    for (const name of ["OHCAL_CONNECT_GOOGLE", "OHCAL_CONNECT_MICROSOFT"]) {
      // The word is read as it stands: a padded 1 is not the word, and is refused like any other.
      for (const loose of ["true", "yes", "on", "2", "01", " 1", "1 ", " 1 ", " 0"]) {
        for (const read of [managed, plain]) {
          expect(() => read({ [name]: loose }), `${name}=${JSON.stringify(loose)}`).toThrow(new RegExp(`^${name} must be 1`));
        }
      }
    }
  });
});

describe("what a typed calendar address may name", () => {
  it("is cloud on the managed service whatever the variable says, and a self-hosted server's own network only by exactly 1", () => {
    expect(managed().policy).toBe("cloud");
    expect(managed({ OHCAL_ALLOW_PRIVATE: "1" }).policy).toBe("cloud");
    expect(plain().policy).toBe("cloud");
    expect(plain({ OHCAL_ALLOW_PRIVATE: "1" }).policy).toBe("own-network");
    for (const loose of ["true", "yes", " 1", "01", ""]) expect(plain({ OHCAL_ALLOW_PRIVATE: loose }).policy, JSON.stringify(loose)).toBe("cloud");
  });
});

describe("the door's port in the composition", () => {
  const program = (extra: Record<string, string>, kind: "managed" | "plain"): Program => {
    const p = kind === "managed"
      ? buildProgram(loadSettings(env(MANAGED_ENV, extra), functionDoor()), functionInput(recordingLogger().logger))
      : buildProgram(loadSettings(env(PLAIN_ENV, extra), PROCESS_DOOR), processInput(recordingLogger().logger));
    open.push(p);
    return p;
  };

  it("is handed only beside the calendar, with the policy and the switches and nothing that dials", () => {
    for (const kind of ["managed", "plain"] as const) {
      expect(program({}, kind).services.calendarConnect).toBeUndefined();
      expect(program({ OHCAL_CONNECT_GOOGLE: "1" }, kind).services.calendarConnect).toBeUndefined();
    }
    expect(program({ OHMAIL_CALENDAR: "1", OHCAL_ALLOW_PRIVATE: "1", OHCAL_CONNECT_GOOGLE: "1" }, "managed").services.calendarConnect)
      .toEqual({ policy: "cloud", ceremonies: { google: { on: true, configured: false }, microsoft: OFF } });
    expect(program({ OHMAIL_CALENDAR: "1", OHCAL_ALLOW_PRIVATE: "1" }, "plain").services.calendarConnect)
      .toEqual({ policy: "own-network", ceremonies: { google: OFF, microsoft: OFF } });
  });

  it("mounts the door's routes behind a session, and none without the calendar", async () => {
    const ask = (p: Program, path: string): Promise<Response> => p.dispatch(new Request(`https://api.ohmail.app${path}`));
    expect((await ask(program({}, "plain"), "/calendar/connect")).status).toBe(404);
    expect((await ask(program({ OHMAIL_CALENDAR: "1" }, "plain"), "/calendar/connect")).status).toBe(401);
    expect((await ask(program({ OHMAIL_CALENDAR: "1" }, "managed"), "/calendar/connect")).status).toBe(401);
  });
});
