import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { dbRotationProof, DB_ROTATION_PATH } from "../src/db-rotation.js";

const deployment = "fixture-deployment";
const apiAccess = { account: randomUUID(), message: randomUUID() };
const config = {
  secret: randomBytes(32).toString("hex"), revision: "a".repeat(40),
  pooled: "fixture-pooled", session: "fixture-session", deployment,
};
const sign = (fields: readonly string[]) => createHmac("sha256", config.secret).update(JSON.stringify(fields)).digest("hex");

function request(challenge: string, requestedDeployment = deployment, signedDeployment = deployment, message = apiAccess.message) {
  return new Request(`http://localhost${DB_ROTATION_PATH}`, { method: "HEAD", headers: {
    authorization: `Ohmail-Rotation ${sign(["request", challenge, config.revision, signedDeployment, apiAccess.account, apiAccess.message])}`,
    "x-ohmail-rotation-challenge": challenge,
    "x-ohmail-rotation-deployment": requestedDeployment,
    "x-ohmail-rotation-account": apiAccess.account,
    "x-ohmail-rotation-message": message,
  } });
}

function challenge(at = Date.now()) { return `${at}.${randomBytes(32).toString("hex")}`; }

describe("managed database rotation proof", () => {
  it("checks both fresh connections and binds the answer to the loaded connections and deployment", async () => {
    const checked = vi.fn(async () => ({ ok: true, code: null, ms: 1 }));
    const dial = vi.fn(() => checked);
    const verify = dbRotationProof(config, dial);
    for (const nonce of [challenge(), challenge()]) {
      const response = await verify(request(nonce));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-ohmail-rotation-proof")).toBe(sign([
        "response", nonce, config.revision, deployment, apiAccess.account, apiAccess.message, config.pooled, config.session,
      ]));
    }
    expect(dial.mock.calls).toEqual([config.pooled, config.session, config.pooled, config.session]
      .map((url) => [url, { memoMs: 0, apiAccess }]));
    expect(checked).toHaveBeenCalledTimes(4);
  });

  it("refuses stale or wrong-deployment challenges before any database work", async () => {
    const checked = vi.fn(async () => ({ ok: true, code: null, ms: 1 }));
    const verify = dbRotationProof(config, () => checked);
    expect((await verify(request(challenge(), "older-deployment"))).status).toBe(404);
    expect((await verify(request(challenge(), "newer-deployment", "newer-deployment"))).status).toBe(404);
    expect((await verify(request(challenge(Date.now() - 60_000)))).status).toBe(404);
    expect((await verify(request(challenge(), deployment, deployment, randomUUID()))).status).toBe(404);
    expect(checked).not.toHaveBeenCalled();
  });

  it("withholds the proof when either endpoint refuses a fresh session", async () => {
    const verify = dbRotationProof(config, (url) => async () => ({ ok: url === config.pooled, code: null, ms: 1 }));
    const response = await verify(request(challenge()));
    expect(response.status).toBe(503);
    expect(response.headers.get("x-ohmail-rotation-proof")).toBeNull();
  });
});
