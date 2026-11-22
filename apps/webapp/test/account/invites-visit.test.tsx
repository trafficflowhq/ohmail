/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot } from "@ohmail/app/account";
import { en, json, refusal, serve, settle, type Server } from "./account-harness";
import { qr, watchClipboard, Words } from "./devices-support";
import { useInvitesDoor } from "../../app/(product)/mailbox/invites-door";
import { Frame } from "@ohmail/app/frame";
import { MailGround, mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";
import { fakeMail } from "../../../../packages/app/test/reader/support/fake-mail.js";
import { fakeAddress } from "../../../../packages/app/test/support/fake-window.js";

/**
 * The exact requests of an Invites visit through Settings. A named invite asks for the factor,
 * the retry mints the link, and the next invite is refused. Then revoke takes away the listed code.
 */

const LIST = "GET /api/pair";
const MINT = "POST /api/pair";
const REVOKE = "DELETE /api/pair/pt-1";
/* What the server makes for the invite: both sides draw it, neither list carries it. */
const MADE = createHash("sha256").update("invites-visit fixture").digest("base64url");
const INVITE = {
  id: "pt-1",
  grant: "invite",
  label: "Rahel Beck",
  createdAt: "2026-08-10T09:00:00.000Z",
  expiresAt: "2026-08-17T09:00:00.000Z",
  consumedAt: null,
  revokedAt: null,
  status: "live",
};

let server: Server;
let clipboard: ReturnType<typeof watchClipboard>;
let verify: (() => void) | null = null;
const factor: FactorSlot = (ask) => {
  verify = ask.onVerified;
  return null;
};

/** The visit's script, the same for both: a server whose list answers what the visit has done so far. */
function scripted(): Server {
  let invites: unknown[] = [];
  let made = 0;
  const visited = serve({
    [LIST]: () => json({ items: invites }),
    [MINT]: () => {
      made += 1;
      if (made > 1) return refusal(500, "internal");
      invites = [INVITE];
      return json({
        id: INVITE.id,
        token: MADE,
        grant: "invite",
        label: INVITE.label,
        expiresAt: INVITE.expiresAt,
      });
    },
    [REVOKE]: () => {
      invites = [];
      return refusal(404, "not_found");
    },
  });
  visited.answer(MINT, refusal(403, "step_up_required"));
  return visited;
}

beforeEach(() => {
  verify = null;
  clipboard = watchClipboard();
  server = scripted();
});
afterEach(() => {
  cleanup();
  server.restore();
  clipboard.restore();
});

const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await settle();
};

async function walk(pane: ReactNode, factorVerified: () => void): Promise<string[]> {
  const { unmount } = render(<Words>{pane}</Words>);
  const recipient = await screen.findByRole("textbox", { name: en.invites.mintFor });
  await act(async () => {
    fireEvent.change(recipient, { target: { value: "Rahel Beck" } });
  });
  await press(en.invites.mintAction);
  await act(async () => factorVerified());
  await settle();
  await press(en.invites.copyLink);
  await press(en.invites.mintedDone);
  await press(en.invites.mintAction);
  await press(en.invites.revoke);
  unmount();
  await settle();
  return server.asked();
}

describe("one visit to Settings › Invites asks the server the same things, in the same order", () => {
  it("the shipped section and the new pane", async () => {
    const settings = mailSettings({
      ...NO_PANE_PARTS,
      invites: { useDoor: useInvitesDoor, factor, qr },
    });
    const { host } = fakeHost({
      engine: fakeMail([]).engine, service: "self", scope: "invites-visit",
      address: fakeAddress("#/settings/invites"), places: { settings }, above: MailGround,
      features: { invites: { name: "invites", render: () => null } },
    });
    const asked = await walk(<Frame host={host} />, () => verify!());

    expect(asked).toEqual([
      `${LIST} {}`,
      `${MINT} {grant,label}`,
      `${MINT} {grant,label}`,
      `${LIST} {}`,
      `${MINT} {grant}`,
      `${REVOKE} {}`,
      `${LIST} {}`,
    ]);
    expect(clipboard.written).toHaveLength(1);
    expect(clipboard.written).toEqual([`${window.location.origin}/join/invite#${MADE}`]);
  });
});
