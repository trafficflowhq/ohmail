import { describe, expect, it } from "vitest";
import { HttpAdapter } from "../src/index.js";

/** `GET /screener` off the wire: rows narrowed, the count read, in-flight decisions named. */

function adapterAnswering(status: number, body: unknown) {
  const urls: string[] = [];
  const adapter = new HttpAdapter({
    baseUrl: "https://mail.example.test",
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  return { adapter, urls };
}

describe("the queue page's wire", () => {
  it("reads the rows, the count and the decisions still in flight", async () => {
    const { adapter, urls } = adapterAnswering(200, {
      items: [
        { id: "m1", messageId: "m1", sender: { name: "Ann", address: "ann@x.test" }, subject: "Hi", snippet: "hello", receivedAt: "2026-09-25T10:00:00.000Z", mailboxId: "mb" },
        { id: "m2", sender: { address: "no-id@x.test" } },
        { messageId: "m3", sender: { name: null } },
      ],
      nextCursor: "abc",
      total: 41,
      pendingDecisions: [
        { subject: "Gone@X.test", scope: "sender", state: "pending", sent: false },
        { subject: "dom.test", scope: "domain", state: "sent", sent: true },
        { subject: "back@x.test", scope: "sender", state: "refused", sent: false },
      ],
    });
    const page = await adapter.screenerWaiting({ cursor: "c1", limit: 200 });
    expect(urls[0]).toContain("/screener?limit=200&cursor=c1");
    expect(page.items).toEqual([
      { messageId: "m1", address: "ann@x.test", name: "Ann", receivedAt: "2026-09-25T10:00:00.000Z", subject: "Hi", snippet: "hello", mailboxId: "mb" },
    ]);
    expect(page.nextCursor).toBe("abc");
    expect(page.total).toBe(41);
    expect(page.inFlight).toEqual([{ scope: "sender", match: "gone@x.test" }, { scope: "domain", match: "dom.test" }]);
  });

  it("a claim, or a letter held for want of confirmation (mail 0176), marks the row; an unverified line alone does not", async () => {
    const row = (id: string, checked: unknown) => ({ messageId: id, sender: { address: `${id}@paypal.com` }, checked });
    const page = await adapterAnswering(200, {
      items: [
        row("claim", { reason: "impersonation", brand: "PostFinance", domainShared: false }),
        row("held", { reason: "unverified", brand: "PayPal", domainShared: false, held: true }),
        row("line", { reason: "unverified", brand: "PayPal", domainShared: false }),
      ],
      nextCursor: null,
    }).adapter.screenerWaiting();
    expect(page.items.map((i) => [i.messageId, i.marked === true])).toEqual([["claim", true], ["held", true], ["line", false]]);
  });

  it("a server that states no count, or an unreadable one, is `null` — never a guessed zero", async () => {
    expect((await adapterAnswering(200, { items: [], nextCursor: null }).adapter.screenerWaiting()).total).toBeNull();
    expect((await adapterAnswering(200, { items: [], nextCursor: null, total: -3 }).adapter.screenerWaiting()).total).toBeNull();
    expect((await adapterAnswering(200, { items: [], nextCursor: null, total: "7" }).adapter.screenerWaiting()).total).toBeNull();
  });

  it("a body that is not a queue page throws rather than reading as nobody waiting", async () => {
    await expect(adapterAnswering(200, { changes: {}, cursor: "c" }).adapter.screenerWaiting()).rejects.toBeTruthy();
    await expect(adapterAnswering(200, null).adapter.screenerWaiting()).rejects.toBeTruthy();
  });

  it("a refusal throws rather than answering an empty queue", async () => {
    await expect(adapterAnswering(403, { error: "forbidden" }).adapter.screenerWaiting()).rejects.toBeTruthy();
  });
});
