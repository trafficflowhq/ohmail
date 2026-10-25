/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { ComposeAttachment } from "@ohmail/client-engine";
import {
  composePlan,
  readComposeDraft,
  writeComposeDraft,
  EMPTY_COMPOSE,
  composeDraftKey,
  type ComposeFields,
} from "../app/shell/compose.js";

/**
 * ═══ FORWARDING, REACHED FROM THE SURFACE ═══════════════════════════════════════════════
 *
 * The forward path shipped in three layers and only two of them were connected: `SendService`
 * refuses a `no_forward` original, quotes the message and streams its attachments; the http adapter
 * puts `forwardOf` on `POST /drafts/:id/send`; and NOTHING in the client ever set the field. The
 * chrome declared `forward?: (id) => void` as optional, `MessageCard` rendered its sibling footer
 * only when the shell supplied it, and no shell did — so every one of the server's forward tests
 * was green against a verb no user could press.
 *
 * That shape is why the assertions below are split the way they are:
 *
 *  · the FORM half is behavioural — `composePlan` is the one function that decides what goes on
 *    the wire, so `forwardOf` reaching `plan.mutation` (and being ABSENT otherwise) is testable
 *    directly, and mutating either arm turns it red;
 *  · the SHELL half is read out of `shell-compose.ts`'s source. Mounting the whole shell to observe a
 *    context value costs an engine, a router and a keymap, and what actually regressed was one
 *    property missing from one object literal — so the guard reads that literal. Comments are
 *    stripped first for the reason `attachments-wired.test.ts` states: the prose in this repo quotes
 *    the code it describes, and an assertion that can be satisfied by a comment is worthless.
 *
 * ── AND ONE TYPE-LEVEL GUARD ──────────────────────────────────────────────────────────────────
 *
 * `ComposeAttachment` is imported from `@ohmail/client-engine` above and annotated below. That is
 * not decoration: `apps/webapp`'s tsconfig includes every `.ts` under the app, so this file is
 * typechecked, and the
 * annotation is what fails `pnpm -F @ohmail/webapp typecheck` if the client-engine barrel stops
 * exporting the type — the exact break this slice was recovered from, where `ComposeAttach.tsx` and
 * `compose.ts` both imported a name `src/index.ts` did not re-export.
 */

/**
 * A file under `apps/webapp`, read whichever directory the runner was started in — the same
 * `readSource` `compose-composition.test.ts` carries, and for the same reason: this suite needs
 * jsdom for the `localStorage` half, and under jsdom `import.meta.url` is not a `file:` URL, so the
 * `fileURLToPath(new URL(rel, import.meta.url))` idiom every node-environment test here uses throws.
 */
function readSource(rel: string): string {
  const fromRoot = `apps/webapp/${rel}`;
  return readFileSync(existsSync(fromRoot) ? fromRoot : rel, "utf8");
}
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");
const shell = stripComments(readSource("app/shell/shell-compose.ts"));
/* The `chrome` memo is the contract between the compose verbs and `MessagePane`, and it stayed
   in the shell frame when the verbs left (ARCH-022) — the two arms that read it read this. */
const frame = stripComments(readSource("app/shell/AppShell.tsx"));

/** A compose form with a forward on it. */
function forwarding(over: Partial<ComposeFields> = {}): ComposeFields {
  return {
    ...EMPTY_COMPOSE,
    to: "her@example.com",
    subject: "Fwd: Invoice 4417",
    body: "See below.",
    forwardOf: "m-original",
    ...over,
  };
}

describe("composePlan carries forwardOf onto the mutation", () => {
  it("puts the original's id on the send", () => {
    const plan = composePlan(forwarding(), "mb-1");
    expect(plan.mutation.forwardOf).toBe("m-original");
  });

  it("keeps inReplyTo null — a forward threads onto nothing", () => {
    // The two fields are exclusive peers (`types.ts`). A forward that also carried `inReplyTo`
    // would file itself onto the original's conversation and send `In-Reply-To`/`References`
    // headers naming a message its recipients have never seen.
    const plan = composePlan(forwarding(), "mb-1");
    expect(plan.mutation.inReplyTo).toBeNull();
  });

  it("OMITS the key entirely on a plain compose, rather than sending null", () => {
    // The http adapter branches on `if (m.forwardOf)`, and the server on `if (input.forwardOf)`,
    // so a `null` would be harmless — but the request body must stay byte-identical to what a
    // plain compose has always sent, or the send-request guards start describing two shapes.
    const plan = composePlan({ ...EMPTY_COMPOSE, to: "a@b.example", subject: "s", body: "b" }, "mb-1");
    expect("forwardOf" in plan.mutation).toBe(false);
  });

  it("omits it for an empty-string forwardOf, not just a null one", () => {
    const plan = composePlan(forwarding({ forwardOf: "" }), "mb-1");
    expect("forwardOf" in plan.mutation).toBe(false);
  });

  it("still refuses the whole send on a mistyped recipient while forwarding", () => {
    // A forward is not a privileged send: the "a typo blocks everything" rule is expressed by
    // emptying the recipient set, and `forwardOf` must not smuggle a send past it.
    const plan = composePlan(forwarding({ to: "her@example.com, nodot@localhost" }), "mb-1");
    expect(plan.mutation.to).toEqual([]);
    expect(plan.invalid).toEqual(["nodot@localhost"]);
  });

  it("carries attachments and forwardOf together — a forward may add files of its own", () => {
    const file: ComposeAttachment = {
      filename: "note.txt", contentType: "text/plain", contentBase64: "aGk=",
    };
    const plan = composePlan(forwarding({ attachments: [file] }), "mb-1");
    expect(plan.mutation.forwardOf).toBe("m-original");
    expect(plan.mutation.attachments).toEqual([file]);
  });
});

describe("a forward's kept files ride the plan and the scratch buffer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a list goes on the send beside its forward; none, or no forward, sends no key", () => {
    expect(composePlan(forwarding({ forwardParts: ["p-1", "p-2"] }), "mb-1").mutation.forwardParts).toEqual(["p-1", "p-2"]);
    expect("forwardParts" in composePlan(forwarding({ forwardParts: null }), "mb-1").mutation).toBe(false);
    expect("forwardParts" in composePlan(forwarding({ forwardOf: null, forwardParts: ["p-1"] }), "mb-1").mutation).toBe(false);
    expect(composePlan(forwarding({ forwardParts: [] }), "mb-1").mutation.forwardParts).toEqual([]);
  });

  it("the buffer keeps the list across a reload; a malformed one reads as nothing removed", () => {
    writeComposeDraft(forwarding({ forwardParts: ["p-1"] }));
    expect(readComposeDraft().forwardParts).toEqual(["p-1"]);
    window.localStorage.setItem(composeDraftKey(), JSON.stringify({ ...forwarding(), forwardParts: [7] }));
    expect(readComposeDraft().forwardParts).toBeNull();
    window.localStorage.setItem(composeDraftKey(), JSON.stringify({ ...forwarding(), forwardParts: Array.from({ length: 101 }, (_, i) => `p-${i}`) }));
    expect(readComposeDraft().forwardParts).toBeNull();
  });
});

describe("the scratch buffer keeps the forward and drops the bytes", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists forwardOf and restores it", () => {
    // Losing it across a reload would leave a message titled "Fwd: …" that quotes nothing — the
    // user would send an empty mail and only find out from the recipient.
    writeComposeDraft(forwarding());
    expect(readComposeDraft().forwardOf).toBe("m-original");
  });

  it("still strips the attachment bytes from what is stored", () => {
    writeComposeDraft(forwarding({
      attachments: [{ filename: "big.bin", contentType: "application/octet-stream", contentBase64: "AAAA" }],
    }));
    const raw = window.localStorage.getItem(composeDraftKey()) ?? "";
    expect(raw).toContain("m-original");
    expect(raw).not.toContain("AAAA");
    expect(readComposeDraft().attachments).toEqual([]);
  });

  it("reads a buffer written before the field existed as a plain compose", () => {
    window.localStorage.setItem(
      composeDraftKey(),
      JSON.stringify({ to: "a@b.example", cc: "", bcc: "", subject: "s", body: "b", html: "" }),
    );
    expect(readComposeDraft().forwardOf).toBeNull();
  });

  it("ignores a non-string forwardOf rather than trusting it onto the wire", () => {
    window.localStorage.setItem(
      composeDraftKey(),
      JSON.stringify({ to: "a@b.example", subject: "s", body: "b", forwardOf: { id: "x" } }),
    );
    expect(readComposeDraft().forwardOf).toBeNull();
  });
});

describe("the shell wires the two sibling verbs — and forward is the INLINE dock now", () => {
  // These used to pin `forwardMessage`, the compose-seeding forward: ⋯ → Forward navigated to
  // the compose screen. That navigation was reported from real use as the defect; the verbs'
  // wiring guards survive, rewritten against `openForward` — the reply dock in forward mode,
  // inside the thread (`thread-inline-forward.test.tsx` drives the behavior; these read the
  // wiring the way the originals did, because what regressed last time was one property
  // missing from one object literal).
  it("the chrome the provider publishes names openReply and forward — the inline open", () => {
    const memo = /const chrome = useMemo\(\s*\(\) => \(\{([\s\S]*?)\}\),/.exec(frame);
    expect(memo, "AppShell's chrome memo could not be located").not.toBeNull();
    const body = memo![1]!;
    expect(body).toMatch(/(^|[\s,{])openReply\s*[,}]/);
    expect(body).toMatch(/forward:\s*openForward/);
  });

  it("both verbs are in the memo's dependency list, so they are not captured stale", () => {
    // Anchored on the array's head and its first closing `],` — the tail grew a member
    // (`consent.foldersEnabled`, the Delete verb's gate) and an exact-tail anchor went stale.
    const deps = /\[ownAddresses, absoluteTime[\s\S]*?\],/.exec(frame);
    expect(deps, "the chrome memo's dependency array could not be located").not.toBeNull();
    expect(deps![0]).toContain("openReply");
    expect(deps![0]).toContain("openForward");
  });

  it("the inline forward ASKS on a no_forward message and fetches an off-mirror one — it never refuses", () => {
    // Forward is always offered (owner, 2026-09-25): the press reads `forwardPress`, records the ask
    // before the dock opens, and hydrates an off-mirror row first. No refusal toast remains.
    const fn = /const openForward = useStableCallback\(([\s\S]*?)\n  \}\);/.exec(shell);
    expect(fn, "openForward could not be located").not.toBeNull();
    const body = fn![1]!;
    expect(body).toContain("forwardPress(");
    expect(body).toContain("hydrateBody(");
    expect(body).not.toContain("toast(");
    // The gate is written before the dock opens, so the first frame of the dock is the ask.
    expect(body.indexOf("setForwardGate")).toBeLessThan(body.indexOf("setReplyTo"));
  });

  it("the inline forward never touches the compose form — no seed, no release, no navigation", () => {
    // Its predecessor seeded the form and therefore had to release the autosave first; the
    // inline forward's whole point is that the compose surface is not involved. Any of these
    // reappearing inside `openForward` is the navigation defect growing back.
    const fn = /const openForward = useStableCallback\(([\s\S]*?)\n  \}\);/.exec(shell);
    const body = fn![1]!;
    expect(body).not.toContain("setCompose");
    expect(body).not.toContain("writeComposeDraft");
    expect(body).not.toContain("autosave");
    expect(body).not.toContain('go("compose")');
  });

  it("seeds no recipients — the forward's envelope opens EMPTY, never the original's sender", () => {
    // The shell's one envelope writer seeds `{ to: "", cc: "", bcc: "" }` for forward mode
    // (the reset effect), and the wire's audience comes from `forwardEnvelopePlan`, whose
    // untouched arm is the refusable empty set (`forward-send.test.ts` pins the plan itself).
    expect(shell).toMatch(/replyMode === "forward" \? \{ to: "", cc: "", bcc: "" \} : null/);
    expect(shell).toContain("forwardEnvelopePlan(replyEnvelope");
  });
});

describe("the compose surface says what a forward will actually send", () => {
  const view = stripComments(readSource("app/views/ComposeView.tsx"));

  it("renders the forwarding note when, and only when, there is a forward", () => {
    // The body is empty and the quote is added server-side, so without this line the form shows a
    // message that looks blank and the user cannot tell the original is coming with it.
    expect(view).toMatch(/fields\.forwardOf \?/);
    expect(view).toContain("forwardingNote");
  });

  it("the note's copy key exists — a `t()` on a missing key renders the key itself", () => {
    const messages = JSON.parse(readSource("messages/en.json")) as {
      compose: Record<string, string>;
    };
    expect(typeof messages.compose.forwardingNote).toBe("string");
    // The refusal sentence is gone with the refusal: a no_forward forward asks instead.
    expect(messages.compose.forwardRefused).toBeUndefined();
  });

  /**
   * ── AND THE INLINE EDITOR'S PLACEHOLDER FOLLOWS THE MODE ────────────────────────────────
   *
   * `InlineReply` serves both verbs and had ONE placeholder key, so a forward — which contains no
   * reply and whose head says "Forward — you pick who receives it" — invited the author to "Write
   * your reply…". It was reported from a driven walk, which is the only place it could be seen:
   * nothing typechecks a placeholder and the file's own suite renders the reply mode.
   *
   * Read from the SOURCE, comments stripped, for this file's stated reason — the prose here quotes
   * the code it describes, and an assertion a comment can satisfy is worthless. The mode branch is
   * the thing that regressed (one key serving two modes), so the branch is what is pinned.
   */
  it("the inline forward's placeholder is not the reply's", () => {
    const inline = stripComments(readSource("app/shell/InlineReply.tsx"));
    expect(inline).toMatch(
      /placeholder=\{mode === "forward" \? t\("forwardPlaceholder"\) : t\("placeholder"\)\}/,
    );
    for (const cat of ["messages/en.json", "messages/de.json"]) {
      const messages = JSON.parse(readSource(cat)) as { reply: Record<string, string> };
      expect(typeof messages.reply.forwardPlaceholder, `${cat} has no reply.forwardPlaceholder`)
        .toBe("string");
      // The two must actually DIFFER, or the branch is decoration in both languages.
      expect(messages.reply.forwardPlaceholder, `${cat} forwards with the reply's words`)
        .not.toBe(messages.reply.placeholder);
    }
  });

  /**
   * AND ITS SCREEN-READER TWIN, asserted on the SAME branch and in its own case.
   *
   * A field's placeholder and its accessible name are one label wearing two coats: fixing the
   * placeholder alone left a sighted reader seeing "Write your message…" on a forward while a
   * screen reader heard "Reply body" for the same field — the half-applied pair, in the direction
   * that is hardest to notice, because nothing on screen shows it.
   *
   * The Reply Run's overlay in `AppShell` deliberately keeps `reply.editorAria` and is NOT part of
   * this rule: that surface steps through replies and never forwards, so a mode branch there would
   * be a condition whose other arm is unreachable.
   */
  it("the inline forward's accessible name is not the reply's either", () => {
    const inline = stripComments(readSource("app/shell/InlineReply.tsx"));
    expect(inline).toMatch(
      /ariaLabel=\{mode === "forward" \? t\("forwardEditorAria"\) : t\("editorAria"\)\}/,
    );
    for (const cat of ["messages/en.json", "messages/de.json"]) {
      const messages = JSON.parse(readSource(cat)) as { reply: Record<string, string> };
      expect(typeof messages.reply.forwardEditorAria, `${cat} has no reply.forwardEditorAria`)
        .toBe("string");
      expect(messages.reply.forwardEditorAria, `${cat} names the forward's field a reply`)
        .not.toBe(messages.reply.editorAria);
    }
  });

  it("the attach control it mounts is styled — the class names exist in app.css", () => {
    // `ComposeAttach` shipped with five class names and no stylesheet, which renders as an
    // unstyled file list at the foot of the panel. Each of these is one rule in `app.css`.
    const css = readSource("app/app.css");
    for (const cls of [
      "compose-attach", "compose-attach-row", "compose-attach-cap", "compose-attach-list",
      "compose-attach-item", "compose-attach-name", "compose-attach-size",
      "compose-attach-remove", "compose-attach-error", "compose-forwarding",
    ]) {
      expect(css, `.${cls} has no rule in app.css`).toContain(`.${cls} {`);
    }
  });
});
