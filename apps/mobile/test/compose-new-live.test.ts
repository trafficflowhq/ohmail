/**
 * A MAIL WITH NO PARENT, on a real wire — `sendNew` driven through the same `bootEngine`
 * composition the app runs, against the loopback mail server. What bites: the envelope is the
 * user's (the typed recipients, the typed subject) and the MAILBOX is named explicitly, because
 * a fresh mail has no parent for `Engine.enrich` to derive one from; the three refusals — no
 * mailbox, no recipient, no content — each say so and reach the wire with NOTHING; and the
 * compose-from fallback is the engine's own `sendingMailboxId`, never a second guess here. The
 * route and the three navigation entries are pinned in the workspace's structure idiom.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, sendingMailboxId, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(HERE, "..", rel), "utf8");

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid,
    zone: "UTC",
  });
  return { fake, ...boot, actions, toasts };
}

const wire = (fake: ReturnType<typeof mailServer>, method: string, path: string) =>
  fake.seen.filter((r) => r.method === method && r.url === path);

const peer = [{ name: null, address: "peer@fake.test" }];

describe("the phone can start a mail, not only answer one", () => {
  it("carries the typed envelope, the typed subject and the named mailbox — no parent", async () => {
    const live = await scene((f) => f.addMessage(dto("m1", { subject: "Welcome" })));
    const box = sendingMailboxId(live.engine.read());
    expect(box).not.toBeNull();
    expect((await live.actions.sendNew(box, peer, "Coffee?", "Thursday works.")).outcome).toBe("sent");
    const body = JSON.parse(wire(live.fake, "POST", "/drafts")[0]!.body) as Record<string, unknown>;
    expect((body.to as { address: string }[]).map((r) => r.address)).toEqual(["peer@fake.test"]);
    expect(body.subject).toBe("Coffee?");
    expect(body.mailboxId).toBe(box);
    expect(body.body).toBe("Thursday works.");
    // A fresh mail ANSWERS nothing and FORWARDS nothing. The parent reference is stated and
    // null; the forward reference is absent — asked of every key, so a renamed field cannot
    // let a forwarded-of draft through this arm unnoticed.
    expect(body.inReplyToMessageId).toBeNull();
    expect(Object.keys(body).filter((k) => k.toLowerCase().includes("forward"))).toEqual([]);
    expect(wire(live.fake, "POST", "/drafts/d-1/send")).toHaveLength(1);
    expect(live.toasts).toContain(Copy.composeSent);
    live.store.close();
    live.fake.server.close();
  });

  /* PHONE-MAILTO-CC-BCC-NOT-CARRIED: a mailto's copies leave with the mail, each in its own field. */
  it("carries Cc and Bcc as the composer parsed them", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    const box = sendingMailboxId(live.engine.read());
    const copies = { cc: [{ name: null, address: "cc@fake.test" }], bcc: [{ name: null, address: "bcc@fake.test" }] };
    expect((await live.actions.sendNew(box, peer, "Hi", "Body", null, null, [], null, copies)).outcome).toBe("sent");
    const body = JSON.parse(wire(live.fake, "POST", "/drafts")[0]!.body) as Record<string, unknown>;
    expect((body.cc as { address: string }[]).map((r) => r.address)).toEqual(["cc@fake.test"]);
    expect((body.bcc as { address: string }[]).map((r) => r.address)).toEqual(["bcc@fake.test"]);
    live.store.close();
    live.fake.server.close();
  });

  it("a subject with no body is not content — the webapp's rule, which never reads the subject", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    const box = sendingMailboxId(live.engine.read());
    expect((await live.actions.sendNew(box, peer, "Just a subject", "   ")).outcome).toBe("failed");
    expect(wire(live.fake, "POST", "/drafts")).toHaveLength(0);
    expect(live.toasts).toContain(Copy.composeNeedContent);
    live.store.close();
    live.fake.server.close();
  });

  it("no recipient and no mailbox are DIFFERENT refusals, and neither reaches the wire", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    const box = sendingMailboxId(live.engine.read());
    expect((await live.actions.sendNew(box, [], "Hi", "Body")).outcome).toBe("failed");
    expect((await live.actions.sendNew(null, peer, "Hi", "Body")).outcome).toBe("failed");
    expect(live.toasts).toContain(Copy.composeNeedRecipient);
    expect(live.toasts).toContain(Copy.composeNoMailbox);
    expect(wire(live.fake, "POST", "/drafts")).toHaveLength(0);
    live.store.close();
    live.fake.server.close();
  });

  it("the compose-from fallback is the engine's own, and a mirror with nothing in it names none", async () => {
    const empty = await scene();
    // Nothing mirrored: no mailbox row, no message to fall back to — `null`, not a guess.
    expect(sendingMailboxId(empty.engine.read())).toBeNull();
    empty.store.close();
    empty.fake.server.close();
    const live = await scene((f) => f.addMessage(dto("m1")));
    // One message: its own mailbox is what a parent-less mail leaves from.
    expect(sendingMailboxId(live.engine.read())).toBe("mb-1");
    live.store.close();
    live.fake.server.close();
  });

  it("the mailbox the COMPOSER named is the one that sends, not the engine's fallback", async () => {
    /*
     * The engine's `enrich` fills a parent-less send's mailbox with `sendingMailboxId` when the
     * mutation names none, so a scene with one mailbox cannot tell a composer that passes its
     * own from a composer that passes nothing — both wires read the same. This arm gives the
     * mirror a SECOND mailbox and names it: the address the sheet shows above the To field and
     * the mailbox the send leaves from are then provably one value, which is the whole reason
     * the argument exists.
     */
    const live = await scene((f) => {
      f.addMessage(dto("m1", { date: "2026-08-19T09:00:00Z" }));
      f.addMessage({ ...dto("m2", { date: "2026-08-19T10:00:00Z" }), mailboxId: "mb-2" });
    });
    const fallback = sendingMailboxId(live.engine.read());
    const other = fallback === "mb-1" ? "mb-2" : "mb-1";
    expect((await live.actions.sendNew(other, peer, "Hi", "Body")).outcome).toBe("sent");
    const body = JSON.parse(wire(live.fake, "POST", "/drafts")[0]!.body) as { mailboxId: string };
    expect(body.mailboxId).toBe(other);
    expect(body.mailboxId).not.toBe(fallback);
    live.store.close();
    live.fake.server.close();
  });

  it("an attachment alone is content — a mail that is a file and a subject sends", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    const box = sendingMailboxId(live.engine.read());
    const files = [{ filename: "note.txt", contentType: "text/plain", contentBase64: "aGk=" }];
    expect((await live.actions.sendNew(box, peer, "Here", "", null, null, files)).outcome).toBe("sent");
    // The bytes ride the SEND, not the draft — the same two-request shape a reply's do.
    const sent = JSON.parse(wire(live.fake, "POST", "/drafts/d-1/send")[0]!.body) as {
      attachments?: { filename: string }[];
    };
    expect(sent.attachments?.map((a) => a.filename)).toEqual(["note.txt"]);
    const draft = JSON.parse(wire(live.fake, "POST", "/drafts")[0]!.body) as { subject: string };
    expect(draft.subject).toBe("Here");
    live.store.close();
    live.fake.server.close();
  });
});

describe("the composer and the three navigation entries, in the structure idiom", () => {
  const route = read("app/compose.tsx");
  const sheet = read("src/ui/MessageActions.tsx");
  const nav = read("app/(tabs)/_layout.tsx");
  const rail = read("src/ui/nav-rail.tsx");
  const dock = read("src/ui/glass/GlassDock.tsx");
  const ld = read("src/ui/list-detail.tsx");

  it("the route opens the SAME composer with no parent, and refuses when nothing can send", () => {
    expect(route).toContain('<ComposeSheet m={null} mode="new"');
    expect(route).toContain("w.mailboxes.sendingId === null");
    expect(route).toContain("Copy.composeNoMailbox");
    // One composer, not a second: the fresh mode lives in the sheet the reader already uses.
    expect(sheet).toContain("export function ComposeSheet");
    expect(sheet).toContain('const fresh = mode === "new";');
    // THE CARET GOES TO THE FIELD THE MESSAGE IS MISSING. Measured on a device: the body's
    // unconditional autoFocus won, so a new mail opened with the cursor in the body under
    // "Write your reply…" and the To field empty above it. Both halves are pinned, because
    // either one alone is the defect: To takes focus only on a fresh mail, and the body
    // yields it only there.
    expect(sheet).toContain("autoFocus={fresh}");
    expect(sheet).toContain("autoFocus={!fresh}");
    // And the writing area asks for a message, not a reply, when there is nothing to answer.
    expect(sheet).toMatch(/const bodyPlaceholder = fresh\s*\?\s*Copy\.composeBodyPlaceholder/);
    expect(sheet).toContain("Copy.composeSubject");
    expect(sheet).toContain("w.actions.sendNew(sendFrom, recipients ?? [], subject, body, sigText, sendAt, files, draftId, sendCopies ?? undefined, baseFor(base.current, draftId), waitedFor(base.current, draftId))");
  });

  it("every navigation entry opens the one route — dock, rail, the iOS pane foot", () => {
    expect(nav).toContain('router.push("/compose")');
    expect(nav).toContain("compose={compose}");
    expect(dock).toContain("compose?: { label: string; onPress: () => void }");
    /* The rail moved to the ROOT so it stands on the pushed screens too; its own fixed entry
       carries the same route, and the tab-bar slot yields the rail postures to it. */
    expect(rail).toContain('id: "__compose"');
    expect(rail).toContain('router.push("/compose")');
    expect(ld).toContain('router.push("/compose")');
  });
});
