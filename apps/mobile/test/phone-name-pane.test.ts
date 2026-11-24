import { expect, it } from "vitest";
import { BridgeHost } from "../src/shell/bridge-host";
import { answerPhoneName } from "../src/shell/phone-name";
import { createBridge } from "../web/src/bridge";

const mailbox = { id: "owned-mailbox", address: "owned@example.test", displayName: "Previous name" };
const items = { items: [mailbox, { ...mailbox, id: "disabled-mailbox", status: "disabled" }] };

function fixture(app: "ohmail" | "ohcal" = "ohmail", standalone = true) {
  const writes: unknown[] = [];
  let live = true;
  let beforeRoster = async () => {};
  let accepts = true;
  const session = {
    profile: { origin: "https://example.test", apiBase: "https://example.test/api" } as Parameters<
      typeof answerPhoneName
    >[1]["profile"],
    standalone,
    fetch: async (url: string, init?: unknown) => {
      if (url.endsWith("/mailboxes")) {
        await beforeRoster();
        return Response.json(items);
      }
      const body = JSON.parse((init as RequestInit).body as string) as { displayName: string | null };
      writes.push([new URL(url).pathname, body]);
      return accepts ? Response.json(body) : new Response(null, { status: 422 });
    },
  };
  const receive = new Set<(message: string) => void>();
  const host = new BridgeHost({
    app,
    post: (_epoch, text) => queueMicrotask(() => receive.forEach((take) => take(text))),
    config: () => null,
    http: {} as never,
    act: async () => ({}),
    openHeld: async () => false,
    ready: () => {},
    place: () => {},
    note: () => {},
    oldCopy: { page: async () => ({ refused: "notReady" }), done: async () => ({ refused: "notReady" }) },
    name: (ask, signal) => answerPhoneName(ask, session, () => live, signal),
  });
  host.begin("e1");
  const page = createBridge(
    {
      post: (data) =>
        host.receive({ epoch: "e1", origin: "https://appassets.androidplatform.net", mainFrame: true, data }),
      listen: (take) => (receive.add(take), () => void receive.delete(take)),
    },
    "e1",
  );
  return {
    page,
    writes,
    end: () => {
      live = false;
    },
    refuseWrite: () => {
      accepts = false;
    },
    holdRoster: (hold: () => Promise<void>) => {
      beforeRoster = hold;
    },
  };
}

it("shows only this phone's live mailbox and saves a name or clears it on its existing local route", async () => {
  const { page, writes } = fixture();
  expect(await page.request("phone.name", { do: "read" })).toEqual({
    rows: [{ id: mailbox.id, address: mailbox.address, name: mailbox.displayName }],
  });
  expect(
    await page.request("phone.name", { do: "save", mailboxId: mailbox.id, name: "  Confirmed  name  " }),
  ).toEqual({ name: "Confirmed name" });
  expect(await page.request("phone.name", { do: "save", mailboxId: mailbox.id, name: null })).toEqual({
    name: null,
  });
  expect(writes).toEqual([
    ["/api/local/mailboxes/owned-mailbox/name", { displayName: "Confirmed name" }],
    ["/api/local/mailboxes/owned-mailbox/name", { displayName: null }],
  ]);
});

it("withholds names from the calendar and paired phones, and refuses removed and malformed choices", async () => {
  const calendar = fixture("ohcal");
  const paired = fixture("ohmail", false);
  const { page, writes } = fixture();
  await expect(calendar.page.request("phone.name", { do: "read" })).rejects.toMatchObject({
    refused: "malformed",
  });
  await expect(paired.page.request("phone.name", { do: "read" })).rejects.toMatchObject({
    refused: "notReady",
  });
  await expect(
    page.request("phone.name", { do: "save", mailboxId: "disabled-mailbox", name: "Other name" }),
  ).rejects.toMatchObject({ refused: "foreignScope" });
  await expect(
    page.request("phone.name", { do: "save", mailboxId: mailbox.id, name: "a".repeat(101) }),
  ).rejects.toMatchObject({ refused: "malformed" });
  expect([...paired.writes, ...calendar.writes, ...writes]).toEqual([]);
});

it("does not begin writing if the phone leaves its pairing before the mailbox read answers", async () => {
  const { page, writes, holdRoster, end } = fixture();
  let release!: () => void;
  const reading = new Promise<void>((started) =>
    holdRoster(
      () =>
        new Promise((resolve) => {
          release = resolve;
          started();
        }),
    ),
  );
  const pending = page.request("phone.name", { do: "save", mailboxId: mailbox.id, name: "Do not move" });
  await reading;
  end();
  release();
  await expect(pending).rejects.toMatchObject({ refused: "foreignScope" });
  expect(writes).toEqual([]);
});

it("gives no success confirmation when the mailbox refuses the update", async () => {
  const { page, writes, refuseWrite } = fixture();
  refuseWrite();
  await expect(
    page.request("phone.name", { do: "save", mailboxId: mailbox.id, name: "Failed name" }),
  ).rejects.toMatchObject({ refused: "notReady" });
  expect(writes).toHaveLength(1);
});
