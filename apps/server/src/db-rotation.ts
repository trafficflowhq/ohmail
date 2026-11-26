import { createHmac, timingSafeEqual } from "node:crypto";
import { freshConnectProbe } from "@trafficflow/db/cloud";

export const DB_ROTATION_PATH = "/internal/db-rotation-proof";
const fixtureId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export interface RotationProofSettings {
  secret: string;
  revision: string;
  deployment: string;
  pooled: string;
  session: string;
}

/** Prove both fresh connections can read the signed synthetic rows. */
export function dbRotationProof(
  config: RotationProofSettings,
  dial: typeof freshConnectProbe = freshConnectProbe,
): (req: Request) => Promise<Response> {
  const mac = (parts: readonly string[]) => createHmac("sha256", config.secret).update(JSON.stringify(parts)).digest();
  let checking = false;
  return async (req) => {
    const headers = { "cache-control": "no-store" };
    const challenge = req.headers.get("x-ohmail-rotation-challenge") ?? "";
    const account = req.headers.get("x-ohmail-rotation-account") ?? "";
    const message = req.headers.get("x-ohmail-rotation-message") ?? "";
    const { deployment } = config;
    const common = [challenge, config.revision, deployment, account, message];
    const authorization = req.headers.get("authorization") ?? "";
    const provided = /^Ohmail-Rotation ([0-9a-f]{64})$/.exec(authorization)?.[1];
    const [time] = challenge.split(".");
    if (req.method !== "HEAD" || !/^[0-9]{13}\.[0-9a-f]{64}$/.test(challenge) ||
        !fixtureId.test(account) || !fixtureId.test(message) ||
        req.headers.get("x-ohmail-rotation-deployment") !== deployment ||
        Math.abs(Date.now() - Number(time)) > 30_000 || !provided ||
        !timingSafeEqual(Buffer.from(provided, "hex"), mac(["request", ...common]))) {
      return new Response(null, { status: 404, headers });
    }
    if (checking) return new Response(null, { status: 503, headers });
    checking = true;
    try {
      const results = await Promise.all([config.pooled, config.session].map((url) =>
        dial(url, { memoMs: 0, apiAccess: { account, message } })()));
      if (results.some(({ ok }) => !ok)) return new Response(null, { status: 503, headers });
      return new Response(null, { status: 200, headers: {
        ...headers,
        "x-ohmail-rotation-proof": mac(["response", ...common, config.pooled, config.session]).toString("hex"),
      } });
    } finally { checking = false; }
  };
}
