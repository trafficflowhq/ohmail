/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell.js";
import { typeInto } from "./fixtures/rich-editor-driver.js";

const words = messages.settings.signatures;
const SAME = "one@example.test";
const OLD = "-- \nbefore the removal";
const HTML = "<p><strong>Anna</strong><br />ohmail</p>";
type Mailbox = {
  id: string;
  status?: "connected" | "disabled";
  organizerRole?: string | null;
  takeoverAuthorizedAt?: string;
};
type Signatures = {
  signatures?: Record<string, string>;
  signaturesHtml?: Record<string, string>;
  signatureSources?: Record<string, "organizer" | "local">;
};

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
});
afterEach(teardownConfirmEnv);

async function mountPane(
  mailboxes: Mailbox[],
  saved: Signatures = {},
  answer: Response = Response.json({}),
) {
  const writes: unknown[] = [];
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/mailboxes") {
      const items = mailboxes.map((mailbox) => ({
        address: SAME, status: "connected", initialImportCompletedAt: ISO,
        organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO, ...mailbox,
      }));
      return Response.json({ items });
    }
    if (path === "/api/consent/settings" && init?.method === "PATCH") {
      writes.push(JSON.parse(String(init?.body)));
      return answer;
    }
    if (path === "/api/consent") {
      return Response.json({ seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 90, ...saved });
    }
    return fixture(input, init);
  };
  window.location.hash = "#/settings/signatures";
  const frame = await mountCloudShell();
  await tick(3000);
  const pane = within(frame).getByRole("region", { name: words.nav });
  const editorName = `${words.title}: ${SAME}`;
  return {
    pane,
    editors: () => within(pane).queryAllByRole("textbox", { name: editorName }),
    editor: () => within(pane).getByRole("textbox", { name: editorName }),
    save: () => within(pane).queryByRole("button", { name: words.save }),
    writes,
  };
}

async function editAndSave(view: Awaited<ReturnType<typeof mountPane>>, text: string) {
  await act(async () => { typeInto(view.editor(), text); });
  const save = view.save();
  expect(save).not.toBeNull();
  await act(async () => { save!.click(); });
  await tick(0);
}

describe("SignaturesRow — the compose editor, and one of two save shapes", () => {
  const mailbox = { id: "mb-one" };

  it("mounts the compose editor rather than a bare textarea", async () => {
    const view = await mountPane([mailbox]);
    await act(async () => { typeInto(view.editor(), "Signature"); });
    expect(view.editor().textContent).toBe("Signature");
  });

  it("shows the stored formatting as formatting, in the editor and in the preview", async () => {
    const { pane, editor } = await mountPane([mailbox], {
      signatures: { "mb-one": "Anna\nohmail" }, signaturesHtml: { "mb-one": HTML },
    });
    expect(editor().querySelector("strong")?.textContent).toBe("Anna");
    expect(within(pane).getByRole("textbox", { name: words.preview }).querySelector("strong")?.textContent).toBe("Anna");
    expect(pane.textContent).not.toContain("<strong>");
  });

  it("a reader mailbox shows the organizer's text and offers no Save", async () => {
    const view = await mountPane([{ ...mailbox, organizerRole: "reader" }], {
      signatures: { "mb-one": "-- \nfrom the organizer" }, signatureSources: { "mb-one": "organizer" },
    });
    expect(view.pane.textContent).toContain("from the organizer");
    expect(view.pane.textContent).toContain(words.mailboxRead);
    expect(view.save()).toBeNull();
    expect(view.editor().getAttribute("contenteditable")).not.toBe("true");
  });

  it("a reader whose organizer has published nothing keeps its own editor and its Save", async () => {
    const view = await mountPane([{ ...mailbox, organizerRole: "reader" }], {
      signatures: { "mb-one": "-- \nmine" }, signatureSources: { "mb-one": "local" },
    });
    expect(view.pane.textContent).not.toContain(words.mailboxRead);
    expect(view.pane.textContent).toContain(words.mailboxOn);
    expect(view.save()).not.toBeNull();
    expect(view.editor().getAttribute("contenteditable")).toBe("true");
  });

  it("a reader with no sources map at all is not locked out", async () => {
    const view = await mountPane([{ ...mailbox, organizerRole: "reader" }], {
      signatures: { "mb-one": "-- \nmine" },
    });
    expect(view.pane.textContent).not.toContain(words.mailboxRead);
    expect(view.save()).not.toBeNull();
  });

  for (const role of ["organizer", null, undefined] as const) {
    it(`an organizer mailbox (role ${String(role)}) keeps its editor and its Save`, async () => {
      const view = await mountPane([{ ...mailbox, organizerRole: role }], { signatures: { "mb-one": "-- \nmine" } });
      expect(view.pane.textContent).not.toContain(words.mailboxRead);
      expect(view.save()).not.toBeNull();
      expect(view.editor().getAttribute("contenteditable")).toBe("true");
    });
  }
});

describe("SignaturesRow — a removed mailbox has no editor; the live one owns the signature", () => {
  const gone = { id: "mb-gone", status: "disabled", organizerRole: "organizer" } as const;
  const refusal = () => Response.json(
    { error: { code: "organized_elsewhere", message: "Refused", details: { reason: "no_organizer", by: null } } },
    { status: 409 },
  );

  it("a removed copy with a signature beside the live row: one block, the live one, Save writes it", async () => {
    const view = await mountPane([gone, { id: "mb-live", organizerRole: "organizer" }], {
      signatures: { "mb-gone": OLD },
    });
    expect(view.editors()).toHaveLength(1);
    expect(view.pane.textContent).not.toContain("before the removal");
    expect(view.pane.textContent).toContain(words.mailboxOff);
    await editAndSave(view, "-- new");
    expect(view.writes).toEqual([{ signatures: { "mb-live": "-- new" } }]);
  });

  it("every row removed: no editor at all", async () => {
    const view = await mountPane([gone, { ...gone, id: "mb-gone-2" }], { signatures: { "mb-gone": OLD } });
    expect(view.editors()).toHaveLength(0);
  });

  it("a refusal because nothing organizes the mailbox says why, not 'try again'", async () => {
    const view = await mountPane([{ id: "mb-one", organizerRole: "reader" }], {}, refusal());
    await editAndSave(view, "-- mine");
    expect(view.pane.textContent).toContain(messages.ohbox.whyRefused.nobody);
    expect(view.pane.textContent).not.toContain(words.failed);
  });

  it("the same refusal while this install's Organize-here press stands says it is starting", async () => {
    const view = await mountPane([{
      id: "mb-one", organizerRole: "reader", takeoverAuthorizedAt: "2026-10-30T10:00:00Z",
    }], {}, refusal());
    await editAndSave(view, "-- mine");
    expect(view.pane.textContent).toContain(messages.ohbox.whyRefused.starting);
    expect(view.pane.textContent).not.toContain(words.failed);
  });

  it("any other failure keeps the try-again sentence", async () => {
    const view = await mountPane([{ id: "mb-one" }], {}, Response.json({}, { status: 500 }));
    await editAndSave(view, "-- mine");
    expect(view.pane.textContent).toContain(words.failed);
  });
});
