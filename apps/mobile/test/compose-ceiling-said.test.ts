/**
 * PAST THE DRAFT LIMIT A PHONE SEND IS REFUSED BEFORE THE WIRE, AND SAYS THE LIMIT.
 * Measured on 0.28.0: a ~280 KB letter's Send went to `POST /drafts`, got 413, and said "Sending
 * didn't work. Try again." — a retry that can never help. `sendNew`, `sendReply` and `sendForward`
 * now judge the signed body with the web's predicate and dispatch nothing past it.
 * Mutation: the check in any one of the three removed → its case red on the wire.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DRAFT_BODY_MAX_BYTES } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const peer = [{ name: null, address: "peer@fake.test" }];
const at = "é".repeat(DRAFT_BODY_MAX_BYTES / 2);
const over = `${at}x`;
const SAID = "Not sent. It's too long to send — the limit is 256 KB. Shorten it and send again.";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  open.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  return { fake, actions, toasts };
}

const wrote = (fake: ReturnType<typeof mailServer>) =>
  fake.seen.filter((r) => r.method !== "GET" && (r.url === "/drafts" || r.url.startsWith("/drafts/"))).length;

describe("a phone send past the draft limit", () => {
  it("a new mail, a reply and a forward dispatch nothing, and each says the limit", async () => {
    const presses: Array<[string, (a: LiveWorldActions) => ReturnType<LiveWorldActions["sendNew"]>]> = [
      ["new", (a) => a.sendNew("mb-1", peer, "Long", over)],
      ["reply", (a) => a.sendReply("m1", over, false)],
      ["forward", (a) => a.sendForward("m1", peer, over)],
    ];
    for (const [what, pressIt] of presses) {
      const live = await scene();
      const res = await pressIt(live.actions);
      expect({ res, toasts: live.toasts, wrote: wrote(live.fake) }, what).toEqual({
        res: { outcome: "failed", failure: "replyTooLong" }, toasts: [SAID], wrote: 0,
      });
    }
  }, 60_000);

  it("the signature counts: words at the limit plus a signature are past it", async () => {
    const live = await scene();
    const res = await live.actions.sendNew("mb-1", peer, "Long", at, "Lena");
    expect({ outcome: res.outcome, wrote: wrote(live.fake) }).toEqual({ outcome: "failed", wrote: 0 });
  }, 30_000);

  it("control: exactly at the limit it sends", async () => {
    const live = await scene();
    const res = await live.actions.sendNew("mb-1", peer, "Long", at);
    expect(res.outcome).toBe("sent");
    expect(live.toasts).toEqual([Copy.composeSent]);
  }, 30_000);
});
