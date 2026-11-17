/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot } from "@ohmail/app/account";
import { en, json, refusal, serve, settle, type Server } from "./account-harness";
import { hello, qr, watchClipboard, Words } from "./devices-support";
import { DevicesPane, useDevices } from "../../../../packages/app/src/account/devices/index.js";
import { serverHello } from "../../app/hello";
import { useDevicesDoor } from "../../app/(product)/mailbox/devices-door";
import { DevicesSection } from "../../app/(product)/mailbox/DevicesSection";

/**
 * THE CALLS OF ONE VISIT, BEFORE AND AFTER. The shipped section and the new pane over the web's filling are each
 * walked through the same visit over the same scripted server: open; a device added for a name, refused for the
 * factor, the factor verified, the link made; Copy; Done; a second add the server refuses outright; the code
 * revoked, already gone at the server; the phone signed out; the other browser sessions signed out; leave. The two
 * ordered lists of method, path and body keys are equal. The factor's own ceremony is the doors' dialog's (both
 * stand in for it here, so neither list carries it); what is compared is what the pane asks.
 *
 * The web client admits its reads through one lane. While the API has answered lately they leave at once; after
 * half a minute of silence the first read leads and the others follow its answer. Which it is decides the order
 * the mount's three reads leave in, so the two walks are compared from the same state, once each way.
 */

/** The shipped section's factor prompt, stood in for: the case answers it as the dialog would. */
const prompt = vi.hoisted(() => ({ verified: null as null | (() => void) }));
vi.mock("../../app/(product)/mailbox/StepUpPrompt", () => ({
  StepUpPrompt: (props: { onVerified: () => void }) => {
    prompt.verified = props.onVerified;
    return null;
  },
}));

const DEVICES = "GET /api/devices";
const CODES = "GET /api/pair";
const HELLO = "GET /api/hello";
const MINT = "POST /api/pair";
const REVOKE = "DELETE /api/pair/pt-1";
const REMOVE = "DELETE /api/devices/dev-2";
const BULK = "POST /api/devices/revoke-web-sessions";
/* What the server makes for the new device: both sides draw it, neither list carries it. */
const MADE = createHash("sha256").update("devices-visit fixture").digest("base64url");

const at = {
  createdAt: "2026-08-10T09:00:00.000Z",
  lastSeenAt: "2026-08-19T09:00:00.000Z",
  ip: "",
  pushToken: null,
};
const THIS = { id: "dev-1", kind: "web", label: "", current: true, named: false, ...at };
const PHONE = {
  id: "dev-2",
  kind: "mobile-android",
  label: "Mila's phone",
  current: false,
  named: true,
  ...at,
};
const plain = (n: number) => ({
  id: `sess-${n}`,
  kind: "web",
  label: "",
  current: false,
  named: false,
  ...at,
});
const CODE = {
  id: "pt-1",
  grant: "device-pair",
  label: "Ben",
  createdAt: "2026-08-20T09:00:00.000Z",
  expiresAt: "2026-08-20T09:05:00.000Z",
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

/** The visit's script, the same for both: a server whose lists answer what the visit has done so far. */
function scripted(): Server {
  let sessions: unknown[] = [THIS, PHONE, plain(1), plain(2)];
  let codes: unknown[] = [];
  let made = 0;
  const visited = serve({
    [DEVICES]: () => json({ items: sessions }),
    [CODES]: () => json({ items: codes }),
    [HELLO]: () => hello("managed"),
    [MINT]: () => {
      made += 1;
      if (made > 1) return refusal(500, "internal");
      codes = [CODE];
      return json({
        id: CODE.id,
        token: MADE,
        grant: "device-pair",
        label: "Ben",
        expiresAt: CODE.expiresAt,
      });
    },
    [REVOKE]: () => {
      codes = [];
      return refusal(404, "not_found");
    },
    [REMOVE]: () => {
      sessions = sessions.filter((session) => session !== PHONE);
      return new Response(null, { status: 204 });
    },
    [BULK]: () => {
      sessions = [THIS];
      return json({ revoked: 2 });
    },
  });
  visited.answer(MINT, refusal(403, "step_up_required"));
  return visited;
}

beforeEach(() => {
  // The lane reads the clock: only the clock is stood in for, so a pause can pass at once.
  vi.useFakeTimers({ toFake: ["Date"] });
  verify = null;
  prompt.verified = null;
  clipboard = watchClipboard();
  server = scripted();
});
afterEach(() => {
  cleanup();
  server.restore();
  clipboard.restore();
  vi.useRealTimers();
});

const press = async (name: string, inside: HTMLElement = document.body) => {
  await act(async () => {
    fireEvent.click(within(inside).getByRole("button", { name }));
  });
  await settle();
};

/** What differs between the two: where a removal's question is answered, and who answers the factor. */
interface Side {
  readonly factorVerified: () => void;
  /** The question's own answer, after the press that asked. */
  readonly confirm: (name: string) => Promise<void>;
}

async function walk(pane: ReactNode, side: Side): Promise<string[]> {
  const { unmount } = render(<Words>{pane}</Words>);
  await settle();
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: en.devices.addFor }), { target: { value: "Ben" } });
  });
  await press(en.devices.addAction);
  await act(async () => side.factorVerified());
  await settle();
  await press(en.devices.copyLink);
  await press(en.devices.mintedDone);
  await press(en.devices.addAction);
  await press(en.devices.revoke);
  await press(en.devices.remove);
  await side.confirm(en.devices.remove);
  await press(en.devices.webGroupAction);
  await side.confirm(en.devices.webGroupAction);
  unmount();
  await settle();
  return server.asked();
}

/** Longer than the lane's half minute: after it, the next read leads. */
const A_PAUSE_MS = 60_000;

/** The lane as a walk finds it: the API answered a moment ago, or has been silent for a minute. */
async function laneIs(state: "warm" | "cold"): Promise<void> {
  if (state === "cold") {
    vi.setSystemTime(Date.now() + A_PAUSE_MS);
    return;
  }
  await serverHello();
  server.forget();
}

/** Both walks, each from the same state of the lane: what each asked, and what each handed the clipboard. */
async function bothWalks(lane: "warm" | "cold") {
  await laneIs(lane);
  // The shipped section answers in the row: the press that asked turns into the answer.
  const before = await walk(<DevicesSection />, {
    factorVerified: () => prompt.verified!(),
    confirm: (name) => press(name),
  });
  const copiedBefore = [...clipboard.written];
  cleanup();
  server.restore();
  clipboard.restore();
  clipboard = watchClipboard();
  server = scripted();

  function Anew() {
    return <DevicesPane model={useDevices(useDevicesDoor())} factor={factor} qr={qr} />;
  }
  await laneIs(lane);
  // The new pane answers in its dialog.
  const after = await walk(<Anew />, {
    factorVerified: () => verify!(),
    confirm: (name) => press(name, screen.getByRole("dialog")),
  });
  return { before, after, copiedBefore, copiedAfter: [...clipboard.written] };
}

describe("one visit to Settings › Devices asks the server the same things, in the same order", () => {
  const lists = [`${DEVICES} {}`, `${CODES} {}`];
  /** What follows the mount's three reads, whatever the lane. */
  const then = [
    `${MINT} {grant,label}`,
    `${MINT} {grant,label}`,
    ...lists,
    ...lists,
    `${MINT} {grant}`,
    `${REVOKE} {}`,
    ...lists,
    `${REMOVE} {}`,
    ...lists,
    `${BULK} {}`,
    ...lists,
  ];

  it("the shipped section and the new pane, while the API has answered lately", async () => {
    const { before, after, copiedBefore, copiedAfter } = await bothWalks("warm");
    // The handshake asks no session, so it is the first out; the lists follow, in their order.
    expect(before).toEqual([`${HELLO} {}`, ...lists, ...then]);
    expect(after).toEqual(before);
    // Both hand the clipboard one link, the same one.
    expect(copiedBefore).toHaveLength(1);
    expect(copiedAfter).toEqual(copiedBefore);
  });

  it("the shipped section and the new pane, after a pause: the devices' read leads", async () => {
    const { before, after } = await bothWalks("cold");
    expect(before).toEqual([`${DEVICES} {}`, `${HELLO} {}`, `${CODES} {}`, ...then]);
    expect(after).toEqual(before);
  });
});
