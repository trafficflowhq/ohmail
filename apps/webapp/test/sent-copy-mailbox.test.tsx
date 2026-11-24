/** @vitest-environment jsdom */
import * as React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { useMailSend } from "@ohmail/app-logic/writing/mail-send";
import { sendNotices } from "../../../packages/app/src/mail/ground/send-notices";

(globalThis as unknown as { React: unknown }).React = React;
afterEach(cleanup);

it("records the sending mailbox when a reply from another mailbox cannot be copied to Sent", async () => {
  const store = new MemoryMirrorStore();
  const at = "2026-11-22T09:00:00.000Z";
  await store.load();
  await store.applyChanges([{
    type: "message", op: "create", id: "original", seq: 1, updatedAt: at,
    entity: { id: "original", mailboxId: "receiving", subject: "Original letter",
      from: { name: "Sender", address: ["sender", "example.test"].join("@") } },
  }]);
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: at }),
      fetchBody: async () => null,
      mutate: async () => ({ changes: [], seq: null, sentCopy: "pending", sentCopyReason: "full" }),
    } as never,
  });
  await engine.start();
  let mail!: ReturnType<typeof useMailSend>;
  function Probe(): null {
    mail = useMailSend(engine, null, () => {}, { t: (key) => key, scheduleLabel: () => "" }, () => {});
    return null;
  }
  render(React.createElement(Probe));
  const leave = mail.mountLine();
  try {
    await act(async () => {
      mail.send({ kind: "mail_send", inReplyTo: "original", body: "Reply text", mailboxId: "sending" });
    });
    await waitFor(() => expect(mail.line().find((item) => item.copy)).toMatchObject({
      mailboxId: "sending", copy: { state: "pending", reason: "full" },
    }));
    const sendingAddress = ["sending", "example.test"].join("@");
    const notices = sendNotices(
      (key, values) => key === "sentCopy.quotaMailbox" ? String(values?.address) : key,
      mail.line(), () => {}, () => {}, true,
      { address: (id) => id === "sending" ? sendingAddress : ["receiving", "example.test"].join("@") },
    );
    expect(notices).toContainEqual(expect.objectContaining({ title: sendingAddress }));
  } finally {
    leave();
  }
});
