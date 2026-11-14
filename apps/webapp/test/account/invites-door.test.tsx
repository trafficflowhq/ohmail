/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, GatedAsk } from "@ohmail/app/account";
import { catchConsole, en, foundIn, json, refusal, serve, settle, type Server } from "./account-harness";
import { qr, scanned, watchClipboard, Words } from "./devices-support";
import { InvitesPane, useInvites } from "../../../../packages/app/src/account/invites/index.js";
import { ApiError, pair } from "../../app/api-client";
import { invitesDoor, useInvitesDoor } from "../../app/(product)/mailbox/invites-door";

/**
 * SETTINGS › INVITES OVER THE WEB'S REAL FILLING and a server that records what it is asked. Each verb the server
 * guards with a fresh factor is tried as it is; only the server's refusal asks the factor; the verified factor
 * sends the same request once more; Cancel, a factor that lands late and a pane that was left send nothing. The
 * invite link is assembled once, drawn as a picture and copied on request, and is never printed.
 */

const LIST = "GET /api/pair";
const MINT = "POST /api/pair";
const REVOKE = "DELETE /api/pair/pt-1";
const STEP_UP = () => refusal(403, "step_up_required");
const GONE = () => new Response(null, { status: 204 });

/* What only the person may see: what the server made for the invite, and the link that carries it. */
const MADE = createHash("sha256").update("invites-door fixture").digest("base64url");
const LINK = `${window.location.origin}/join/invite#${MADE}`;
const SECRETS = [MADE, LINK];

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
const minted = (label = "", id = "pt-9") =>
  json({ id, token: MADE, grant: "invite", label, expiresAt: INVITE.expiresAt });

let invites: unknown[] = [];
let server: Server;
let written: ReturnType<typeof catchConsole>;
let clipboard: ReturnType<typeof watchClipboard>;
const slot = { asked: null as GatedAsk | null };
/** The factor's dialog, stood in for: its ceremony is the doors' own. What is held here is what the pane asks. */
const factor: FactorSlot = (ask) => {
  slot.asked = ask;
  return <p>the factor is asked</p>;
};
const factorAsked = () => screen.queryByText("the factor is asked") !== null;

beforeEach(() => {
  invites = [INVITE];
  slot.asked = null;
  written = catchConsole();
  clipboard = watchClipboard();
  server = serve({
    [LIST]: () => json({ items: invites }),
    [MINT]: () => minted(),
    [REVOKE]: GONE,
  });
});
afterEach(() => {
  cleanup();
  server.restore();
  written.restore();
  clipboard.restore();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function Pane() {
  return <InvitesPane model={useInvites(useInvitesDoor())} factor={factor} qr={qr} />;
}
async function opened() {
  const view = render(
    <Words>
      <Pane />
    </Words>,
  );
  await settle();
  return view;
}
const said = (words: string): boolean => (document.body.textContent ?? "").includes(words);
const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await settle();
};
const typeName = (name: string) =>
  act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: en.invites.mintFor }), { target: { value: name } });
  });

describe("a refused verb, as its word", () => {
  const say = (): string => "said by the renderer";
  const day = (iso: string): string => `day ${iso}`;
  const FACTOR = { ok: false, word: "factor" };
  const SIGN_IN = { ok: false, word: "sign_in" };
  const SAID_SO = { ok: false, word: "said", said: "said by the renderer" };
  const TABLE = [
    [new ApiError(403, "step_up_required", "x"), FACTOR],
    [new ApiError(403, "enrollment_incomplete", "x"), SIGN_IN],
    [new ApiError(403, "forbidden", "x"), SIGN_IN],
    [new ApiError(401, "unauthorized", "x"), SIGN_IN],
    [new ApiError(401, "step_up_required", "x"), SIGN_IN],
    [new ApiError(400, "validation_failed", "x"), SAID_SO],
    [new ApiError(500, "internal", "x"), SAID_SO],
    [new Error("x"), SAID_SO],
  ] as const;

  it("both verbs read the refusal in the order the pane always did", async () => {
    const door = invitesDoor(say, day);
    for (const [refused, word] of TABLE) {
      vi.spyOn(pair, "mint").mockRejectedValueOnce(refused);
      vi.spyOn(pair, "revoke").mockRejectedValueOnce(refused);
      const answers = [await door.make("Rahel"), await door.revoke("pt-1")];
      expect(answers, String(refused)).toEqual([word, word]);
    }
  });

  it("an invite that is already gone is revoked: 404 is taken, for that verb alone", async () => {
    const door = invitesDoor(say, day);
    const gone = new ApiError(404, "not_found", "x");
    vi.spyOn(pair, "revoke").mockRejectedValueOnce(gone);
    vi.spyOn(pair, "mint").mockRejectedValueOnce(gone);
    expect(await door.revoke("pt-1")).toEqual({ ok: true, value: null });
    expect(await door.make("")).toEqual(SAID_SO);
  });

  it("a read that failed is said, whatever refused it", async () => {
    const door = invitesDoor(say, day);
    for (const failed of [
      new ApiError(403, "step_up_required", "x"),
      new ApiError(401, "unauthorized", "x"),
      new ApiError(503, "internal", "x"),
    ]) {
      vi.spyOn(pair, "list").mockRejectedValueOnce(failed);
      expect(await door.read()).toEqual(SAID_SO);
    }
  });

  it("answers the open invites alone: live rows of the invite grant, each with its name or none and its two days", async () => {
    invites = [
      INVITE,
      { ...INVITE, id: "pt-2", label: "" },
      { ...INVITE, id: "pt-3", grant: "device-pair" },
      { ...INVITE, id: "pt-4", status: "consumed" },
      { ...INVITE, id: "pt-5", status: "expired" },
      { ...INVITE, id: "pt-6", status: "revoked" },
    ];
    const days = { made: `day ${INVITE.createdAt}`, expires: `day ${INVITE.expiresAt}` };
    expect(await invitesDoor(say, day).read()).toEqual({
      ok: true,
      value: [
        { id: "pt-1", name: "Rahel Beck", ...days },
        { id: "pt-2", name: null, ...days },
      ],
    });
  });
});

describe("opening the pane", () => {
  it("asks the list once, however often the pane is drawn again, and says days as the product's one formatter does", async () => {
    const view = await opened();
    expect(server.asked()).toEqual([`${LIST} {}`]);
    view.rerender(
      <Words>
        <Pane />
      </Words>,
    );
    await settle();
    expect(server.asked()).toEqual([`${LIST} {}`]);
    const day = (iso: string) =>
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));
    expect(said(day(INVITE.createdAt))).toBe(true);
    expect(said(day(INVITE.expiresAt))).toBe(true);
  });

  it("a list that could not be read is said, and nothing is listed as open", async () => {
    server.answer(LIST, refusal(500, "internal"));
    await opened();
    expect(screen.queryByRole("heading", { name: en.invites.liveTitle })).toBeNull();
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(screen.getByRole("button", { name: en.invites.mintAction })).toBeTruthy();
  });
});

describe("the invite link, made once", () => {
  it("one request with the grant and the name; the picture and the clipboard are one link on this page's origin; it is never printed", async () => {
    server.answer(MINT, minted("Rahel Beck"));
    await opened();
    await typeName("  Rahel Beck ");
    await press(en.invites.mintAction);
    expect(server.on(MINT).map((sent) => sent.body)).toEqual([{ grant: "invite", label: "Rahel Beck" }]);
    expect(scanned()).toBe(LINK);
    expect(said(MADE)).toBe(false);
    expect(said(en.invites.copied)).toBe(false);
    await press(en.invites.copyLink);
    expect(clipboard.written).toEqual([LINK]);
    expect(said(en.invites.copied)).toBe(true);
    expect(server.on(MINT)).toHaveLength(1);
  });

  it("no name sends no name, and a clipboard that refuses never says copied", async () => {
    clipboard.restore();
    clipboard = watchClipboard(false);
    await opened();
    await press(en.invites.mintAction);
    expect(server.on(MINT).map((sent) => sent.keys)).toEqual([["grant"]]);
    await press(en.invites.copyLink);
    expect(said(en.invites.copyFailed)).toBe(true);
    expect(said(en.invites.copied)).toBe(false);
  });

  it("is in nothing but the picture and the clipboard; Done takes it down and asks the server nothing", async () => {
    await opened();
    await press(en.invites.mintAction);
    expect(scanned()).toBe(LINK);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    expect(document.body.innerHTML).not.toContain(MADE);
    await press(en.invites.copyLink);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    server.forget();
    await press(en.invites.mintedDone);
    expect(scanned()).toBeNull();
    expect(server.asked()).toEqual([]);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });

  it("an invite the server no longer has is revoked all the same: that is said, and the list is read again", async () => {
    server.answer(REVOKE, refusal(404, "not_found"));
    await opened();
    server.forget();
    await press(en.invites.revoke);
    expect(server.asked()).toEqual([`${REVOKE} {}`, `${LIST} {}`]);
    expect(said(en.invites.revoked)).toBe(true);
    expect(factorAsked()).toBe(false);
  });

  it("revoking the invite on show leaves its picture up, as it always did", async () => {
    server.answer(MINT, minted(INVITE.label, INVITE.id));
    await opened();
    await press(en.invites.mintAction);
    await press(en.invites.revoke);
    expect(server.on(REVOKE)).toHaveLength(1);
    expect(scanned()).toBe(LINK);
  });
});

/** The two guarded verbs: the request each is, and the press that sends it. */
const VERBS: readonly {
  readonly name: string;
  readonly line: string;
  readonly keys: readonly string[];
  readonly send: () => Promise<void>;
}[] = [
  { name: "a new invite", line: MINT, keys: ["grant"], send: () => press(en.invites.mintAction) },
  { name: "an invite revoked", line: REVOKE, keys: [], send: () => press(en.invites.revoke) },
];

/** The pane opened, and the verb sent to a server that refuses it for the factor. */
async function refusedOnce(verb: (typeof VERBS)[number], ...more: Response[]) {
  const view = await opened();
  server.answer(verb.line, STEP_UP(), ...more);
  await verb.send();
  return view;
}

for (const verb of VERBS) {
  describe(`${verb.name}, guarded by the factor`, () => {
    it("is tried as it is; the refusal asks the factor; nothing more leaves before it verifies; then once more, the same", async () => {
      await refusedOnce(verb);
      expect(server.on(verb.line)).toHaveLength(1);
      expect(factorAsked()).toBe(true);
      await settle();
      expect(server.on(verb.line)).toHaveLength(1);
      await act(async () => slot.asked!.onVerified());
      await settle();
      expect(server.on(verb.line).map((sent) => sent.keys)).toEqual([verb.keys, verb.keys]);
      expect(factorAsked()).toBe(false);
      expect(said(en.invites.stepUpExpired)).toBe(false);
    });

    it("a factor that says it verified twice over sends the request once", async () => {
      await refusedOnce(verb);
      const asked = slot.asked!;
      await act(async () => {
        asked.onVerified();
        asked.onVerified();
      });
      await settle();
      expect(server.on(verb.line)).toHaveLength(2);
    });

    it("refused again after the factor: the way back in, no second dialog, no third request", async () => {
      await refusedOnce(verb, STEP_UP());
      await act(async () => slot.asked!.onVerified());
      await settle();
      expect(server.on(verb.line)).toHaveLength(2);
      expect(factorAsked()).toBe(false);
      expect(said(en.invites.stepUpExpired)).toBe(true);
    });

    it("Cancel sends nothing more, and a factor that lands after it says nothing ran", async () => {
      await refusedOnce(verb);
      const asked = slot.asked!;
      await act(async () => asked.onCancel());
      expect(factorAsked()).toBe(false);
      await act(async () => asked.onDiscarded());
      await act(async () => asked.onVerified());
      await settle();
      expect(server.on(verb.line)).toHaveLength(1);
      expect(said(en.devices.stepUpCancelledNothingRan)).toBe(true);
    });

    it("a pane left while the factor is asked sends nothing afterwards", async () => {
      const view = await refusedOnce(verb);
      const asked = slot.asked!;
      view.unmount();
      server.forget();
      await act(async () => asked.onVerified());
      await settle();
      expect(server.asked()).toEqual([]);
    });
  });
}
