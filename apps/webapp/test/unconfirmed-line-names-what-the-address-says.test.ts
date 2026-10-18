import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { messages } from "@trafficflow/db";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, screenerSegments, type EngineMessage, type FetchLike,
} from "@ohmail/client-engine";
import { FIXED_NOW, makeDeps, seedMailbox, seedScreenerHeld, seedSession } from "../../../packages/api/test/helpers.js";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { senderCheckFact, senderCheckSentence } from "../app/shell/sender-check.js";

/**
 * THE "DID NOT CONFIRM" LINE NAMES WHAT THE ADDRESS SAYS — from the real route, through the mirror,
 * to the web's own sentence (the desktop renders this bundle). A government's umbrella domain names
 * no one office: every Swiss federal office sends from a host under `admin.ch` and the first
 * dictionary row listing it is ESTV's, so a BAG letter at a mailbox whose provider confirms nothing
 * read "This message says it is from ESTV" in the reader, the sender sheet and the Screener. The web
 * holds no dictionary: it says the name the server gives, and the server now gives the domain.
 */

const app = createApp(apiRoutes);
type Words = (key: string, values?: Record<string, string>) => string;
const EN = createTranslator({ locale: "en", messages: en as never, namespace: "screener" }) as unknown as Words;
const DE = createTranslator({ locale: "de", messages: de as never, namespace: "screener" }) as unknown as Words;

/** Held letters on the real backend, their provider's word as ingest stores it, mirrored by the engine. */
async function mirrorOf(letters: ReadonlyArray<{ from: string; verdict: string | null }>) {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    return app.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null } as ApiDeps);
  };
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  const ids = new Map<string, string>();
  for (const l of letters) {
    const m = await seedScreenerHeld(db, { accountId: s.accountId, mailboxId, fromAddress: l.from });
    // The provider's word, and the identity column checked clean: what ingest writes.
    await db.update(messages).set({ authVerdict: l.verdict, senderCheck: "none" }).where(eq(messages.id, m.id));
    // Ingest emits the change in production; here a real wire mutation does, as the contract tests do.
    const patch = await fetchImpl(`http://localhost/messages/${m.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ unread: true }),
    });
    expect(patch.status).toBe(200);
    ids.set(l.from, m.id);
  }
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), store, now: () => FIXED_NOW,
  });
  await engine.start();
  const line = (from: string, t: Words): string | null => {
    const m = store.get<EngineMessage>("message", ids.get(from)!);
    expect(m, `${from} reached the mirror`).toBeDefined();
    const f = senderCheckFact(m!);
    return f === null ? null : senderCheckSentence(t, f);
  };
  return { engine, line };
}

describe("the unconfirmed line on the web names what the address says", () => {
  it("a federal office at an umbrella domain reads as the domain, in both languages, never as one office", async () => {
    const w = await mirrorOf([
      { from: "info@bag.admin.ch", verdict: "unavailable" },
      { from: "poststelle@bsi.bund.de", verdict: null },
      // CONTROLS: a brand's own domain names the brand; a confirmed letter says nothing.
      { from: "service@paypal.com", verdict: "unavailable" },
      { from: "info@zas.admin.ch", verdict: "pass" },
    ]);
    expect(w.line("info@bag.admin.ch", EN)).toBe("This message says it is from admin.ch. Your mail provider did not confirm that.");
    expect(w.line("info@bag.admin.ch", DE)).toBe("Diese Nachricht gibt an, von admin.ch zu kommen. Dein Mailanbieter hat das nicht bestätigt.");
    expect(w.line("poststelle@bsi.bund.de", EN)).toBe("This message says it is from bund.de. Your mail provider did not confirm that.");
    expect(w.line("service@paypal.com", EN)).toBe("This message says it is from PayPal. Your mail provider did not confirm that.");
    expect(w.line("info@zas.admin.ch", EN)).toBeNull();

    // The Screener's rows off the same mirror carry the same name, and a confirmed office none.
    const waiting = screenerSegments(w.engine.read(), FIXED_NOW).waiting;
    const checked = (from: string) => waiting.find((r) => r.from.address === from)?.checked;
    expect(checked("info@bag.admin.ch")).toMatchObject({ reason: "unverified", brand: "admin.ch" });
    expect(checked("poststelle@bsi.bund.de")).toMatchObject({ reason: "unverified", brand: "bund.de" });
    expect(checked("info@zas.admin.ch")).toBeUndefined();
  });
});
