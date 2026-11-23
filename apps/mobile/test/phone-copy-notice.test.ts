import { expect, it } from "vitest";
import { refuse } from "../src/refusal";
import * as toasts from "../src/state/toast-one";

it("keeps the mailbox-full notice for a pending Sent copy and preserves a stated retry limit", () => {
  const sent = refuse("toastSentAndDone");
  expect(toasts.quotaNoticeOf(refuse("sentCopyWaiting", "full", sent))).toEqual({ until: null });
  expect(toasts.quotaNoticeOf(refuse("sentCopyWaitingUntil", "full", sent, "Friday 14:00")))
    .toEqual({ until: "Friday 14:00" });
  expect(toasts.quotaNoticeOf(refuse("sentCopyMissing", "full", sent))).toBeNull();
  expect(toasts.quotaNoticeOf(refuse("sentCopyWaiting", "unreachable", sent))).toBeNull();
  expect(toasts.quotaNoticeOf(sent)).toBeNull();
});
