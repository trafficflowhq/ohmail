/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  COMPOSER_KEY,
  EMPTY_COMPOSE,
  composeDraftKey,
  composeRowKey,
  composeSessionId,
  handOffComposer,
  readComposeDraft,
  readComposeRow,
  resetComposerForTest,
  writeComposeDraft,
  writeComposeRow,
} from "@ohmail/app-logic/writing/compose";

const account = "invented-owner";
function startTab(id: string): void {
  resetComposerForTest();
  window.sessionStorage.setItem(COMPOSER_KEY, id);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetComposerForTest();
});
afterEach(() => vi.restoreAllMocks());

it("keeps both unsynced drafts when two tabs close before a new tab opens", () => {
  const first = "Notes for the garden";
  const second = "Notes for the kitchen";
  startTab("first");
  readComposeDraft(account);
  writeComposeDraft({ ...EMPTY_COMPOSE, body: first }, account);
  startTab("second");
  readComposeDraft(account);
  writeComposeDraft({ ...EMPTY_COMPOSE, body: second }, account);

  startTab("first");
  expect(readComposeDraft(account).body).toBe(first);
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  startTab("second");
  expect(readComposeDraft(account).body).toBe(second);
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));

  const recovered: string[] = [];
  for (const tab of ["reopened-one", "reopened-two", "reopened-three"]) {
    startTab(tab);
    recovered.push(readComposeDraft(account).body);
  }
  expect(recovered.sort()).toEqual(["", first, second]);
});

it("keeps the original scratch buffer if its close-time copy cannot be written", () => {
  const body = "The only copy of these notes";
  startTab("first");
  writeComposeDraft({ ...EMPTY_COMPOSE, body }, account);
  const original = composeDraftKey(account);
  expect(readComposeDraft(account).body).toBe(body);
  const save = Storage.prototype.setItem;
  const denied = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key.startsWith("ohmail.ui.compose.") && key !== original) {
      throw new DOMException("Fixture quota exhausted", "QuotaExceededError");
    }
    return save.call(this, key, value);
  });

  handOffComposer();
  expect.soft(denied).toHaveBeenCalled();
  const kept = JSON.parse(window.localStorage.getItem(original) ?? "null");
  expect(kept?.body).toBe(body);
});

it("keeps a handed-off draft intact when a new composer cannot accept its row", () => {
  const body = "Notes before closing this tab";
  startTab("leaving");
  writeComposeDraft({ ...EMPTY_COMPOSE, body }, account);
  const session = composeSessionId(account);
  writeComposeRow("saved-row", account);
  handOffComposer();

  startTab("refused");
  const rowKey = composeRowKey(account);
  const save = Storage.prototype.setItem;
  const denied = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key === rowKey) throw new DOMException("Fixture quota exhausted", "QuotaExceededError");
    return save.call(this, key, value);
  });
  expect(readComposeDraft(account).body).toBe("");
  expect(readComposeRow(account)).toBeNull();
  expect(denied).toHaveBeenCalledWith(rowKey, "saved-row");
  denied.mockRestore();

  startTab("recovered");
  expect(readComposeDraft(account).body).toBe(body);
  expect(composeSessionId(account)).toBe(session);
  expect(readComposeRow(account)).toBe("saved-row");

  startTab("empty");
  expect(readComposeDraft(account).body).toBe("");
});
