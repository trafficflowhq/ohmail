import { NextResponse } from "next/server";
import { buildToken } from "../shell/app-update";

/**
 * Which build is this origin serving right now — one fact, for one reader: a tab that loaded weeks ago and wants to
 * know whether it is still the app this origin serves (`app/shell/build-watch.ts`). It answers a DIGEST, not the
 * commit: the comparison only needs "are two builds the same", which a digest answers while telling a stranger
 * nothing about this deployment's history; `buildToken` folds the release number in beside the commit so a deployment
 * whose sha is "dev" still changes its token on upgrade.
 */

/**
 * Both values are compile-time constants, which is the point: the value is baked into the build it describes, and a
 * request served by a new deployment is answered by that deployment's own copy — a runtime env read would keep
 * answering the old build's name. Not under `/api`: that path is proxied to the API deployment, and this is a fact
 * about the WEB deployment, so it lives at its own path and shadows nothing.
 */
export const runtime = "nodejs";
/* Never prerendered and never cached: a cached answer is the answer of the build that was
   serving when it was cached, which is precisely the build the reader is trying to notice has
   been replaced. */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return NextResponse.json(
    { build: buildToken(process.env.NEXT_PUBLIC_APP_VERSION, process.env.NEXT_PUBLIC_BUILD) },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
