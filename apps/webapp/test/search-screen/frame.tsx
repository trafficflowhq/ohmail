import { useRef, useState, type ReactNode } from "react";
import type { LayoutPlan, Route } from "@ohmail/app/frame";
import type { OhmailEngine } from "@ohmail/client-engine";
import { FrameContext, type FrameInner, type SearchPosition } from "../../../../packages/app/src/frame/commands";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";

export function SearchFrame({ engine, plan, route, children }: {
  engine: OhmailEngine;
  plan: LayoutPlan;
  route: Route;
  children: ReactNode;
}) {
  const [host] = useState(() => fakeHost({ engine, service: "self", scope: "acct-1" }).host);
  const searchPosition = useRef<SearchPosition | null>(null);
  const frame = { api: { host, route, plan }, searchPosition } as FrameInner;
  return <FrameContext.Provider value={frame}>{children}</FrameContext.Provider>;
}
