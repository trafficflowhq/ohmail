/**
 * WHAT A SHELL'S FEATURES HAVE TO SAY in the one notice slot. For each entry that says something, one part calls its
 * `notice()` in render (so it may use hooks) and posts the list under the entry's own feed; an entry that goes
 * takes its notices with it.
 */
import { useEffect } from "react";
import { FEATURE_NAMES, NONE, type FeatureEntry, type HostFeatures } from "../host/index.js";
import type { NoticeStore } from "./notice-store.js";

function EntryNotices({
  entry,
  notices,
}: {
  entry: FeatureEntry & { notice: NonNullable<FeatureEntry["notice"]> };
  notices: NoticeStore;
}) {
  const said = entry.notice();
  const feed = `feature:${entry.name}`;
  useEffect(() => notices.post(feed, said));
  useEffect(() => () => notices.post(feed, []), [notices, feed]);
  return null;
}

export function FeatureNotices({ features, notices }: { features: HostFeatures; notices: NoticeStore }) {
  return (
    <>
      {FEATURE_NAMES.map((name) => {
        const entry = features[name];
        if (entry === NONE || entry.notice === undefined) return null;
        return (
          <EntryNotices
            key={name}
            entry={entry as FeatureEntry & { notice: NonNullable<FeatureEntry["notice"]> }}
            notices={notices}
          />
        );
      })}
    </>
  );
}
