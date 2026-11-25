import { cookies, headers } from "next/headers";
import { SELF_HOST_BUILD } from "../../self-host-marketing";
import { resolveInternalApiOrigin } from "../../api-origin";
import { ApproveClosed } from "./ApproveClosed";
import { ApproveRoute } from "./ApproveRoute";
import { isApprovalId, isApprovalLaunch } from "./approval-return";
import type { SearchParamsLike } from "../../demo-mode";

const firstValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

/** Verify a self-host phone launch on this deployment before offering any browser sign-in. */
async function launchStatus(approvalId: string, launch: string): Promise<number> {
  const api = resolveInternalApiOrigin(process.env.OHMAIL_INTERNAL_API_ORIGIN);
  if (api === null) return 404;
  try {
    const host = (await headers()).get("host");
    if (!host) return 404;
    const url = new URL(`https://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return 404;
    const result = await fetch(`${api}/auth/desktop-approval/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId, launch, origin: url.origin }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    return result.status;
  } catch {
    return 404;
  }
}

export default async function ApprovePage(props: { searchParams?: Promise<SearchParamsLike> }) {
  const searchParams = await props.searchParams;
  const id = firstValue(searchParams?.request)?.trim().toLowerCase() ?? "";
  if (!isApprovalId(id)) return SELF_HOST_BUILD ? <ApproveClosed /> : <ApproveRoute />;
  if (SELF_HOST_BUILD) {
    const launch = (await cookies()).get("ohmail_approval_launch")?.value;
    if (!isApprovalLaunch(launch)) return <ApproveClosed />;
    const status = await launchStatus(id, launch);
    if (status === 204) return <ApproveRoute request={id} phone />;
    return <ApproveClosed expired={status === 410} />;
  }
  return <ApproveRoute request={id} phone={firstValue(searchParams?.device) === "phone"} />;
}
