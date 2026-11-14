"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useEngine, useResolvedDemoMode, useDerivedVersion } from "@ohmail/app-logic/engine";
import { longDateStamp } from "@ohmail/app-logic/text/format";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { useFrame } from "../frame/index.js";
import { StageNoticeInReview, StageNoticeOffer } from "../frame/FeatureNotices.js";
import { NONE } from "../host/index.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { settingsDoorbell, type ProfileImportState } from "./model.js";
import { ProfileImportCard } from "./ProfileImportCard.js";
import { useProfileImport } from "./use-profile-import.js";
import { useSavedProfileActions, type SavedProfileActions } from "./saved-profile-actions.js";

type ProfileGroundState = ProfileImportState & { readonly saved: SavedProfileActions };
const ProfileImport = createContext<ProfileGroundState | null>(null);

/** The account owns the offer even when another place is showing. Its Ohbox or the owed review draws it. */
export function ProfileImportGround({ children }: { readonly children: ReactNode }) {
  const { host } = useFrame();
  const engine = useEngine();
  useDerivedVersion();
  const { mailboxes } = useMailState();
  const demo = useResolvedDemoMode();
  const wire = host.wires.profileImport;
  const active = !demo && host.session.state !== "refused" && wire !== NONE;
  const state = useProfileImport(
    active,
    mailboxes,
    wire === NONE ? null : wire,
    undefined,
    settingsDoorbell(engine.read()),
    engine,
  );
  const saved = useSavedProfileActions(active ? wire : null, engine);
  const current = active ? { ...state, saved } : null;
  return (
    <StageNoticeOffer.Provider value={current?.offer == null ? null : <ProfileOffer />}>
      <ProfileImport.Provider value={current}>{children}</ProfileImport.Provider>
    </StageNoticeOffer.Provider>
  );
}

export function useProfileImportState(): ProfileGroundState | null {
  return useContext(ProfileImport);
}

export function MailboxProfileOffer() {
  const inReview = useContext(StageNoticeInReview);
  const offer = useContext(StageNoticeOffer);
  return inReview ? null : offer;
}

function ProfileOffer() {
  const state = useProfileImportState();
  const profile = useText("profileImport");
  const mailbox = useText("mailboxes");
  const locale = useLocale();
  const timeZone = useTimeZone();
  if (!state?.offer) return null;
  return (
    <ProfileImportCard
      offer={state.offer}
      phase={state.phase}
      onImport={state.importNow}
      onNotNow={state.notNow}
      onAcknowledge={state.acknowledge}
      words={{
        profile,
        mailbox,
        locale,
        longDate: (date) => longDateStamp(date, timeZone, locale),
      }}
    />
  );
}
