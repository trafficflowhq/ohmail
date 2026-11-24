import { expect, it, vi } from "vitest";
import { CONSENT_SETTINGS_PATH } from "@ohmail/app-logic/consent/consent-wire";
import { writeScreenerAcknowledgement } from "../src/net/consent";
import type { ConnectedSession } from "../src/net/pairing";

vi.mock("@ohmail/app-logic/consent/consent-wire", () => ({
  CONSENT_SETTINGS_PATH: "/consent/preferences",
}));

it("follows the shared settings route when it moves", async () => {
  const origin = "https://phone.example.invalid";
  const fetch = vi.fn(async () => Response.json({ screenerAcknowledgements: 4 }));
  const session = { fetch, profile: { origin, apiBase: null } } as unknown as ConnectedSession;
  expect(await writeScreenerAcknowledgement(session, "applySuggestions")).toBe(4);
  expect(fetch).toHaveBeenCalledWith(origin + CONSENT_SETTINGS_PATH, expect.objectContaining({
    method: "PATCH",
    body: JSON.stringify({ acknowledgeScreener: "applySuggestions" }),
  }));
});
