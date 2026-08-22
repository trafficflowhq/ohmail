/**
 * The OPEN billing seam: the entitlements service (all state, all transactions), the
 * `BillingPlanePort` the Stripe machinery is reached through, and the `EntitlementEvent` v1
 * wire contract between the two. Nothing under this directory may import `stripe`, even
 * type-only — the plane repo re-declares the DTO structurally, and a type dependency in either
 * direction is the link the AGPL boundary forbids.
 */
export {
  ENTITLEMENT_EVENT_VERSION, RECONCILIATION_EVENT_TYPE,
  type EntitlementEvent, type EntitlementPlan, type ReconcilePageDTO,
  type CheckoutLinkDTO, type SubscriptionDTO, type SubscriptionItemDTO,
  type InvoiceDTO, type InvoiceLineDTO, type RevenueReversalDTO,
} from "./entitlement-event.js";
export {
  type BillingPlanePort, type PlaneCheckoutRequest, type WebhookVerdict,
} from "./plane-port.js";
export {
  makeBillingPlaneClient, PLANE_CALL_TIMEOUT_MS,
  type BillingPlaneClientConfig, type PlaneFetch,
} from "./plane-client.js";
export {
  reconcileBillingMirror, recordReconcileFailure,
  RECONCILE_MAX_PAGES, RECONCILE_TEST_ROW_PREFIX, RECONCILE_RUN_RETENTION_MS,
  type ReconcileCode, type ReconcileDivergence, type ReconcileReport, type ReconcileOptions,
} from "./reconcile.js";
export {
  makeEntitlementsService, BillingApplyError, GRACE_MS, ERASURE_CANCEL_TIMEOUT_MS,
  type EntitlementsService, type EntitlementsServiceConfig,
  type BillingAlert, type BillingAlertSink,
  type SubscriptionStatusDTO, type WebhookResult, type ErasureBillingOutcome,
} from "./entitlements-service.js";
