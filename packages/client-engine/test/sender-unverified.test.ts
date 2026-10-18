import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  autoUnsubscribeConfirms,
  heldCheckOf,
  notifiedSenderName,
  screenerSegments,
  unsubscribeClaim,
  unsubscribeLetterOf,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type MutationOutcome,
  type ScreenerWaitingWire,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * AN UNCONFIRMED SENDER AT A BRAND'S OWN DOMAIN, ON THE CLIENT. The server says it on the wire as
 * `senderCheck.reason = "unverified"`; the client holds no dictionary. It is a line to read and
 * nothing more: no claim at the gate, no denial beside the name, and a press moves such a letter
 * exactly as the server's press does, by the identity column under the line. A one-click letter
 * makes the pre-press sentence a fact only where its provider confirmed the sender.
 */

const NOW = new Date("2026-10-18T10:00:00.000Z");
const DOMAIN = "paypal.com";
const UNVERIFIED = { reason: "unverified" as const, brand: "PayPal", domainShared: false };
const CLAIM = { reason: "impersonation" as const, brand: "PostFinance", domainShared: false };

function held(id: string, local: string, senderCheck: EngineMessage["senderCheck"], date = NOW): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: `${local}@${DOMAIN}` },
    to: [], cc: [], date: date.toISOString(), folder: "ohmail/Screener", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...(senderCheck === undefined ? {} : { senderCheck }),
  };
}

function page(rows: EngineMessage[]): ScreenerWaitingWire {
  return {
    items: rows.map((m) => ({
      messageId: m.id, address: m.from.address, name: null, receivedAt: NOW.toISOString(),
      subject: m.subject, snippet: "s", mailboxId: "mb",
      ...(m.senderCheck?.reason === "impersonation" ? { marked: true as const } : {}),
    })),
    nextCursor: null, total: rows.length, inFlight: [],
  };
}

async function engineOver(letters: EngineMessage[]): Promise<OhmailEngine> {
  const pages: SyncChange[][] = [letters.map((m, i) => (
    { type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: NOW.toISOString(), entity: m }))];
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: "c1", hasMore: false, serverTime: NOW.toISOString(),
    }),
    // The decide stays in flight: what the person sees is the overlay alone.
    mutate: (_m: EngineMutation): Promise<MutationOutcome> => new Promise(() => {}),
    fetchBody: async () => null,
    screenerWaiting: async () => page(letters),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  await engine.start();
  await engine.refreshScreenerWaiting();
  return engine;
}

describe("the Screener row's `checked` off the wire", () => {
  it("an unconfirmed brand sender's row carries the line, with the address's domain", async () => {
    const engine = await engineOver([held("u1", "service", UNVERIFIED)]);
    const row = screenerSegments(engine.read(), NOW).waiting.find((w) => w.from.address === `service@${DOMAIN}`);
    expect(row?.checked).toEqual({ reason: "unverified", brand: "PayPal", domainShared: false, domain: DOMAIN });
  });

  it("a claim on any held letter outranks an unconfirmed line on a newer one", async () => {
    const older = new Date(NOW.getTime() - 60_000);
    const engine = await engineOver([held("c1", "service", CLAIM, older), held("u2", "service", UNVERIFIED)]);
    const row = screenerSegments(engine.read(), NOW).waiting.find((w) => w.from.address === `service@${DOMAIN}`);
    expect(row?.checked).toMatchObject({ reason: "impersonation", brand: "PostFinance" });
  });
});

describe("a press reads the identity column under an unconfirmed line", () => {
  it("heldCheckOf: checked clean and unconfirmed is `none`; never checked is `unchecked`; a claim is a claim", () => {
    expect(heldCheckOf(null)).toBe("none");
    expect(heldCheckOf(undefined)).toBe("unchecked");
    expect(heldCheckOf(CLAIM)).toBe("claim");
    expect(heldCheckOf(UNVERIFIED)).toBe("none");
    expect(heldCheckOf({ ...UNVERIFIED, unchecked: true })).toBe("unchecked");
  });

  it("a whole-domain press moves another address's unconfirmed letter and leaves a never-checked one, as the server does", async () => {
    const engine = await engineOver([
      held("p1", "billing", null),
      held("p2", "service", UNVERIFIED),
      held("p3", "news", { ...UNVERIFIED, unchecked: true }),
    ]);
    void engine.mutate({ kind: "screener_decide", senderId: "p1", decision: "yes", dest: "ohbox", scope: "domain" });
    await new Promise((r) => setTimeout(r, 0));
    const at = (id: string) => engine.read().get<EngineMessage>("message", id)?.folder;
    expect([at("p1"), at("p2"), at("p3")]).toEqual(["INBOX", "INBOX", "ohmail/Screener"]);
  });
});

describe("an unconfirmed line adds no denial to a sender's name", () => {
  it("the one-line name carries the claim's denial and nothing for an unconfirmed sender", () => {
    const not = (brand: string) => `Not ${brand}`;
    expect(notifiedSenderName({ from: { name: "PayPal", address: "service@paypal.com" }, senderCheck: UNVERIFIED }, not)).toBe("PayPal");
    expect(notifiedSenderName({ from: { name: "PayPal", address: "service@paypal.com" }, checked: UNVERIFIED }, not)).toBe("PayPal");
    expect(notifiedSenderName({ from: { name: "PostFinance", address: "x@karten.example" }, senderCheck: CLAIM }, not))
      .toBe("PostFinance (Not PostFinance)");
  });
});

describe("what a screen-out says about the unsubscribe, before the press", () => {
  const ONE_CLICK = "one_click" as const;

  it("a one-click letter makes it a fact only where the provider confirmed its sender", () => {
    expect(unsubscribeClaim({ armed: true, letters: [{ posture: ONE_CLICK, authVerdict: "pass" }] })).toBe("sends");
    expect(unsubscribeClaim({ armed: true, letters: [{ posture: ONE_CLICK, authVerdict: "unavailable" }] })).toBe("may_send");
    expect(unsubscribeClaim({ armed: true, letters: [{ posture: ONE_CLICK, authVerdict: null }] })).toBe("may_send");
    expect(unsubscribeClaim({ armed: true, letters: [{ posture: ONE_CLICK, authVerdict: "fail" }] })).toBe("may_send");
    expect(unsubscribeClaim({ armed: true, letters: [{ posture: "no_header", authVerdict: "pass" }] })).toBe("may_send");
    expect(unsubscribeClaim({ armed: false, letters: [{ posture: ONE_CLICK, authVerdict: "pass" }] })).toBe("none");
  });

  it("a letter's posture and verdict are read off the mirror together", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const m = { ...held("b1", "news", null), authVerdict: "pass" as const };
    await store.applyChanges([
      { type: "message", op: "create", id: m.id, seq: 1, updatedAt: NOW.toISOString(), entity: m },
      {
        type: "message_body", op: "create", id: m.id, seq: 2, updatedAt: NOW.toISOString(),
        entity: { messageId: m.id, state: "ready", text: "t", html: null, loadedRemoteContent: false, unsubscribe: "one_click", unsubscribeUrl: null, withheld: null },
      },
    ]);
    expect(unsubscribeLetterOf(store, "b1")).toEqual({ posture: "one_click", authVerdict: "pass" });
    expect(unsubscribeLetterOf(store, "absent")).toEqual({ posture: null, authVerdict: null });
  });
});

describe("whether a screen-out can unsubscribe by itself at all on this account", () => {
  it("only where a mailbox still connected has a provider whose word ohmail reads", () => {
    expect(autoUnsubscribeConfirms([{ status: "connected", providerConfirms: false }])).toBe(false);
    expect(autoUnsubscribeConfirms([
      { status: "connected", providerConfirms: false }, { status: "error", providerConfirms: true },
    ])).toBe(true);
    expect(autoUnsubscribeConfirms([
      { status: "disabled", providerConfirms: true }, { status: "connected", providerConfirms: false },
    ]), "a disconnected mailbox is acted for by nothing").toBe(false);
    expect(autoUnsubscribeConfirms([])).toBe(false);
  });

  it("not read yet, or a server that cannot say, answers yes: the failure to avoid is an unsubscribe nobody was told about", () => {
    expect(autoUnsubscribeConfirms(null)).toBe(true);
    expect(autoUnsubscribeConfirms([{ status: "connected" }])).toBe(true);
  });
});
