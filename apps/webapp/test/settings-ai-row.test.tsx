/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider } from "@ohmail/app/text";
import { OWNER_COOKIE } from "@ohmail/app-logic/storage/owner-cookie";
import en from "../messages/en.json";
import de from "../messages/de.json";

/* The client refuses every call on a build with no server behind it, so the base is set before the module loads. */
process.env.NEXT_PUBLIC_API_BASE = "/api";

vi.mock("@ohmail/app/host", async (original) => ({
  ...(await original<typeof import("@ohmail/app/host")>()),
  confirmedAccountForScope: () => "acct-one",
}));
vi.mock("@ohmail/app/frame", async (original) => ({
  ...(await original<typeof import("@ohmail/app/frame")>()),
  useFrame: () => ({ host: {} }),
}));

const { account, forgetAccess } = await import("../app/api-client");
const { WEB_PANE_PARTS } = await import("../app/(product)/mailbox/pane-parts");

/**
 * The AI entry in the web's Settings list reads the account's budget the way Subscription and Settings › AI read it:
 * the month's credits never above the allowance.
 */
const originalFetch = globalThis.fetch;
let aiCredits: unknown;

beforeEach(() => {
  forgetAccess();
  document.cookie = `${OWNER_COOKIE}=acct-one`;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ metered: true, access: "open", mailboxes: 2, canAddMailbox: true, aiCredits }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  forgetAccess();
});

function Row() {
  const row = WEB_PANE_PARTS.useAiSummary?.();
  return <p>{row?.detail ?? "none"}</p>;
}

async function drawn(lang: "en" | "de") {
  await account.access();
  render(
    <TextProvider locale={lang} messages={lang === "en" ? en : de} timeZone="Europe/Zurich">
      <Row />
    </TextProvider>,
  );
}

describe("the AI entry in the Settings list", () => {
  it("says the month's credits capped at the allowance", async () => {
    aiCredits = { remaining: 18_885, total: 4_000, setup: { remaining: 12_000, expiresAt: "2027-02-01T12:00:00Z" } };
    await drawn("en");
    await waitFor(() => expect(screen.getByText("4,000 of 4,000 this month")).toBeTruthy());
    expect(document.body.textContent).not.toContain("18,885");
  });

  it("says it in German", async () => {
    aiCredits = { remaining: 18_885, total: 4_000 };
    await drawn("de");
    await waitFor(() => expect(screen.getByText("Noch 4.000 von 4.000 diesen Monat")).toBeTruthy());
    expect(document.body.textContent).not.toContain("18.885");
  });
});
