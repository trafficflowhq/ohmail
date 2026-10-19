/**
 * A MEETING INVITATION THE PHONE CANNOT SHOW SAYS SO (reported 2026-10-19). An OWA stub in the
 * full body text names the setting and links only to core's rebuilt options page; the stored-header
 * fact, carried off the wire, says the generic line. The generic sentence is the web reader's word
 * for word; the stub's name no provider; the German addresses the reader as du.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryMirrorStore, OhmailEngine, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import {
  OWA_ORDINARY as ORDINARY, OWA_SETTING_HREF as HREF, OWA_STUB as STUB, OWA_STUB_ONPREM as ONPREM,
} from "../../../packages/core/test/fixtures/owa-invitation-stub";
import { invitationNote } from "../src/ui/body-note";
import { liveMessage, owaInvitationOf, type WorldView } from "../src/state/live";
import { Copy, DECKS } from "../src/copy";
import { EN as en } from "../src/copy.en";
import { DE as de } from "../src/copy.de";

const HERE = path.dirname(fileURLToPath(import.meta.url));

type Row = Parameters<typeof invitationNote>[0];
/** The row as `liveMessage` attaches it: the state layer reads the body, the note reads the row. */
const row = (text: string, bodyState: "full" | "snippet" | "loading" = "full", fact?: true): Row => {
  const owa = owaInvitationOf({ state: bodyState, text });
  return { bodyState, ...(owa ? { owaInvitation: owa } : {}), ...(fact ? { invitationWithoutEvent: fact } : {}) };
};

describe("the phone's invitation note", () => {
  it("an OWA stub says so, names the setting and offers the rebuilt link", () => {
    expect(invitationNote(row(STUB))).toEqual({ line: `${Copy.invitationOwaLink} ${Copy.invitationOwaRemedy}`, href: HREF });
  });

  it("the stub line wins over the header fact", () => {
    expect(invitationNote(row(STUB, "full", true))?.href).toBe(HREF);
  });

  it("on-premises Exchange: the line, no link", () => {
    expect(invitationNote(row(ONPREM))).toEqual({ line: `${Copy.invitationOwaLink} ${Copy.invitationOwaRemedy}`, href: null });
  });

  it("the header fact over an ordinary body says the generic line", () => {
    expect(invitationNote(row("Agenda attached.", "full", true))).toEqual({ line: Copy.invitationWithoutEvent, href: null });
  });

  it("a snippet or a loading body is never read for the stub", () => {
    expect(invitationNote(row(STUB, "snippet"))).toBeNull();
    expect(invitationNote(row(STUB, "loading"))).toBeNull();
  });

  it("ordinary mail linking to the options page says nothing", () => {
    expect(invitationNote(row(ORDINARY))).toBeNull();
    expect(invitationNote(row(""))).toBeNull();
  });

  it("the stub line claims nothing about who delivered it: anyone can send a stub", () => {
    expect(DECKS.en.invitationOwaLink).not.toMatch(/mail server/i);
    expect(DECKS.de.invitationOwaLink).not.toMatch(/mailserver/i);
  });
});

describe("the fact and the body reach the phone's open message", () => {
  const view: WorldView = { now: new Date("2026-10-19T09:00:00Z"), zone: "UTC" };
  const date = "2026-10-19T08:30:00.000Z";
  const letter = (id: string, extra: Partial<EngineMessage> = {}): EngineMessage => ({
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Think tank", from: { name: "A Colleague", address: "colleague@sender.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: STUB.slice(0, 20), unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, ...extra,
  } as EngineMessage);

  async function engineOf(m: EngineMessage, text: string): Promise<OhmailEngine> {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{ type: "message", op: "create", id: m.id, seq: 1, updatedAt: date, entity: m } as SyncChange]);
    return new OhmailEngine({
      store, now: () => view.now,
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: date }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => ({ text, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
      },
    });
  }

  it("the header fact rides the projection; absent stays absent", async () => {
    const withFact = await engineOf(letter("m-f", { invitationWithoutEvent: true }), "Agenda.");
    expect(liveMessage(withFact, "m-f", view)?.invitationWithoutEvent).toBe(true);
    const without = await engineOf(letter("m-n", { invitationWithoutEvent: false }), "Agenda.");
    expect(liveMessage(without, "m-n", view)?.invitationWithoutEvent).toBeUndefined();
  });

  it("a hydrated stub body is recognized on the open message, with no header fact", async () => {
    const engine = await engineOf(letter("m-s"), STUB);
    await engine.hydrateBody("m-s");
    const m = liveMessage(engine, "m-s", view)!;
    expect(m.bodyState).toBe("full");
    expect(invitationNote(m)?.href).toBe(HREF);
  });
});

describe("the reader draws it, and the copy is the web's", () => {
  it("the reader renders the note and opens the link through the confirmed opener", () => {
    const src = withoutComments(fs.readFileSync(path.join(HERE, "../src/ui/MessageReader.tsx"), "utf8"));
    expect(src).toMatch(/invitationNote\(m\)/);
    expect(src).toMatch(/openConfirmedLink\(/);
  });

  it("the generic sentence is the web reader's; the stub's name the setting; the German says du", () => {
    const web = (locale: string): Record<string, string> => (JSON.parse(fs.readFileSync(
      path.join(HERE, "../../webapp/messages", `${locale}.json`), "utf8",
    )) as { body: Record<string, string> }).body;
    expect(en.invitationWithoutEvent).toBe(web("en").invitationWithoutEvent);
    expect(de.invitationWithoutEvent).toBe(web("de").invitationWithoutEvent);
    expect(en.invitationOwaRemedy).toContain("“Send meeting invitations in iCalendar format”");
    expect(de.invitationOwaRemedy).toContain("iCalendar-Format");
    for (const key of ["invitationWithoutEvent", "invitationOwaLink", "invitationOwaRemedy", "invitationOwaOpenSetting"] as const) {
      expect(/\b(Sie|Ihnen|Ihr|Ihre)\b/.test(de[key]), key).toBe(false);
    }
  });
});
