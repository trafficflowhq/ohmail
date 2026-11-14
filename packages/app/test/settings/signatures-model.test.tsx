/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { useSignaturesModel } from "../../src/settings/signatures/use-signatures.js";

const ground = vi.hoisted(() => ({
  demo: false,
  mailboxes: null as MailboxFacts[] | null,
  consent: {
    signaturesKnown: false,
    signatures: { local: "Stored text" },
    signaturesHtml: { shared: "<p>Stored markup</p>" },
    signatureSources: { shared: "organizer" },
    signatureChanges: { shared: { state: "applied", holder: null, refusal: null } },
    saveMailboxSignature: vi.fn().mockResolvedValue(undefined),
  },
  holdLeave: vi.fn(() => () => undefined),
}));
vi.mock("@ohmail/app-logic/consent", () => ({ useConsent: () => ground.consent }));
vi.mock("@ohmail/app-logic/engine", () => ({ useDemoMode: () => ground.demo }));
vi.mock("@ohmail/app-logic/mail-state", () => ({ useMailState: () => ground }));
vi.mock("../../src/frame/commands.js", () => ({
  useFrame: () => ({ host: { device: { address: { holdLeave: ground.holdLeave } } } }),
}));
vi.mock("../../src/text/reader.js", () => ({ useText: () => (key: string) => key }));

function box(id: string, facts: Partial<MailboxFacts> = {}): MailboxFacts {
  return { id, address: id + "@example.invalid", ...facts } as MailboxFacts;
}
const parts = { editor: () => null, changeNote: vi.fn(() => null) };

it("withholds the editor until the confirmed signatures and a live mailbox belong to the active page", () => {
  ground.consent.signaturesKnown = false;
  ground.mailboxes = [box("local")];
  const hook = renderHook(() => useSignaturesModel(parts));
  expect(hook.result.current).toBeNull();
  ground.consent.signaturesKnown = true;
  ground.mailboxes = null;
  hook.rerender();
  expect(hook.result.current).toBeNull();
  ground.mailboxes = [box("removed", { status: "disabled" })];
  hook.rerender();
  expect(hook.result.current).toBeNull();
  ground.mailboxes = [box("local")];
  ground.demo = true;
  hook.rerender();
  expect(hook.result.current).toBeNull();
  ground.demo = false;
  hook.rerender();
  expect(hook.result.current?.mailboxes.map((m) => m.id)).toEqual(["local"]);
});

it("reads each listed mailbox's text, markup and organizer state, and uses the shared write and leave guard", async () => {
  ground.demo = false;
  ground.consent.signaturesKnown = true;
  ground.mailboxes = [
    box("local", { organizerRole: "reader" }),
    box("removed", { status: "disabled" }),
    box("shared", { organizerRole: "reader", takeoverAuthorizedAt: "2026-01-01" }),
    box("older", { status: "disabled", legacyStandDown: true }),
  ];
  const { result } = renderHook(() => useSignaturesModel(parts));
  const model = result.current!;
  expect(model.mailboxes.map((m) => [m.id, m.stored, m.reading, m.takeoverAsked])).toEqual([
    ["local", { text: "Stored text", html: "" }, false, false],
    ["shared", { text: "", html: "<p>Stored markup</p>" }, true, true],
    ["older", { text: "", html: "" }, false, false],
  ]);
  await model.write("local", "Updated");
  expect(ground.consent.saveMailboxSignature).toHaveBeenCalledWith("local", "Updated");
  const question = vi.fn();
  model.holdLeave(question);
  expect(ground.holdLeave).toHaveBeenCalledWith(question, "#/settings/signatures");
  expect(model.refusal(new Error(), false)).toBeNull();
  expect(model.refusal({ code: "organized_elsewhere", details: { reason: "no_organizer" } }, true)).toBe(
    "whyRefused.starting",
  );
  model.changeNote("shared");
  expect(parts.changeNote).toHaveBeenCalledWith(ground.consent.signatureChanges.shared);
});
