import { act, cleanup, render, waitFor as waitUntil } from "@testing-library/react";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter, type SyncChange } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { keySheetOver } from "../../../packages/app/src/keys/sheet/index.js";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import { MailGround, mailPlaces, mailReader } from "../../../packages/app/src/mail/index.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import { bodyDouble, letter } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import en from "../messages/en.json";

export const message = (id: string, over: Partial<EngineMessage> = {}) =>
  letter(id, { subject: `Subject ${id}`, ...over });

export const unmountAll = cleanup;

export function waitFor(condition: () => boolean, description: string): Promise<void> {
  return waitUntil(() => {
    if (!condition()) throw new Error(description);
  }, { timeout: 3000 });
}

/** Stand the registered mail places over a loaded mirror and a host that answers locally. */
export async function mountMailFrame(
  at: string,
  letters: EngineMessage[],
  {
    more = [],
    phone = false,
    prepareEngine,
  }: {
    more?: Omit<SyncChange, "seq">[];
    phone?: boolean;
    prepareEngine?: (engine: OhmailEngine) => void;
  } = {},
) {
  const store = new MemoryMirrorStore();
  await store.load();
  const changes: Omit<SyncChange, "seq">[] = letters.map((m) => ({
    type: "message", op: "create", id: m.id, updatedAt: m.updatedAt, entity: m,
  }));
  const inbox = letters.find((m) => m.folder === "INBOX");
  if (inbox) changes.push({
    type: "rule", op: "create", id: "known-sender", updatedAt: inbox.updatedAt,
    entity: {
      id: "known-sender", kind: "sender", match: inbox.from.address, destination: "INBOX",
      enabled: true, createdAt: inbox.updatedAt,
    },
  });
  await store.applyChanges([...changes, ...more].map((change, i) => ({ ...change, seq: i + 1 })));
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: new Date().toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    withdrawSend: async () => ({ outcome: "unsupported" }),
  };
  const engine = new OhmailEngine({ adapter, store });
  prepareEngine?.(engine);

  const address = fakeAddress(at);
  const { host } = fakeHost({
    engine, service: "self", account: "acct-1", scope: "acct-1", address,
    window: fakeWindow(phone ? "phone" : "desktop"),
    above: MailGround, places: mailPlaces(), overs: { keys: keySheetOver },
    reader: mailReader({ body: bodyDouble().body, look: "none" }),
  });
  const { container } = render(
    <TextProvider locale="en" messages={en as Messages} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  await act(async () => {});
  return { el: container, address };
}
