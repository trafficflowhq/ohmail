/**
 * ═══ A COMPOSER UNMOUNTED WITHOUT A CLOSE KEEPS WHAT A CLOSE KEEPS, Cc AND Bcc INCLUDED ════════
 *
 * The unmount keep (a fold or an unfold the reader hold does not stop) was written before new mail
 * carried copies, so it left `copiesToKeep(copies)` out and the engine wrote the kept draft with an
 * empty Cc and Bcc. The close keep and the unmount keep now build one request; only `quiet` differs.
 */
import type { EngineDraft } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { keptRecipients, liveActions, type LiveWorldActions } from "../src/state/live";
import { copiesToKeep } from "../src/ui/compose-copies";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const actions = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/MessageActions.tsx", import.meta.url)), "utf8"));
const sheet = actions.slice(actions.indexOf("export function ComposeSheet("), actions.indexOf("\nfunction ", actions.indexOf("export function ComposeSheet(")));

/** The object literal handed to the `draftKeep(` call that follows `anchor`, whitespace folded. */
const keepArgs = (anchor: string): string => {
  const at = sheet.indexOf(anchor);
  expect(at, `no ${anchor} in ComposeSheet`).toBeGreaterThan(0);
  const open = sheet.indexOf("draftKeep({", at) + "draftKeep({".length;
  return sheet.slice(open, sheet.indexOf("});", open)).replace(/\s+/g, " ").trim();
};
/** `quiet` is the one field the two keeps may disagree on: an unmount is never announced. */
const withoutQuiet = (args: string): string =>
  args.replace("...(draft !== undefined ? { quiet: true } : {}),", "").replace("quiet: true,", "").replace(/\s+/g, " ").trim();

describe("the unmount keep builds the close keep's request", () => {
  it("every field the close keeps, the unmount keeps (Cc and Bcc of a new mail included)", () => {
    const close = keepArgs("const kept = await w.actions.");
    const unmount = keepArgs("atUnmount.current = () => {");
    expect(close, "the close keep no longer carries a new mail's copies").toContain("...(fresh ? copiesToKeep(copies) : {})");
    expect(withoutQuiet(unmount), "the unmount keep drops a field the close keeps").toBe(withoutQuiet(close));
    expect(unmount, "an unmount keep is announced").toContain("quiet: true");
  });
});

/* The consequence, through the engine: a keep without the copies writes the bound row's Cc and Bcc empty. */
const COPIES = { cc: "Cy <cy@fake.test>", bcc: "b@fake.test" };
const draftRow = (): EngineDraft => ({
  id: "d-9", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the body", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [{ name: "Cy", address: "cy@fake.test" }], bcc: [{ name: null, address: "b@fake.test" }],
  rationale: null, status: "draft", createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-20T14:29:00.000Z",
} as EngineDraft);

const world = sqlWorld();
const uuid = (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const live: { close(): void }[] = [];
afterEach(() => { for (const o of live.splice(0)) o.close(); });

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  fake.addDraft({ ...draftRow() } as unknown as Record<string, unknown> & { id: string });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  await boot.engine.syncOnce();
  live.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const world: LiveWorldActions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m), uuid, zone: "UTC" });
  return { fake, world };
}

const screen = { to: "Ada <ada@fake.test>", subject: "Invoice 12", body: "the body, edited before the fold" };
const keep = (s: Awaited<ReturnType<typeof scene>>, copies: ReturnType<typeof copiesToKeep> | Record<string, never>) =>
  s.world.draftKeep({
    mode: "new", messageId: null, mailboxId: "mb-1", to: keptRecipients(screen.to),
    ...copies, subject: screen.subject, body: screen.body, files: 0, draftId: "d-9", quiet: true,
  });

describe("what the keep's copies decide on the kept row", () => {
  it("kept with the copies, the row keeps its Cc and Bcc", async () => {
    const s = await scene();
    expect(await keep(s, copiesToKeep(COPIES))).toBe("kept");
    const row = s.fake.draft("d-9")!;
    expect({ cc: row.cc, bcc: row.bcc }).toEqual({
      cc: [{ name: "Cy", address: "cy@fake.test" }], bcc: [{ name: null, address: "b@fake.test" }],
    });
  }, 30_000);

  it("the control: kept without them, the row loses both (the request shape the unmount used to send)", async () => {
    const s = await scene();
    expect(await keep(s, {})).toBe("kept");
    const row = s.fake.draft("d-9")!;
    expect({ cc: row.cc, bcc: row.bcc }).toEqual({ cc: [], bcc: [] });
  }, 30_000);
});
