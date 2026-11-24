import { MIRROR_ENTITY_TYPES } from "@ohmail/client-engine";
import { expect, it } from "vitest";
import { readRequest } from "../src/shell/bridge-kinds";

const request = (kind: string, input: object) => ({ epoch: "page", id: 1, kind, ...input });

it("accepts only measured counts and an empty share request from the mail page", () => {
  const write = request("phone.diagnostics", { do: "write", counts: MIRROR_ENTITY_TYPES.map(() => 0) });
  const share = request("phone.diagnostics", { do: "share" });
  expect(readRequest(write, "ohmail", MIRROR_ENTITY_TYPES.length)).toEqual(write);
  expect(readRequest(share, "ohmail")).toEqual(share);
  const malformed = { refused: "malformed" };
  expect(readRequest(share, "ohcal")).toEqual(malformed);
  expect(readRequest({ ...share, file: "local-file" }, "ohmail")).toEqual(malformed);
  expect(readRequest({ ...write, counts: [0] }, "ohmail", MIRROR_ENTITY_TYPES.length)).toEqual(malformed);
  expect(readRequest({ ...write, counts: MIRROR_ENTITY_TYPES.map(() => -1) }, "ohmail", MIRROR_ENTITY_TYPES.length)).toEqual(malformed);
});

it("allows a mailbox edit and refuses new connections or a plaintext opt-in through the page", () => {
  const edit = request("phone.mailbox", {
    do: "edit", mailboxId: "mailbox", patch: { imap: { pass: "fixture", port: 993 } },
  });
  expect(readRequest(edit, "ohmail")).toEqual(edit);
  expect(readRequest(edit, "ohcal")).toEqual({ refused: "malformed" });
  expect(readRequest({ ...edit, do: "add" }, "ohmail")).toEqual({ refused: "malformed" });
  expect(readRequest({
    ...edit, patch: { imap: { pass: "fixture", allowInsecure: true } },
  }, "ohmail")).toEqual({ refused: "malformed" });
});
