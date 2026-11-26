/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_KEY, EMPTY_COMPOSE, clearComposeDraft, composeDraftKey, composeRowKey, composeSessionId,
  composeSessionKey, composeStillHolds, handOffComposer, readComposeDraft, readComposeRow,
  resetComposerForTest, setComposerScope, writeComposeDraft, writeComposeRow,
} from "@ohmail/app-logic/writing/compose";

/**
 * CROSS-TAB-COMPOSE-IDENTITY-CLEARED-BY-ANOTHER-TAB. The scratch buffer, the compose session and
 * the draft row were keyed per ACCOUNT, so every tab on the origin held one message-in-progress
 * and a tab settling its own cleared the one another tab was writing. They are keyed per composer
 * now. Two tabs share `localStorage` and keep their own `sessionStorage`; a case switches tabs by
 * giving the page a composer id, exactly the state a second tab starts in.
 */
const tab = (id: string): void => {
  resetComposerForTest();
  window.sessionStorage.setItem(COMPOSER_KEY, id);
};
const slotKeys = ["ohmail.ui.compose.local", "ohmail.compose.session.local", "ohmail.compose.row.local"];
const message = (subject: string) => ({ ...EMPTY_COMPOSE, to: "ana@example.com", subject, body: `${subject} body` });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetComposerForTest();
});

describe("each tab's composer owns its own message-in-progress", () => {
  it("CONTROL: two tabs build different keys for all three halves", () => {
    tab("tab-a");
    const a = [composeDraftKey(null), composeSessionKey(null), composeRowKey(null)];
    tab("tab-b");
    const b = [composeDraftKey(null), composeSessionKey(null), composeRowKey(null)];
    a.forEach((k, i) => expect(k).not.toBe(b[i]));
  });

  it("one tab clearing its message leaves the other tab's text, session and row standing", () => {
    tab("tab-a");
    writeComposeDraft(message("from A"), null);
    const sessionA = composeSessionId(null);
    writeComposeRow("row-a", null);
    tab("tab-b");
    writeComposeDraft(message("from B"), null);
    const sessionB = composeSessionId(null);
    writeComposeRow("row-b", null);
    expect(sessionB).not.toBe(sessionA);

    tab("tab-a");
    clearComposeDraft(null);
    expect(readComposeDraft(null)).toEqual(EMPTY_COMPOSE);

    tab("tab-b");
    expect(readComposeDraft(null).subject).toBe("from B");
    expect(composeSessionId(null), "B's session survived A's clear").toBe(sessionB);
    expect(readComposeRow(null), "B's row survived A's clear").toBe("row-b");
    expect(composeStillHolds({ draftId: "row-b", session: sessionB }, null)).toBe(true);
    expect(composeStillHolds({ draftId: null, session: sessionB }, null)).toBe(true);
  });

  it("a tab that closes hands its message to the next composer, as one unit", () => {
    tab("tab-a");
    writeComposeDraft(message("unsent"), null);
    const session = composeSessionId(null);
    writeComposeRow("row-a", null);
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    expect(window.localStorage.getItem(composeDraftKey(null)), "nothing left under the closed tab").toBeNull();

    tab("tab-c");
    expect(readComposeDraft(null).subject).toBe("unsent");
    expect(composeSessionId(null)).toBe(session);
    expect(readComposeRow(null)).toBe("row-a");
    for (const k of slotKeys) expect(window.localStorage.getItem(k), `${k} still waiting`).toBeNull();
  });

  it("a page kept for back/forward keeps its message where it is", () => {
    tab("tab-a");
    writeComposeDraft(message("kept"), null);
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(readComposeDraft(null).subject).toBe("kept");
    for (const k of slotKeys) expect(window.localStorage.getItem(k)).toBeNull();
  });

  it("a composer already holding a message leaves a handed-off one for the next", () => {
    tab("tab-b");
    writeComposeDraft(message("B's own"), null);
    tab("tab-a");
    writeComposeDraft(message("A's"), null);
    composeSessionId(null);
    handOffComposer();
    tab("tab-b");
    expect(readComposeDraft(null).subject).toBe("B's own");
    tab("tab-c");
    expect(readComposeDraft(null).subject, "A's message still waits").toBe("A's");
  });

  it("a new handoff keeps the older draft and its row separate from the new text", () => {
    window.localStorage.setItem("ohmail.ui.compose.local", JSON.stringify(message("older")));
    window.localStorage.setItem("ohmail.compose.session.local", "older-session");
    window.localStorage.setItem("ohmail.compose.row.local", "older-row");
    tab("tab-b");
    writeComposeRow(null, null);
    writeComposeDraft(message("newer"), null);
    // B read nothing yet, so it adopted nothing; its own unit is text and a session, no row.
    const sessionB = window.localStorage.getItem(composeSessionKey(null)) ?? composeSessionId(null);
    handOffComposer();
    tab("tab-b");
    expect(readComposeDraft(null).subject).toBe("newer");
    expect(composeSessionId(null)).toBe(sessionB);
    expect(readComposeRow(null)).toBeNull();

    tab("tab-c");
    expect(readComposeDraft(null).subject).toBe("older");
    expect(composeSessionId(null)).toBe("older-session");
    expect(readComposeRow(null)).toBe("older-row");
  });

  it("a window the host names keeps its message across a restart that fired no pagehide", () => {
    setComposerScope("window");
    writeComposeDraft(message("before the quit"), null);
    const session = composeSessionId(null);
    // A restart: a fresh page, sessionStorage gone, nothing handed off.
    resetComposerForTest();
    window.sessionStorage.clear();
    setComposerScope("window");
    expect(readComposeDraft(null).subject).toBe("before the quit");
    expect(composeSessionId(null)).toBe(session);
    for (const k of slotKeys) expect(window.localStorage.getItem(k)).toBeNull();
  });

  it("a browser upgraded mid-message keeps it: the per-account keys are adopted by the first composer", () => {
    window.localStorage.setItem("ohmail.ui.compose.local", JSON.stringify(message("before the upgrade")));
    window.localStorage.setItem("ohmail.compose.session.local", "session-before");
    window.localStorage.setItem("ohmail.compose.row.local", "row-before");
    tab("tab-a");
    expect(readComposeDraft(null).subject).toBe("before the upgrade");
    expect(composeSessionId(null)).toBe("session-before");
    expect(readComposeRow(null)).toBe("row-before");
  });
});
