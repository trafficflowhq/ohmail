import { ApproveScreen } from "./ApproveScreen";
import { isApprovalId } from "./approval-return";
import type { SearchParamsLike } from "../../demo-mode";

/**
 * `/approve?request=<id>` — the browser half of the one-confirm desktop sign-in. One parameter,
 * a request id (the engine's row uuid) and never a credential: it is worth nothing without this
 * browser's signed-in, step-up-cleared confirm AND the verifier the desktop kept. Shape-checked
 * and dropped otherwise; repeated values take the FIRST.
 */
export default async function ApprovePage({ searchParams }: { searchParams?: SearchParamsLike }) {
  const raw = searchParams?.request;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const id = typeof first === "string" ? first.trim() : "";
  return <ApproveScreen request={isApprovalId(id) ? id.toLowerCase() : ""} />;
}
