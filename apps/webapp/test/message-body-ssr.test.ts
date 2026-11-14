/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBody, sanitizerAvailable } from "../app/letter-body/MessageBody.js";
import { OWNER_BILLING_HTML, OWNER_BILLING_TEXT, OWNER_TRACKING_PIXEL } from "./fixtures/owner-billing-email";

/**
 * ── WHAT HAPPENS WHEN THERE IS NO DOM, WHICH IS EVERY SERVER RENDER ─────────────────────
 *
 * `MessageBody` is a `"use client"` component, and Next still EXECUTES those on the server
 * for the first paint. DOMPurify has no parser there — `DOMPurify.isSupported` is `false` —
 * and its documented behaviour in that state is the dangerous one: `sanitize()` returns its
 * INPUT UNCHANGED. So "no DOM" is not an edge case, it is a path on which a naive
 * implementation emits raw sender-authored html into server-rendered markup, on the app's
 * own origin, with no frame and no CSP around it.
 *
 * This file is `@vitest-environment node` rather than jsdom for exactly that reason: it is
 * the only environment in which the branch can be observed at all. It also removes the need
 * for a throwaway Next route to prove the component server-renders without throwing.
 */

describe("the server render, where there is no sanitizer", () => {
  it("has no DOM — so the branch under test is the one that actually runs", () => {
    // The premise, asserted rather than assumed. If a future setup file installs a global
    // `window`, this goes red and every assertion below becomes vacuous — which is the
    // failure mode a premise-free version of this file would hide.
    expect(typeof globalThis.window).toBe("undefined");
    expect(sanitizerAvailable()).toBe(false);
  });

  it("renders the text part and NEVER the html", () => {
    // THE GUARD. Mutation: return the html anyway on the unsupported branch —
    // `<div dangerouslySetInnerHTML={{ __html: html }} />` in place of the `BodyText`
    // fallback. Real failure text with that mutation:
    //   AssertionError: expected '<div class="msg-body"><div><p class="…' not to contain
    //   'url8792.mail.wolkenmail.example/wf/open'
    const out = renderToStaticMarkup(
      React.createElement(MessageBody, {
        text: OWNER_BILLING_TEXT,
        html: OWNER_BILLING_HTML,
      }),
    );
    // Not one byte of the sender's MARKUP.
    expect(out).not.toContain("<style");
    expect(out).not.toContain("<table");
    expect(out).not.toContain("<img");
    // NOTHING IS FETCHED. Position, not substring — and the distinction is the reported
    // complaint showing through: the text alternative CONTAINS the beacon's url as prose
    // (`[url8792.mail.wolkenmail.example/wf/open?upn=…]` was the last line they pasted), and
    // `BodyText` linkifies it. A link is not a fetch, so that is honest rather than a leak —
    // but a blanket "the url does not appear" assertion would be false here for a correct
    // implementation, and someone would weaken it. This one cannot be.
    expect(out).not.toMatch(
      /(?:\bsrc\s*=\s*["']?|\bsrcset\s*=\s*["']?|\bbackground\s*=\s*["']?|url\(\s*["']?)https?:\/\//i,
    );
    expect(out).not.toContain(`src="${OWNER_TRACKING_PIXEL}"`);
    // The words the reader can have, plus a line saying which rendition this is.
    expect(out).toContain("Your organization has reached its usage credits spend limit");
    expect(out).toContain("Showing the plain-text version of this message.");
    // No frame either: an empty `srcdoc` frame server-rendered and then replaced on hydration
    // is a flash of nothing where the message should be.
    expect(out).not.toContain("<iframe");
  });

  it("does not throw for a message with no html at all", () => {
    const out = renderToStaticMarkup(
      React.createElement(MessageBody, { text: "First.\n\nSecond.", html: null }),
    );
    expect(out).toContain('class="msg-p msg-plain"');
    expect(out).not.toContain("Showing the plain-text version");
  });
});
