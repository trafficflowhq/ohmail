/**
 * THE SEND LINE'S WORDS: every sentence key the shell's send line can answer, each read here by a literal key of
 * this screen's namespace. A key with no row says the plain sentence that nothing was sent, never that it was.
 */
import type { Text } from "../../text/index.js";
import type { WriteBeside } from "../ports.js";

export function statusWords(t: Text, key: string, beside: Pick<WriteBeside, "sendLineValues">): string {
  switch (key) {
    case "statusPreviousSending":
      return t("status.previousSending");
    case "statusSending":
      return t("status.sending");
    case "statusSendingLong":
      return t("status.sendingLong");
    case "statusQueued":
      return t("status.queued");
    case "statusUnverified":
      return t("status.unverified");
    case "statusFailed":
      return t("status.failed");
    case "statusMailboxDisabled":
      return t("status.mailboxDisabled");
    case "statusUnreachable":
      return t("status.unreachable");
    case "statusBusy":
      return t("status.busy");
    case "statusNotSecured":
      return t("status.notSecured");
    case "statusLoginRefused":
      return t("status.loginRefused");
    case "statusNotSignedIn":
      return t("status.notSignedIn");
    case "statusForwardOriginalUnavailable":
      return t("status.forwardOriginalUnavailable");
    case "statusForwardPartsUnsupported":
      return t("status.forwardPartsUnsupported");
    case "statusForwardPartsChanged":
      return t("status.forwardPartsChanged");
    case "statusAttachmentMismatch":
      return t("status.attachmentMismatch");
    case "statusForwardSourceMoved":
      return t("status.forwardSourceMoved");
    case "statusTimeout":
      return t("status.timeout");
    case "statusTooLong":
      return t("status.tooLong", beside.sendLineValues());
    case "statusTooLarge":
      return t("status.tooLarge");
    case "statusStagingRefused":
      return t("status.stagingRefused");
    case "statusDraftChanged":
      return t("status.draftChanged");
    case "statusNotSavedFirst":
      return t("status.notSavedFirst");
    case "statusDraftUnsaved":
      return t("status.draftUnsaved");
    case "statusDuplicate":
      return t("status.duplicate");
    case "statusDuplicateSent":
      return t("status.duplicateSent");
    case "statusDuplicateUnverified":
      return t("status.duplicateUnverified");
    case "statusDuplicatePending":
      return t("status.duplicatePending");
    default:
      return t("status.unknown");
  }
}
