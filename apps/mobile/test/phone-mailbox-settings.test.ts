import { expect, it, vi } from "vitest";
import { answerPhoneMailbox } from "../src/shell/phone-mailbox";
import type { ServerProfile } from "../src/state/servers";

const request = { do: "edit", mailboxId: "mailbox", patch: { imap: { pass: "fixture" } } } as const;
const roster = () => Response.json({ items: [{ id: "mailbox", address: "Current mailbox", status: "active" }] });
const signal = () => new AbortController().signal;

function fixture(standalone = true) {
  const fetch = vi.fn<(url: string, init?: unknown) => Promise<Response>>();
  const session = {
    fetch, standalone, boundAccount: () => "owner",
    profile: { origin: "https://example.invalid", apiBase: null, accountId: "owner" } as ServerProfile,
  };
  return { session, fetch };
}

it("edits the standalone session's own mailbox and returns a stored receipt", async () => {
  const { session, fetch } = fixture();
  fetch.mockImplementationOnce(async () => roster()).mockResolvedValueOnce(new Response(null, { status: 204 }));
  await expect(answerPhoneMailbox(request, session, () => true, signal())).resolves.toEqual({
    edited: { ok: true, value: null },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[0]).toMatch(/\/local\/mailboxes\/mailbox$/);
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify(request.patch) });
});

it("never tries an edit for another mailbox or a paired session", async () => {
  const local = fixture();
  local.fetch.mockImplementationOnce(async () => roster());
  await expect(answerPhoneMailbox({ ...request, mailboxId: "another" }, local.session, () => true, signal()))
    .resolves.toEqual({ refused: "foreignScope" });
  expect(local.fetch).toHaveBeenCalledTimes(1);

  const paired = fixture(false);
  await expect(answerPhoneMailbox(request, paired.session, () => true, signal())).resolves.toEqual({ refused: "notReady" });
  expect(paired.fetch).not.toHaveBeenCalled();
});

it("refuses mailbox settings when the session is bound to another account", async () => {
  const { session, fetch } = fixture();
  session.boundAccount = () => "another";
  await expect(answerPhoneMailbox(request, session, () => true, signal())).resolves.toEqual({ refused: "cancelled" });
  expect(fetch).not.toHaveBeenCalled();
});

it("drops a press whose page is retired while the roster is loading", async () => {
  const { session, fetch } = fixture();
  const control = new AbortController();
  let finish!: (value: Response) => void;
  fetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const pending = answerPhoneMailbox(request, session, () => true, control.signal);
  control.abort();
  finish(roster());
  await expect(pending).resolves.toEqual({ refused: "cancelled" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("strips echoed credentials and withheld connection offers from an edit refusal", async () => {
  const { session, fetch } = fixture();
  fetch.mockImplementationOnce(async () => roster()).mockResolvedValueOnce(Response.json({
    error: {
      code: "mailbox_probe_failed", message: request.patch.imap.pass,
      details: {
        transport: "imap", reason: "tls",
        tls: { kind: "tls_unavailable", plaintext: "offered", expectedHost: request.patch.imap.pass, transport: "imap" },
      },
    },
  }, { status: 400 }));
  const answer = await answerPhoneMailbox(request, session, () => true, signal());
  expect(answer).toMatchObject({
    edited: { ok: false, refusal: {
      code: "mailbox_probe_failed", message: "", details: { tls: { plaintext: null, expectedHost: null } },
    } },
  });
  expect(JSON.stringify(answer)).not.toContain(request.patch.imap.pass);
});
