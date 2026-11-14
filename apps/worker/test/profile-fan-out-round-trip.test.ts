import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, mailboxes, organizerRequests, PROFILE_SIGNATURE_MAX,
  TRAVELLING_OHBOX_BAR_MAX_BYTES, TRAVELLING_SIGNATURE_HTML_MAX_BYTES, type Tx,
  accountPass, readPassProgress,
} from "@trafficflow/db";
import {
  OHBOX_BAR_MAX_BYTES, setMailboxSignature, setScreeningPreference, type ScreeningPreferenceUpdate,
} from "@trafficflow/services/mail";
import { profileRoundTrip } from "./_profile-round-trip.js";

/**
 * A reader's settings edit, from the door to the organizer's stored row, with every payload
 * built by the reader's own serializer. The screening preference travelled as an object and the
 * holder parsed a string, so every posture, bar and switch edit made on a reader was refused as
 * `invalid_payload` while the reader answered "pending". The pg twin runs the organizer's drain
 * on a real server.
 */

const NOW = new Date("2026-09-20T10:00:00.000Z");
/** Each round trip opens two PGlite stores; two trips in one case pass 5 s under load. */
const T = 30_000;

type Seed = Omit<typeof accountSettings.$inferInsert, "accountId">;

async function screening(update: ScreeningPreferenceUpdate, seed?: Seed) {
  const organizer = await makeTestDb();
  const accountId = randomUUID();
  if (seed) await organizer.insert(accountSettings).values({ ...seed, accountId });
  const rt = await profileRoundTrip({
    organizerDb: organizer as unknown as Tx, accountId, now: NOW,
    press: (ctx) => setScreeningPreference(ctx, update),
  });
  const [stored] = await organizer.select().from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  return { rt, stored, tidy: await readPassProgress(organizer as unknown as Tx, accountPass("ohbox_tidy", accountId)) };
}

describe("a reader's screening edit reaches the organizer", () => {
  it("the posture and the bar travel, apply, and the reader is told applied", async () => {
    const { rt, stored, tidy } = await screening({ ohboxPolicy: "people_only", ohboxBar: "People I write back to." });
    expect((rt.answer as { pending?: boolean }).pending).toBe(true);
    expect(rt.drain).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });
    expect(rt.ack?.outcome, `refused: ${rt.ack?.reason}`).toBe("applied");
    expect(rt.readerRow?.state).toBe("applied");
    expect(stored?.ohboxPolicy).toBe("people_only");
    expect(stored?.ohboxBar).toBe("People I write back to.");
    expect(tidy.requestedAt, "the transition into people_only armed nothing").not.toBeNull();
  }, T);

  it("a partial edit changes only the key it carries", async () => {
    const off = new Date("2026-09-01T00:00:00.000Z");
    const { rt, stored, tidy } = await screening({ ohboxBar: "new words" }, {
      ohboxPolicy: "people_only", ohboxBar: "old words", impersonationFilingOffAt: off,
    });
    expect(rt.readerRow?.payload).toEqual({ screeningPreference: { ohboxBar: "new words" } });
    expect(rt.readerRow?.state).toBe("applied");
    expect(stored?.ohboxBar).toBe("new words");
    expect(stored?.ohboxPolicy).toBe("people_only");
    expect(stored?.impersonationFilingOffAt?.toISOString()).toBe(off.toISOString());
    expect(tidy.requestedAt, "a bar edit re-armed the backlog pass").toBeNull();
  }, T);

  it("the posture reset reaches the organizer as NULL", async () => {
    const { rt, stored, tidy } = await screening({ ohboxPolicy: null }, { ohboxPolicy: "people_only" });
    expect(rt.readerRow?.state).toBe("applied");
    expect(stored?.ohboxPolicy).toBeNull();
  }, T);

  it("the impersonation filing switch travels both ways: off stamps the organizer's row, on clears it", async () => {
    const off = await screening({ impersonationFiling: false });
    expect(off.rt.readerRow?.payload).toEqual({ screeningPreference: { impersonationFiling: false } });
    expect(off.rt.readerRow?.state).toBe("applied");
    expect(off.stored?.impersonationFilingOffAt, "the organizer's pass would still file").not.toBeNull();
    const on = await screening({ impersonationFiling: true }, { impersonationFilingOffAt: new Date("2026-09-01T00:00:00.000Z") });
    expect(on.rt.readerRow?.state).toBe("applied");
    expect(on.stored?.impersonationFilingOffAt).toBeNull();
  }, T);

  it("the two doors share one bar ceiling: at it travels, past it the reader refuses", async () => {
    expect(TRAVELLING_OHBOX_BAR_MAX_BYTES).toBe(OHBOX_BAR_MAX_BYTES);
    const at = await screening({ ohboxBar: "é".repeat(OHBOX_BAR_MAX_BYTES / 2) });
    expect(at.rt.readerRow?.state).toBe("applied");
    expect(Buffer.byteLength(at.stored!.ohboxBar!, "utf8")).toBe(OHBOX_BAR_MAX_BYTES);
    const over = await screening({ ohboxBar: `${"é".repeat(OHBOX_BAR_MAX_BYTES / 2)}x` });
    expect(String(over.rt.answer)).toContain(`${OHBOX_BAR_MAX_BYTES} bytes`);
    expect(over.rt.readerRow, "a bar past the ceiling was queued").toBeNull();
  }, T);
});

describe("a reader's signature edit is admitted in the holder's unit", () => {
  async function signature(text: string | null, html?: string) {
    const organizer = await makeTestDb();
    const accountId = randomUUID();
    const rt = await profileRoundTrip({
      organizerDb: organizer as unknown as Tx, accountId, now: NOW,
      press: (ctx, mailboxId) => setMailboxSignature(ctx, mailboxId, text, html),
    });
    const [mb] = await organizer.select({ text: mailboxes.signature, html: mailboxes.signatureHtml })
      .from(mailboxes).where(eq(mailboxes.accountId, accountId));
    const queued = await (rt.readerCtx.db as unknown as Awaited<ReturnType<typeof makeTestDb>>)
      .select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
    return { rt, mb, queued };
  }

  it("a multi-byte text at the byte bound applies; one character more is refused at the reader", async () => {
    const at = await signature("é".repeat(PROFILE_SIGNATURE_MAX / 2));
    expect(at.rt.readerRow?.state).toBe("applied");
    expect(Buffer.byteLength(at.mb!.text!, "utf8")).toBe(PROFILE_SIGNATURE_MAX);
    const over = await signature("é".repeat(PROFILE_SIGNATURE_MAX / 2 + 1));
    expect(String(over.rt.answer)).toContain(`${PROFILE_SIGNATURE_MAX} bytes`);
    expect(over.queued, "a signature the holder refuses was queued").toEqual([]);
  }, T);

  it("markup past the holder's bound is refused at the reader; markup inside it applies", async () => {
    const small = await signature(null, "<p><b>Mila</b> — Zurich</p>");
    expect(small.rt.readerRow?.state).toBe("applied");
    expect(small.mb?.html).toContain("<b>Mila</b>");
    const big = `<p>${"<b>x</b> ".repeat(233)}</p>`;
    const over = await signature(null, big);
    expect(String(over.rt.answer)).toContain(`${TRAVELLING_SIGNATURE_HTML_MAX_BYTES} bytes`);
    expect(over.queued, "markup the holder refuses was queued").toEqual([]);
  }, T);
});
