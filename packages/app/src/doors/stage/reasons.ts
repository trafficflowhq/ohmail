/**
 * Why a browser holds no usable sign-in, as the refresh door named it, and the `resume` sentence each reason is said
 * with: the signed-out page says it as its line, the sign-in page as why it is showing.
 */
export type SignedOutReason = "revoked" | "reused" | "expired" | "absent" | "pending";

export const REASON_SAID: Readonly<Record<SignedOutReason, string>> = {
  revoked: "revokedBody",
  reused: "reusedBody",
  expired: "expiredBody",
  absent: "absentBody",
  pending: "pendingBody",
};
