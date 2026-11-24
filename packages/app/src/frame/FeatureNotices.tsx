/**
 * WHAT A SHELL'S FEATURES HAVE TO SAY in the one notice slot. For each entry that says something, one part calls its
 * `notice()` in render (so it may use hooks) and posts the list under the entry's own feed; an entry that goes
 * takes its notices with it.
 */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { NONE } from "../host/contract.js";
import { FEATURE_NAMES, type FeatureEntry, type FeatureName, type HostFeatures } from "../host/features.js";
import type { NoticeStore } from "./notice-store.js";

/** The ground's pending question takes the host's optional stage notice's place. */
export const StageNoticeOffer = createContext<ReactNode>(null);
/** The Ohbox yields the offer while the owed review shows it. */
export const StageNoticeInReview = createContext(false);
const featureFeed = (name: FeatureName) => `feature:${name}`;
export const STAGE_NOTICE_FEED = featureFeed("stageCard");

function EntryNotices({
  entry,
  notices,
}: {
  entry: FeatureEntry & { notice: NonNullable<FeatureEntry["notice"]> };
  notices: NoticeStore;
}) {
  const said = entry.notice();
  const offer = useContext(StageNoticeOffer);
  const feed = featureFeed(entry.name);
  useEffect(() => notices.post(feed, offer !== null && entry.name === "stageCard" ? [] : said));
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
