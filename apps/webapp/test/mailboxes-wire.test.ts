/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretOf } from "@ohmail/app-logic/mailboxes/connect/secret";
import type { MailboxId } from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE } from "@ohmail/app/host";
import type { MailboxDTO } from "../app/api-client";

/**
 * THE WEB'S MAILBOXES WIRE over the server client: the pane's own calls. It never rejects; what the server refused is
 * read field by field; each verb reaches the route the shipped pane called, with the body it sent; an id that is no
 * id reaches no path; a row is narrowed at this seam and one whose id is none is dropped.
 */
type Sent = { route: string; args: unknown[] };
let mockSent: Sent[] = [];
let mockThrow: unknown = null;
let mockAnswer: unknown = null;
let mockSession: unknown = { user: { accountId: "acct-1", emailVerified: true }, scope: "full" };
let mockAccess: unknown = { metered: true, canAddMailbox: true, mailboxes: 5 };

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  const call = (route: string) => async (...args: unknown[]) => {
    mockSent.push({ route, args });
    if (mockThrow !== null) throw mockThrow;
    return mockAnswer;
  };
  return {
    ...actual,
    apiConfigured: () => true,
    auth: { ...actual.auth, session: async () => { if (mockSession instanceof Error) throw mockSession; return mockSession; } },
    account: { ...actual.account, access: async (o: unknown) => { mockSent.push({ route: "access", args: [o] }); if (mockAccess instanceof Error) throw mockAccess; return mockAccess; } },
    mailboxes: {
      ...actual.mailboxes,
      list: call("list"),
      resync: call("resync"),
      remove: call("remove"),
      erase: call("erase"),
      organizer: call("organizer"),
      organize: call("organize"),
      release: call("release"),
      dismissInboundQuiet: call("dismissInboundQuiet"),
      selfCheck: call("selfCheck"),
      filings: call("filings"),
      retryFilings: call("retryFilings"),
      leaveFilings: call("leaveFilings"),
    },
  };
});

const ID = "0d3a8f1e-52c4-4c0e-9a7b-1f2e3d4c5b6a" as MailboxId;
const ADDRESS = "anna@lichtgrat.example";
const DTO: MailboxDTO = {
  id: ID,
  provider: "generic",
  address: ADDRESS,
  displayName: null,
  status: "connected",
  lastSyncAt: "2026-11-16T08:58:00.000Z",
  organizerRole: "organizer",
  createdAt: "2026-11-01T08:00:00.000Z",
} as MailboxDTO;

async function load() {
  const { ApiError } = await import("../app/api-client");
  const made = await import("../app/(product)/mailbox/mailboxes-wire");
  return { ApiError, ...made };
}

async function web() {
  const { webMailboxesWire, ApiError, toMailboxRow } = await load();
  const wire = webMailboxesWire();
  const member = <T,>(m: T | typeof NONE): T => {
    if (m === NONE) throw new Error("the web answers every member but the way out");
    return m;
  };
  return { wire, member, ApiError, toMailboxRow };
}

beforeEach(() => {
  mockSent = [];
  mockThrow = null;
  mockAnswer = null;
  mockSession = { user: { accountId: "acct-1", emailVerified: true }, scope: "full" };
  mockAccess = { metered: true, canAddMailbox: true, mailboxes: 5 };
});

describe("toMailboxRow narrows a row at the seam", () => {
  it("keeps the facts every part reads and the pane's own fields; absent stays absent and 0 stays 0", async () => {
    const { toMailboxRow } = await load();
    const r = toMailboxRow({ ...DTO, messageCount: 0, setAside: 2, retryCount: 3, failedAt: null, erasure: { remaining: 7 } } as MailboxDTO);
    expect(r).toMatchObject({
      id: ID, address: ADDRESS, provider: "generic", status: "connected", messageCount: 0, setAside: 2,
      retryCount: 3, failedAt: null, erasure: { remaining: 7 }, organizerRole: "organizer",
    });
    const bare = toMailboxRow(DTO)!;
    expect("messageCount" in bare).toBe(false);
    expect("erasure" in bare).toBe(false);
  });

  it.each([["../mailboxes"], ["a/b"], [""], [".."], ["mbx a"], ["x?y=1"]])("drops a row whose id %j is none", async (raw) => {
    const { toMailboxRow } = await load();
    expect(toMailboxRow({ ...DTO, id: raw } as MailboxDTO)).toBeNull();
  });

  it("an unknown role is read as an organizer, as every older server meant", async () => {
    const { toMailboxRow } = await load();
    expect(toMailboxRow({ ...DTO, organizerRole: "something-new" } as unknown as MailboxDTO)!.organizerRole).toBe("organizer");
  });
});

describe("each verb reaches the route the shipped pane called, with its body", () => {
  it("the list asks for counts only when asked, and drops a row whose id is none", async () => {
    mockAnswer = { items: [DTO, { ...DTO, id: "../x" }] };
    const { wire } = await web();
    const listed = await wire.list({ counts: true });
    await wire.list({ counts: false });
    expect(mockSent.map((s) => s.args[0])).toEqual([{ counts: true }, {}]);
    expect(listed.ok && listed.value.map((r) => r.id)).toEqual([ID]);
  });

  it("re-sync, remove, organize here and stop name the mailbox alone; organize sends what the pane sent", async () => {
    const { wire, member } = await web();
    mockAnswer = { status: "queued" };
    expect(await wire.resync(ID)).toEqual({ ok: true, value: null });
    mockAnswer = undefined;
    expect(await member(wire.remove)(ID)).toEqual({ ok: true, value: null });
    mockAnswer = { outcome: "authorized", previousReason: "organized_elsewhere_cloud" };
    expect(await member(wire.organizeHere)(ID, {})).toEqual({ ok: true, value: { outcome: "authorized" } });
    mockAnswer = { outcome: "requested" };
    expect(await member(wire.stopOrganizing)(ID)).toEqual({ ok: true, value: { outcome: "requested" } });
    expect(mockSent).toEqual([
      { route: "resync", args: [ID] },
      { route: "remove", args: [ID] },
      { route: "organize", args: [ID] },
      { route: "release", args: [ID] },
    ]);
  });

  it("a password handed to organize here is opened only in that request's body, and nowhere else", async () => {
    const { wire, member } = await web();
    const marker = "zq-pane-MARKER-7Kd";
    mockAnswer = { outcome: "authorized", previousReason: "organized_elsewhere_cloud" };
    const answer = await member(wire.organizeHere)(ID, { password: secretOf(marker) });
    expect(mockSent).toEqual([{ route: "organize", args: [ID, { imap: { pass: marker } }] }]);
    expect(JSON.stringify(answer)).not.toContain(marker);
    mockThrow = new Error(marker);
    const refused = await member(wire.organizeHere)(ID, { password: secretOf(marker) });
    expect(JSON.stringify(refused)).not.toContain(marker);
  });

  it("erase sends the address exactly as typed, and its receipt names the mailbox asked", async () => {
    const { wire, member } = await web();
    mockAnswer = { erasing: true, mailboxId: ID, messages: 4, drafts: 1, draftsUnanchored: 0, retained: "kept" };
    expect(await member(wire.erase)(ID, ` ${ADDRESS} `)).toEqual({
      ok: true, value: { erasing: true, mailboxId: ID, messages: 4, drafts: 1, draftsUnanchored: 0 },
    });
    expect(mockSent).toEqual([{ route: "erase", args: [ID, ` ${ADDRESS} `] }]);
    mockAnswer = { erasing: false, mailboxId: "another", messages: 0, drafts: 0, draftsUnanchored: 0 };
    expect((await member(wire.erase)(ID, ADDRESS)).ok).toBe(false);
  });

  it("dismissing the forwarding notice answers the row it changed, narrowed", async () => {
    const { wire, member } = await web();
    mockAnswer = { ...DTO, inboundQuietDismissedAt: "2026-11-16T09:00:00.000Z" };
    const r = await member(wire.dismissForwardingNotice)(ID);
    expect(r.ok && r.value.inboundQuietDismissedAt).toBe("2026-11-16T09:00:00.000Z");
    expect(mockSent).toEqual([{ route: "dismissInboundQuiet", args: [ID] }]);
  });

  it("the filings and the check reach their routes", async () => {
    const { wire, member } = await web();
    mockAnswer = { reset: 2, skipped: 0 };
    const filings = member(wire.filings);
    await filings.read(ID);
    await filings.retry(ID, "ohmail/News");
    await filings.leave(ID, "ohmail/News", "2026-11-16T08:00:00.000Z");
    await member(wire.selfCheck)(ID);
    expect(mockSent.map((s) => s.route)).toEqual(["filings", "retryFilings", "leaveFilings", "selfCheck"]);
    expect(mockSent[2]!.args).toEqual([ID, "ohmail/News", "2026-11-16T08:00:00.000Z"]);
  });

  it("this shell changes mailboxes here: it hands no way out", async () => {
    const { wire } = await web();
    expect(wire.out).toBe(NONE);
  });
});

describe("an id that is no id reaches no path", () => {
  it.each([["../mailboxes"], ["a/b"], [".."], ["mbx%2F1"], [""]])("%j is refused before any request", async (raw) => {
    const { wire, member } = await web();
    const id = raw as MailboxId;
    const answers = [
      await wire.resync(id),
      await member(wire.remove)(id),
      await member(wire.erase)(id, ADDRESS),
      await member(wire.organizer)(id),
      await member(wire.organizeHere)(id, {}),
      await member(wire.stopOrganizing)(id),
      await member(wire.dismissForwardingNotice)(id),
      await member(wire.selfCheck)(id),
      await member(wire.filings).read(id),
    ];
    expect(answers.every((a) => !a.ok)).toBe(true);
    expect(mockSent).toEqual([]);
  });
});

describe("it never rejects, and a refusal is read field by field", () => {
  it("the server's refusal is its status, code and sentence; what it echoes in its details stays behind", async () => {
    const { wire, member, ApiError } = await web();
    mockThrow = new ApiError(403, "step_up_required", "Confirm it is you.", { reason: "window", echo: "anything sent" });
    const r = await member(wire.remove)(ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.status).toBe(403);
    expect(r.refusal.code).toBe("step_up_required");
    expect(JSON.stringify(r.refusal)).not.toContain("anything sent");
  });

  it("a throw that is no server's answer is a refusal too, never a rejection", async () => {
    const { wire } = await web();
    mockThrow = new TypeError("the wire broke");
    await expect(wire.resync(ID)).resolves.toMatchObject({ ok: false });
    await expect(wire.list({ counts: false })).resolves.toMatchObject({ ok: false });
  });
});

describe("whether another mailbox may be connected: every unknown fails open", () => {
  it("a metered account's verdict and the session's proof", async () => {
    const { wire, member } = await web();
    expect(await member(wire.allowance)()).toEqual({
      ok: true, value: { emailVerified: true, access: { canAddMailbox: true, mailboxes: 5 } },
    });
    expect(mockSent).toEqual([{ route: "access", args: [{ fresh: true }] }]);
  });

  it("an unmetered host has nothing to block on", async () => {
    mockAccess = { metered: false };
    const { wire, member } = await web();
    expect(await member(wire.allowance)()).toEqual({
      ok: true, value: { emailVerified: true, access: { canAddMailbox: true, mailboxes: null } },
    });
  });

  it("an unreadable verdict, an unreadable session or a session not yet whole are unknown, never a block", async () => {
    mockAccess = new Error("down");
    mockSession = { user: { accountId: "acct-1", emailVerified: false }, scope: "enrollment" };
    const { wire, member } = await web();
    expect(await member(wire.allowance)()).toEqual({ ok: true, value: { emailVerified: null, access: null } });
    mockSession = new Error("down");
    expect(await member(wire.allowance)()).toEqual({ ok: true, value: { emailVerified: null, access: null } });
  });
});
