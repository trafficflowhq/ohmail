import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, req } from "./helpers.js";

/**
 * `/health` on a host that retired a key version. The host asks its database whether a stored secret
 * still names a version it no longer holds (the `kekRetirement` capability), once per instance, and
 * answers 503 while one does or while it cannot tell: the operator reads it right after the redeploy
 * that removed the version, before any user reaches a secret this host cannot open. The capability is
 * contracted not to throw, and a throw is no reading. Absent, nothing changes.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });
const IN_USE = {
  error: "kek_retired_version_in_use",
  detail: "a stored secret still names a key version this host retired",
};

describe("GET /health — a retired key version still in use", () => {
  it("answers 503 with the host's own code and sentence when a stored secret names a retired version", async () => {
    const { deps } = await makeDeps();
    let asked = 0;
    const res = await H(req("GET", "/health"), {
      ...deps, health: { version: "v", kekRetirement: async () => { asked++; return IN_USE; } },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe(IN_USE.error);
    expect(body.detail).toBe(IN_USE.detail);
    expect(asked).toBe(1);
  });

  it("answers 503 when the host could not tell", async () => {
    const { deps } = await makeDeps();
    const unread = { error: "kek_retirement_unread", detail: "could not be read" };
    const res = await H(req("GET", "/health"), {
      ...deps, health: { version: "v", kekRetirement: async () => unread },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("kek_retirement_unread");
  });

  it("answers 200 when nothing names a retired version", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"), {
      ...deps, health: { version: "v", kekRetirement: async () => null },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("a capability that throws anyway is no reading: the verdict is untouched", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"), {
      ...deps, health: { version: "v", kekRetirement: async () => { throw new Error("boom"); } },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).error).toBeUndefined();
  });

  it("a broken key environment outranks it: the ring's own fault is the one named", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"), {
      ...deps, health: { version: "v", kekError: "the ring is broken", kekRetirement: async () => IN_USE },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("kek_env_invalid");
  });
});
