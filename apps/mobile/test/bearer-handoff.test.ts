/**
 * THE PHONE'S ROTATION THAT ALSO ASKS FOR A HANDOFF: one flight at the handoff's door with the same attempt
 * discipline, the pair adopted, the code handed back once; an old server's 404 keeps the pair and its attempt.
 */
import { describe, expect, it } from "vitest";
import { BearerManagerRN, type RefreshVault } from "../src/net/bearer";

const CODE = "c".repeat(43);
const CHALLENGE = "h".repeat(43);

function vault() {
  const saved: string[] = [];
  const armed: string[] = [];
  const v: RefreshVault = {
    save: async (token) => (saved.push(token), "saved" as never),
    clear: async () => "cleared" as never,
    armAttempt: async (attemptId) => (armed.push(attemptId), "saved" as never),
    oweSignOut: async () => true,
  };
  return { v, saved, armed };
}

function door(answer: (url: string, body: Record<string, unknown>) => Response) {
  const asked: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string, init?: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as Record<string, unknown>;
    asked.push({ url, body });
    return answer(url, body);
  };
  return { asked, fetchImpl };
}

const minted = (handoff: unknown) =>
  new Response(JSON.stringify({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 3600 }, handoff }), {
    status: 200, headers: { "content-type": "application/json" },
  });

describe("the rotation that asks for a handoff", () => {
  it("rotates at the handoff's door with the challenge, adopts the pair and hands the code back once", async () => {
    const { v, saved, armed } = vault();
    const { asked, fetchImpl } = door(() => minted({ token: CODE, expiresIn: 60 }));
    const bearer = new BearerManagerRN({ origin: "https://mail.example.test", refreshToken: "r1", vault: v, fetchImpl });
    expect(await bearer.renewForHandoff({ challenge: CHALLENGE, target: "ohcal" })).toEqual({ token: CODE, expiresIn: 60 });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://mail.example.test/pair/handoff");
    expect(asked[0]!.body).toMatchObject({ refreshToken: "r1", challenge: CHALLENGE, target: "ohcal" });
    expect(asked[0]!.body.attemptId).toBe(armed[0]);
    expect(saved).toEqual(["r2"]);
  });

  it("adopts the rotated pair and hands back nothing when the server minted no code", async () => {
    const { v, saved } = vault();
    const { fetchImpl } = door(() => minted(null));
    const bearer = new BearerManagerRN({ origin: "https://mail.example.test", refreshToken: "r1", vault: v, fetchImpl });
    expect(await bearer.renewForHandoff({ challenge: CHALLENGE, target: "ohcal" })).toBeNull();
    expect(saved).toEqual(["r2"]);
    // A code of the wrong shape is no code.
    const odd = new BearerManagerRN({
      origin: "https://mail.example.test", refreshToken: "r1", vault: vault().v,
      fetchImpl: door(() => minted({ token: "short", expiresIn: 60 })).fetchImpl,
    });
    expect(await odd.renewForHandoff({ challenge: CHALLENGE, target: "ohcal" })).toBeNull();
  });

  it("keeps the pair and its attempt on a server without the door, and the next rotation retries as the same attempt", async () => {
    const { v, saved } = vault();
    const { asked, fetchImpl } = door((url) =>
      url.endsWith("/pair/handoff") ? new Response("not found", { status: 404 }) : minted(undefined));
    const bearer = new BearerManagerRN({ origin: "https://mail.example.test", refreshToken: "r1", vault: v, fetchImpl });
    expect(await bearer.renewForHandoff({ challenge: CHALLENGE, target: "ohmail" })).toBeNull();
    expect(saved).toEqual([]);
    bearer.renew();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(asked.map((a) => a.url.replace("https://mail.example.test", ""))).toEqual(["/pair/handoff", "/auth/refresh"]);
    expect(asked[1]!.body.attemptId).toBe(asked[0]!.body.attemptId);
    expect(asked[1]!.body).not.toHaveProperty("challenge");
  });
});
