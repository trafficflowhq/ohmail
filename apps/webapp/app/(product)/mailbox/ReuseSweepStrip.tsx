"use client";

import { ReuseSweepNotice } from "../../shell/ReuseSweepNotice";
import { useReuseSweepFeed } from "./reuse-sweep-feed";

/** The sweeps' strip, drawn from the feed (`reuse-sweep-feed.ts`). */
export function ReuseSweepStrip() {
  const { sweeps, acknowledge, recheck } = useReuseSweepFeed();
  if (sweeps === null) return null;
  return <ReuseSweepNotice sweeps={sweeps} onAcknowledge={acknowledge} onRecheck={recheck} />;
}
