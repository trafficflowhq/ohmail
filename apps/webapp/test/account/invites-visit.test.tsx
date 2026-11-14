/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot } from "@ohmail/app/account";
import { en, json, refusal, serve, settle, type Server } from "./account-harness";
import { qr, watchClipboard, Words } from "./devices-support";
import { InvitesPane, useInvites } from "../../../../packages/app/src/account/invites/index.js";
import { useInvitesDoor } from "../../app/(product)/mailbox/invites-door";
import { InvitesSection } from "../../app/(product)/mailbox/InvitesSection";

/**
 * THE CALLS OF ONE VISIT, BEFORE AND AFTER. The shipped section and the new pane over the web's filling are each
 * walked through the same visit over the same scripted server: open; an invite made for a name, refused for the
 * factor, the factor verified, the link made; Copy; Done; a second invite the server refuses outright; the open
 * invite revoked, already gone at the server; leave. The two ordered lists of method, path and body keys are equal.
 * The factor's own ceremony is the doors' dialog's (both stand in for it here, so neither list carries it); what
 * is compared is what the pane asks.
 */

/** The shipped section's factor prompt, stood in for: the case answers it as the dialog would. */
const prompt = vi.hoisted(() => ({ verified: null as null | (() => void) }));
vi.mock("../../app/(product)/mailbox/StepUpPrompt", () => ({
  StepUpPrompt: (props: { onVerified: () => void }) => {
    prompt.verified = props.onVerified;
    return null;
  },
}));

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
  prompt.verified = null;
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
  await settle();
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: en.invites.mintFor }), {
      target: { value: "Rahel Beck" },
    });
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
    const before = await walk(<InvitesSection />, () => prompt.verified!());
    const copiedBefore = [...clipboard.written];
    cleanup();
    server.restore();
    clipboard.restore();
    clipboard = watchClipboard();
    server = scripted();

    function Anew() {
      return <InvitesPane model={useInvites(useInvitesDoor())} factor={factor} qr={qr} />;
    }
    const after = await walk(<Anew />, () => verify!());

    expect(before).toEqual([
      `${LIST} {}`,
      `${MINT} {grant,label}`,
      `${MINT} {grant,label}`,
      `${LIST} {}`,
      `${MINT} {grant}`,
      `${REVOKE} {}`,
      `${LIST} {}`,
    ]);
    expect(after).toEqual(before);
    // Both hand the clipboard one link, the same one.
    expect(copiedBefore).toHaveLength(1);
    expect(clipboard.written).toEqual(copiedBefore);
  });
});
