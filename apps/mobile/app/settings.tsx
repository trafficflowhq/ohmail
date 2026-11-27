/** The native Settings menu and the controls each section opens. Server pairing has its own route. */
import settingsEn from "@ohmail/app/settings/labels.en.json";
import settingsDe from "@ohmail/app/settings/labels.de.json";
import { mailboxCheckedAt, statusKey } from "@ohmail/app-logic/mailboxes/pane/rows";
import Constants from "expo-constants";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform, View } from "react-native";
import { buildCommit, buildLabel } from "../src/build-info";
import { Copy } from "../src/copy";
import { refuse, sayRefusal, type Refusal } from "../src/refusal";
import { wakeSentence } from "../src/ui/wake-sentence";
import { useWake } from "../src/state/wake";
import {
  accountGovernsFace,
  accountWideOffered,
  useTheme,
  type FaceName,
  type ThemePref,
} from "../src/theme";
import { MailAppearance, mailSize } from "../src/theme/mail";
import { usePrefs } from "../src/state/store";
import { useWorld } from "../src/state/world";
import { firstPassWithholds } from "../src/state/seed-offer";
import { connectionSaid, firstSyncSaid, readerZone } from "../src/state/live";
import { Button, Chip, Panel, Rule, Screen, Scroller, Section, Tap, TapRow, Txt, ViewHead } from "../src/ui/base";
import { HeadingEnd } from "../src/ui/HeadingEnd";
import { Icon } from "../src/ui/Icon";
import { MailAvatar } from "../src/ui/MailAvatar";
import { SettingsLookPreview } from "../src/ui/SettingsLookPreview";
import { Sheet, SheetRow } from "../src/ui/Sheet";
import { Nav } from "../src/ui/MoreNav";
import { AccountDevices } from "../src/ui/AccountDevices";
import { Field } from "../src/ui/Field";
import { SenderNamePanel } from "../src/ui/SenderNamePanel";
import { SignaturesPanel } from "../src/ui/SignaturesPanel";
import { useConnection } from "../src/net/connection";
import { accessFeedFor, onAccessFeed } from "../src/net/account";
import { accountDevicesOrigin } from "../src/net/devices";
import { storageLevelOf, storageRowValue, usedPercent } from "../src/ui/storage-notice";
import { aboutLinks } from "../src/ui/about-links";
import { changeServerSettings, checkMailbox, resupplyPassword, selfChecksThisSession, type PhoneMailbox } from "../src/net/mailboxes";
import { backupExclusion, subscribeBackupExclusion } from "../src/engine/backup-exclusion";
import { phoneEngineStart } from "../src/engine/engine-artifact";
import {
  onOrganizerState, organizeRefusal, organizerHandedBack, organizerInstruction,
  organizerHandBackLateSaid, organizerNotificationsOffSaid, organizerRestrictedSaid, organizerSettingsLeft,
  organizerStateVersion,
  pressOrganizeHere, standaloneHereFor, standaloneServerSettings,
} from "../src/engine/organizer-session";
import { openNotificationSettings } from "../src/engine/notification-permission-native";
import { NotifyPermission } from "../src/ui/NotifyPermission";
import { useNotifyPermission } from "../src/ui/useNotifyPermission";
import { CLAIM_LAPSES_AFTER_MINUTES, standaloneAvailable } from "../src/engine/standalone-door";
import {
  claimChipLabel,
  claimFrom,
  claimHere,
  claimHolderOf,
  claimNoteLine,
  type PhoneClaim,
  maySignInAgain,
  connectionLineHere,
  signInAgainSaid,
  mayStartHere,
  mayStopHere,
  portFieldSaid,
  pressSaidLine,
  pressSaidOf,
  refusalField,
  serverChangeOf,
  serverFieldsFrom,
  serverSettingsRefusal,
  setImapPort,
  setImapTls,
  setTyped,
  settingsLeftLine,
  type PressSaid,
  type ServerField,
  type StandaloneFields,
} from "../src/ui/standalone-form";
import { useLocale, useLocaleControls } from "../src/i18n/LocaleProvider";
import { activeLocale } from "../src/i18n/locale";
import { DetailBar, PaneTop } from "../src/ui/chrome";
import { MailCalendarSwitch } from "../src/ui/MailCalendarSwitch";
import { MailPlaceDock } from "../src/ui/MailPlaceDock";
import { aiSummary, AwaySettingsEntry, mailboxSummary, screenerSummary, SettingsEntry, SettingsGroup, signatureSummary } from "../src/ui/SettingsMenu";
import { UnsavedChanges } from "../src/ui/UnsavedChanges";
import { usePosture } from "../src/ui/posture";
import { scaffoldPlan } from "../src/ui/scaffold/plan";
import { YieldToMore } from "../src/ui/more-move";
import { useMorePick } from "../src/ui/more-pane";
import { Gated } from "../src/ui/Gated";
import { Segmented } from "../src/ui/Segmented";
import { AutoActPanel, readsOnly } from "../src/ui/AutoActPanel";
import { AutoFiledPanel } from "../src/ui/AutoFiledPanel";
import { ImpersonationFilingPanel } from "../src/ui/ImpersonationFilingPanel";
import { IMAGE_QUALITY_LEVELS, type ImageQualityLevel } from "../src/compose/attach";

/** The dial's four names, read at render so they follow the app's language. */
function pictureQualityLabel(level: ImageQualityLevel): string {
  switch (level) {
    case "low": return Copy.pictureQualityLow;
    case "medium": return Copy.pictureQualityMedium;
    case "high": return Copy.pictureQualityHigh;
    case "original": return Copy.pictureQualityOriginal;
  }
}
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { SavedSettingsPanel } from "../src/ui/ProfileImportCard";
import { SeedReopenPanel } from "../src/ui/SeedOfferCard";
import { writePhoneDiagnostics } from "../src/engine/diagnostics";
import { nativePhoneDiagnosticDeps, shareDiagnosticFile } from "../src/engine/diagnostics-native";
import { diagnosticSaid, type DiagnosticPress } from "../src/ui/diagnostic-said";
import { phoneSupportMail } from "../src/ui/help-contact";
import { selfCheckRowSaid, type SelfCheckPress } from "../src/ui/self-check-said";
import { WaitingStrip } from "../src/ui/WaitingStrip";
import { FilingStrip } from "../src/ui/FilingStrip";
import { FilingsBlocks } from "../src/ui/FilingsBlock";
import { filingsWaiting } from "../src/ui/filing-lines";
import { setTimeLabel } from "../src/state/live";
import { lateWho, mailboxIssue, notCheckedNoteSaid } from "../src/ui/late-lines";

/** Gated like the tabs: the About block states a live session's facts, so it needs one. */
export default function SettingsScreen({ inPane = false, pane }: { inPane?: boolean; pane?: string }) {
  const params = useLocalSearchParams<{ pane?: string; mailbox?: string; returnTo?: "settings" | "mailboxes" }>();
  const mailbox = inPane ? undefined : params.mailbox;
  const section = inPane ? pane : mailbox ? "mailboxes" : params.pane;
  const paneKey = inPane || mailbox ? null : section ? `settings:${section}` : "settings";
  return (
    <SurfaceBoundary surface="settings">
      <Gated>
        <YieldToMore paneKey={paneKey}>
          <MailAppearance>
            <SettingsBody inPane={inPane} section={section} mailbox={mailbox} returnTo={params.returnTo} />
          </MailAppearance>
        </YieldToMore>
      </Gated>
    </SurfaceBoundary>
  );
}

/** An unset override follows the device. The control shows the resulting language. */
function LanguagePanel() {
  const controls = useLocaleControls();
  const [failed, setFailed] = useState(false);
  if (controls === null) return null;
  return (
    <Panel level="l0" style={generalSheetStyle}>
      <View style={generalLineStyle}>
        <Txt variant="bodyMedium">{Copy.language}</Txt>
        <Segmented settings fill={false} accessibilityLabel={Copy.language} value={controls.locale}
          style={{ marginLeft: "auto" }}
          disabled={controls.busy}
          onChange={(next) => {
            if (controls.busy || next === controls.locale) return;
            setFailed(false);
            void controls.setLocale(next).catch(() => { setFailed(true); });
          }}
          segments={controls.locales.map((value) => ({
            value, label: value === "en" ? Copy.languageEnglish : Copy.languageGerman,
          }))}
        />
      </View>
      {failed ? <Txt variant="caption" tone="ink2" accessibilityLiveRegion="polite">{Copy.languageFailed}</Txt> : null}
    </Panel>
  );
}

const generalSheetStyle = { padding: mailSize.edge + mailSize.rowInset, marginBottom: mailSize.edge, gap: mailSize.inset };
const generalLineStyle = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: mailSize.inset } as const;

function SettingsBody({ inPane, section, mailbox, returnTo }: {
  inPane: boolean; section?: string; mailbox?: string; returnTo?: "settings" | "mailboxes";
}) {
  /* Subscribed: this is the screen the switch is made ON, so it is the screen that must redraw
     under the finger rather than on the next navigation. */
  const locale = useLocale();
  const catalog = locale === "de" ? settingsDe : settingsEn;
  const words = catalog.settings;
  const theme = useTheme();
  const posture = usePosture();
  const w = useWorld();
  const conn = useConnection();
  /* The live session the "Filed automatically" panel reads through; none, no panel. */
  const session = conn.state.k === "live" ? conn.state.session : null;
  const mailboxEntry = useRef<{ id: string; session: typeof session } | null>(null);
  if (mailbox && session && mailboxEntry.current?.id !== mailbox) mailboxEntry.current = { id: mailbox, session };
  const mailboxIsGone = mailbox !== undefined && (
    (mailboxEntry.current?.id === mailbox && mailboxEntry.current.session !== session) ||
    (w.mailboxes.known && !w.mailboxes.rows.some((row) => row.id === mailbox))
  );
  const openedMailbox = mailboxIsGone ? undefined : mailbox;
  const profileId = session && !session.standalone ? session.profile.id : null;
  const accessOfProfile = useCallback(() => (profileId ? accessFeedFor(profileId) : null), [profileId]);
  const access = useSyncExternalStore(onAccessFeed, accessOfProfile, accessOfProfile)?.answer;
  const { themePref, setTheme, facePin, pinLook, pictureQuality, setPictureQuality } = usePrefs();
  const wake = useWake();
  const notificationsOff = useSyncExternalStore(onOrganizerState, organizerNotificationsOffSaid, organizerNotificationsOffSaid);
  /*
   * The build's own name, read once. `expoConfig` is the config `expo prebuild` embedded in this
   * artifact — the same source `android/app/build.gradle` and `Info.plist` are generated from,
   * held equal to them by `build-info.test.ts`. The narrowing (and why an absent version renders
   * NOTHING rather than "unknown") is `buildLabel`'s; this line only hands it the platform.
   */
  const version = buildLabel(
    {
      version: Constants.expoConfig?.version,
      androidVersionCode: Constants.expoConfig?.android?.versionCode,
      iosBuildNumber: Constants.expoConfig?.ios?.buildNumber,
    },
    Platform.OS,
  );
  /*
   * WHICH BUILD, not which release. `EXPO_PUBLIC_COMMIT` is read as a literal `process.env`
   * member because that is the only spelling Expo inlines at bundle time — a computed key reads
   * `undefined` on the phone, where there is no environment to look in. Baked by the android
   * workflow from the commit it built; `dev` on anything else. The narrowing is `buildCommit`'s.
   */
  const commit = buildCommit(process.env.EXPO_PUBLIC_COMMIT);
  /* What the mirror's open measured about this device's backup — the About block's last line
     comes from it, so the claim and the reading cannot drift apart. */
  const backupSays = useSyncExternalStore(subscribeBackupExclusion, backupExclusion, backupExclusion);
  /* In More's pane the away responder opens in the same pane. */
  const pick = useMorePick();
  const links = aboutLinks(session);
  const linkRow = (link: (typeof links)[number]) => (
    <Nav key={link.url} label={link.label} sub={link.sub} chevron
      onPress={() => { void Linking.openURL(link.url).catch(() => undefined); }}
    />
  );
  const accountLink = links.find((link) => link.label === Copy.deleteAccountRow);
  const openServers = () => (pick ? pick("servers") : router.push("/servers"));
  const mailboxRoster = !w.standalone && !inPane && openedMailbox === undefined;
  const panes = {
    general: {
      label: Copy.settingsGeneral,
      content: <>
        <LanguagePanel />
        <Panel level="l0" style={generalSheetStyle}>
          <View style={{ minHeight: mailSize.action, justifyContent: "center" }}>
            <Txt variant="bodyMedium" accessibilityRole="header">{Copy.settingsAppearance}</Txt>
          </View>
          <View style={generalLineStyle}>
            <Txt variant="bodyMedium">{Copy.settingsTheme}</Txt>
            <Segmented<ThemePref> settings fill={false}
              accessibilityLabel={Copy.settingsTheme}
              accessibilityHint={Copy.themeNote}
              style={{ marginLeft: "auto" }}
              value={themePref}
              onChange={setTheme}
              segments={[
                { value: "light", label: Copy.themeLight },
                { value: "system", label: Copy.themeAuto },
                { value: "dark", label: Copy.themeDark },
              ]}
            />
          </View>
          <FacePanel
            key={w.worldKey}
            pin={facePin}
            account={w.face.account}
            accountKnown={w.face.known}
            pending={w.face.pending}
            setPin={pinLook}
            applyAll={w.face.applyAll}
            standalone={w.standalone}
          />
        </Panel>
        <Panel level="l0" style={generalSheetStyle}>
          <Txt variant="bodyMedium" accessibilityRole="header">{Copy.settingsMessages}</Txt>
          <Txt variant="bodyMedium">{Copy.pictureQuality}</Txt>
          <Segmented<ImageQualityLevel> settings fill={false}
            accessibilityLabel={Copy.pictureQuality}
            accessibilityHint={Copy.pictureQualityNote}
            value={pictureQuality}
            onChange={setPictureQuality}
            segments={IMAGE_QUALITY_LEVELS.map((level) => ({ value: level, label: pictureQualityLabel(level) }))}
          />
        </Panel>
      </>,
    },
    notifications: {
      label: Copy.settingsNotifications,
      content: (
        <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.wake}</Txt>
            <Txt variant="note" tone="ink2">{wakeSentence(wake.state, Platform.OS)}</Txt>
          </View>

          {wake.choices.length > 0 && (
            <View style={{ marginTop: 14 }}>
              <Section>{Copy.wakeDistributor}</Section>
              <View style={{ paddingHorizontal: 12, gap: 2 }}>
                {wake.choices.map((d) => (
                  <TapRow
                    key={d.id}
                    selected={d.id === wake.chosen}
                    disabled={wake.busy}
                    onPress={() => { wake.choose(d.id); }}
                    style={{ paddingHorizontal: 8, paddingVertical: 12 }}
                  >
                    <Txt variant="body">{d.name}</Txt>
                  </TapRow>
                ))}
                <Rule inset={8} />
                <TapRow
                  selected={wake.chosen === null}
                  disabled={wake.busy}
                  onPress={() => { wake.turnOff(); }}
                  style={{ paddingHorizontal: 8, paddingVertical: 12 }}
                >
                  <Txt variant="body" tone="ink2">{Copy.wakeDistributorNone}</Txt>
                </TapRow>
              </View>
              <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
                {/* THE HINT IS A CLAIM, so it is withheld when the sentence above contradicts it.
                    "Turning this off … removes the registration from your server" is exactly what
                    `row_remains` says did NOT happen, and the two were rendered together: the same
                    screen asserting a take-back and its failure. The state's own sentence stands
                    alone in that case. */}
                <Txt variant="caption" tone="ink3">
                  {wake.state.k === "off" && wake.state.reason === "row_remains"
                    ? ""
                    : wake.chosen === null ? Copy.wakeDistributorNoneHint : Copy.wakeDistributorHint}
                </Txt>
              </View>
            </View>
          )}
        </Panel>

      ),
    },
    mailboxes: {
      label: Copy.settingsMailboxes,
      content: <>
        {mailboxRoster ? <MailboxRoster /> : <ThisPhonePanel mailbox={openedMailbox} />}
        {openedMailbox ? <FilingsBlocks key={w.worldKey} mailboxId={openedMailbox} /> : <>
          <SenderNamePanel />
          <WaitingStrip />
          <FilingStrip />
          <FilingsBlocks key={w.worldKey} />
          <SavedSettingsPanel />
          <SeedReopenPanel />
        </>}

      </>,
    },
    screener: {
      label: Copy.screener,
      content: <>
        {/* WHAT THE SCREENER FILED ON ITS OWN, with Put back — beside the other automatic act.
            The phone has no auto-apply switch of its own; the panel reads the same route pair. */}
        {/* FILE IMPERSONATIONS TO SPAM — on by default; the switch every device agrees on. */}
        {session !== null ? <ImpersonationFilingPanel session={session} /> : null}
        {session !== null ? <AutoFiledPanel session={session} /> : null}

      </>,
    },
    ai: {
      label: Copy.settingsAi,
      content: w.autoAct ? (
        <AutoActPanel
          on={w.autoAct.on}
          suggestOn={w.autoAct.suggestOn}
          reader={readsOnly(w.mailboxes.known, w.mailboxes.rows)}
          pending={w.autoAct.pending}
          set={w.autoAct.set}
        />
      ) : null,
    },
    devices: {
      label: Copy.settingsDevices,
      content: <Panel>
        {session && accountDevicesOrigin(session) ? <AccountDevices key={session.ownerKey} session={session} /> : null}
        <Nav label={Copy.serversTitle} icon="phone" chevron onPress={openServers} />
      </Panel>,
    },
    folders: {
      label: Copy.settingsFolders,
      content: w.folders.storable ? (
        <FoldersPanel
          on={w.folders.enabled}
          pending={w.folders.pending}
          setEnabled={w.folders.setEnabled}
        />
      ) : null,
    },
    signatures: { label: Copy.settingsSignatures, content: <SignaturesPanel /> },
    account: {
      label: words.account,
      content: accountLink ? <Panel>{linkRow(accountLink)}</Panel> : null,
    },
    about: {
      label: Copy.settingsAbout,
      content: <>
        <Panel style={{ paddingVertical: 18, marginBottom: 10 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.about}</Txt>
            {/* WHICH build. The block was headed "About this build" and named no version, so a
                tester holding a sideloaded APK could not say which one they had. The numbers are
                the embedded app config's, which `build-info.test.ts` holds equal to the package
                manifest's. `null` only where there is no version to state — see `buildLabel`. */}
            {version !== null ? (
              <Txt variant="note" tone="ink2">
                {version}
              </Txt>
            ) : null}
            {/* And WHICH BUILD of that version. Its own line rather than appended: the value is
                forty characters, and a rig reads it off a screenshot. Always rendered — a build
                with nothing baked in says `dev`, which is the answer, not a missing one. */}
            <Txt variant="note" tone="ink3">
              {Copy.buildCommit(commit)}
            </Txt>
            <Txt variant="note" tone="ink2">
              {w.standalone ? Copy.aboutLiveHere : Copy.aboutLive(w.account.name)}
            </Txt>
            {/* What leaving actually leaves. The backup half is a SECOND line, derived from what
                the mirror's open measured rather than written per platform: subscribed, because
                the reading settles after the first open and a body-time read would freeze
                whatever was true at the last paint. See `src/engine/backup-exclusion.ts`. */}
            <Txt variant="note" tone="ink3">
              {Copy.aboutOnDevice}
            </Txt>
            <Txt variant="note" tone="ink3">
              {Copy.aboutOnDeviceBackup(backupSays)}
            </Txt>
          </View>
          <DiagnosticPanel />
        </Panel>
        <Panel>{links.filter((link) => link !== accountLink).map(linkRow)}</Panel>
      </>,
    },
    help: {
      label: Copy.settingsHelp,
      content: <Panel>
          {/* HELP & CONTACT: the phone's own composer to support, or the mail app where nothing here can send. */}
          <Nav
            label={Copy.helpRow}
            sub={Copy.helpRowSub}
            chevron
            onPress={() => {
              const mail = phoneSupportMail(
                {
                  mailboxes: w.mailboxes.all,
                  accountId: conn.state.k === "live" && !w.standalone ? conn.state.session.profile.accountId : null,
                },
                { platform: { os: Platform.OS, osVersion: Platform.Version ?? null }, build: { version: Constants.expoConfig?.version ?? null, commit } },
              );
              if (w.mailboxes.sendingId !== null) router.push({ pathname: "/compose", params: { mailto: mail.mailto, diag: mail.diag } });
              else void Linking.openURL(mail.mailto).catch(() => undefined);
            }}
          />
      </Panel>,
    },
  };

  const selected = Object.entries(panes).find(([id, pane]) => id === section && pane.content !== null)?.[1];
  const open = (id: keyof typeof panes) => {
    if (pick) pick(`settings:${id}`);
    else router.push({ pathname: "/settings", params: { pane: id, returnTo: "settings" } });
  };
  const backToRoster = openedMailbox && returnTo === "mailboxes"
    ? () => router.dismissTo({ pathname: "/settings", params: { pane: "mailboxes", returnTo: "settings" } })
    : undefined;
  const backToMenu = selected && !openedMailbox
    ? inPane && pick ? () => pick("settings")
    : !inPane && returnTo !== "settings" ? () => router.replace("/settings") : undefined
    : undefined;
  const title = selected?.label ?? Copy.settings;
  const attention = notificationsOff && (!selected || section === "notifications");
  const phoneMenu = theme.mail && !inPane && !selected &&
    scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android").nav === "dock";
  const format = new Intl.NumberFormat(locale).format;
  const face = theme.face === "ohmarchy" ? words.faceOhmarchy : words.facePaper;
  const mode = { system: words.themeAuto, light: words.themeLight, dark: words.themeDark }[themePref];
  const storage = access?.metered ? access.storage : undefined;
  const storageLevel = storage ? storageLevelOf(storage) : null;
  const screenerSettled = w.boot.settled &&
    !firstPassWithholds(w.screener.waiting.length, w.mailboxes, Date.now(), standaloneHereFor(w));
  const openAway = () => {
    if (pick) pick("away");
    else router.push("/away");
  };
  const menu = selected ? null : (
    <>
      <SettingsGroup label={words.groupMail} hot={notificationsOff}>
        <SettingsEntry label={panes.general.label} icon="settings"
          summary={{ value: `${face} · ${mode}`, detail: words.languageName[locale] }}
          onPress={() => open("general")} />
        <SettingsEntry label={panes.notifications.label} icon="bell"
          summary={{ value: wake.state.k === "on" ? Copy.switchOn : Copy.switchOff }}
          onPress={() => open("notifications")} />
        <SettingsEntry label={panes.mailboxes.label} icon="mail"
          summary={mailboxSummary(w.mailboxes, access?.mailboxLimit, format)} onPress={() => open("mailboxes")} />
        {session ? <SettingsEntry label={panes.screener.label} icon="screener"
          summary={screenerSummary(w.screener, screenerSettled, format)} onPress={() => open("screener")} /> : null}
        {panes.ai.content ? <SettingsEntry label={panes.ai.label} icon="spark"
          summary={aiSummary(access?.aiCredits, format)} onPress={() => open("ai")} /> : null}
        {session ? (
          session.standalone
            ? <SettingsEntry label={Copy.awayRow} icon="reply" onPress={openAway} />
            : <AwaySettingsEntry session={session} locale={locale} onPress={openAway} />
        ) : null}
        {panes.folders.content ? <SettingsEntry label={panes.folders.label} icon="folder"
          summary={{ value: w.folders.enabled ? Copy.switchOn : Copy.switchOff }} onPress={() => open("folders")} /> : null}
        <SettingsEntry label={panes.signatures.label} icon="pen"
          summary={signatureSummary(w.mailboxes, w.signatures, format)} onPress={() => open("signatures")} />
      </SettingsGroup>
      <SettingsGroup label={words.groupAccount}>
        <SettingsEntry label={panes.devices.label} icon="phone" onPress={() => open("devices")} />
        {storage ? <SettingsEntry label={Copy.storageTitle} icon="disk" summary={{
          value: storageLevel === "full" ? Copy.storageStateFull : Copy.storagePercent(usedPercent(storage)),
          detail: storageRowValue(storage, Copy, locale),
          hot: storageLevel !== null,
        }} onPress={() => router.push("/storage")} /> : null}
        {accountLink ? <SettingsEntry label={panes.account.label} icon="key" onPress={() => open("account")} /> : null}
      </SettingsGroup>
      <SettingsGroup label={words.groupAbout}>
        <SettingsEntry label={panes.about.label} icon="info"
          summary={version ? { value: version } : null} onPress={() => open("about")} />
        <SettingsEntry label={panes.help.label} icon="send"
          summary={{ detail: `${catalog.help.write} · ${catalog.help.diag}` }} onPress={() => open("help")} />
      </SettingsGroup>
    </>
  );

  if (phoneMenu) {
    return (
      <MailPlaceDock>
        <Screen>
          <PaneTop />
          <UnsavedChanges />
          <ViewHead title={title} attention={attention} leading={<MailCalendarSwitch />} aboveSheet />
          <Panel level="l0" style={{ flex: 1, overflow: "hidden", borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
            <Scroller avoidKeyboard contentStyle={{ paddingLeft: 0, paddingRight: 0 }}>{menu}</Scroller>
          </Panel>
        </Screen>
      </MailPlaceDock>
    );
  }

  return (
    <Screen>
      {inPane && !backToMenu ? <PaneTop /> : (
        <DetailBar backCapsule back={backToRoster ?? backToMenu}
          backLabel={backToRoster ? Copy.settingsMailboxes : selected && !openedMailbox ? Copy.settings : undefined} />
      )}
      <Scroller key={selected?.label ?? "menu"} bounded avoidKeyboard>
        <View style={{ paddingHorizontal: selected ? 0 : mailSize.edge, minHeight: mailSize.bar,
          paddingTop: mailSize.inset, alignItems: "baseline", flexDirection: "row", gap: mailSize.inset }}>
          <Txt variant="h1" accessibilityRole="header" accessibilityLabel={title}>
            <HeadingEnd variant="h1" hot={attention}>{title}</HeadingEnd>
          </Txt>
          {selected && section === "mailboxes" && mailboxRoster && w.mailboxes.known ? (
            <Txt variant="meta" tone="ink2" tabular>{format(w.mailboxes.rows.length)}</Txt>
          ) : null}
        </View>
        {selected ? selected.content : <Panel>{menu}</Panel>}
      </Scroller>
    </Screen>
  );
}

function MailboxRoster() {
  const theme = useTheme();
  const locale = useLocale();
  const w = useWorld();
  const connection = useConnection();
  const from = lateWho(connection.state.k === "live" ? connection.state.session : null);
  const now = new Date();
  const zone = readerZone();
  const format = new Intl.NumberFormat(locale).format;
  return (
    <View style={{ gap: mailSize.inset + mailSize.rowInset, marginBottom: mailSize.edge }}>
      {w.mailboxes.rows.map((row) => {
        const label = row.displayName || row.address;
        const last = mailboxCheckedAt(row);
        const late = notCheckedNoteSaid(row, +now, zone, locale, from);
        const status = mailboxRosterStatus(row);
        const line = [status, last ? Copy.settingsMailboxSynced(setTimeLabel(last, now, zone, locale)) : null]
          .filter(Boolean).join(" · ");
        const messages = row.messageCount === undefined ? undefined : Copy.settingsMailboxMessages(row.messageCount, format(row.messageCount));
        const owner = from === "cloud" ? Copy.doorCloud : from === "server" ? Copy.settingsMailboxServer : undefined;
        return (
          <Panel key={row.id} level="l0">
            <TapRow accessibilityRole="button" accessibilityLabel={label}
              accessibilityHint={[line, messages, owner, late].filter(Boolean).join(" · ")}
              onPress={() => router.push({ pathname: "/settings", params: { mailbox: row.id, returnTo: "mailboxes" } })}
              style={{ flexDirection: "row", alignItems: "center", gap: mailSize.menuRowInset,
                minHeight: mailSize.row + mailSize.inset, paddingVertical: mailSize.inset, paddingHorizontal: generalSheetStyle.padding }}>
              <MailAvatar person={{ name: label, address: row.address }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Txt variant="bodyMedium" numberOfLines={1}>{label}</Txt>
                {line ? <Txt variant="meta" tone="ink2" numberOfLines={1}>{line}</Txt> : null}
                {messages ? <Txt variant="meta" tone="ink2">{messages}</Txt> : null}
                {owner ? <Txt variant="meta" tone="ink2">{owner}</Txt> : null}
                {late ? <Txt variant="meta" tone="ink2">{late}</Txt> : null}
              </View>
              <Icon name="chev" size={13} color={theme.c.ink2} />
            </TapRow>
          </Panel>
        );
      })}
    </View>
  );
}

function mailboxRosterStatus(row: PhoneMailbox): string | undefined {
  if (row.syncBlockedReason === "mailbox_full") return Copy.settingsMenuFull;
  const issue = mailboxIssue(row);
  if (issue) return issue.words;
  if (row.status !== "connected" || (row.lastSyncAt === undefined && row.hostedLastSyncAt === undefined)) return undefined;
  return statusKey({ ...row, status: row.status }) === "status_connecting"
    ? Copy.settingsMenuConnecting
    : Copy.settingsMenuConnected;
}

/**
 * SETTINGS → ABOUT → DIAGNOSTIC FILE. One press writes one file beside the mirror (under the same
 * backup exclusion) and the row then says where it is and that nothing was sent; the share sheet
 * is offered for that file and is the person's own act. The sentence is `diagnosticSaid`'s.
 */
function DiagnosticPanel() {
  const w = useWorld();
  const connection = useConnection();
  const [press, setPress] = useState<DiagnosticPress>({ k: "rest" });
  const said = diagnosticSaid(press);
  const write = useCallback(async () => {
    setPress({ k: "busy" });
    try {
      const engine = connection.state.k === "live" ? connection.state.session.engine : null;
      const where = await writePhoneDiagnostics(
        { reader: engine?.read() ?? null, mailboxes: w.mailboxes.all, selfChecks: selfChecksThisSession() },
        nativePhoneDiagnosticDeps(),
      );
      setPress(where === null ? { k: "failed" } : { k: "written", where });
    } catch {
      setPress({ k: "failed" });
    }
  }, [connection.state, w.mailboxes.all]);
  const share = useCallback(async (where: string) => {
    if (!(await shareDiagnosticFile(where))) setPress({ k: "share_failed", where });
  }, []);
  return (
    <View style={{ paddingHorizontal: 20, gap: 6, marginTop: 14 }}>
      <Txt variant="settingsLabel">{Copy.diagnosticLabel}</Txt>
      <Txt variant="note" tone="ink3">{said.sentence}</Txt>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
        <Button label={said.action} disabled={said.busy} onPress={() => { if (!said.busy) void write(); }} />
        {said.share !== null ? (
          <Button label={Copy.diagnosticShare} variant="quiet" onPress={() => { void share(said.share!); }} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * The face and its two scopes — the phone's half of OHMARCHY-PLAN.md §3a.
 * Signed in, the segmented control writes the account, as on the web and the
 * desktop (`face-scope.ts`'s `choose`); on the standalone door or with nothing
 * connected it is the device pin. The quiet line, "apply on all devices",
 * PATCHes the account (`{themeFace}` alone), adopts the echo and clears the pin. Apply-all is withheld, not disabled, when
 * nothing is connected, on the standalone door, or the face is not yet read ({@link World.face.known}):
 * pressing while unknown would PATCH paper over a real ohmarchy (the webapp
 * gates on `themeFaceKnown` too). A refused write leaves the real face shown.
 */
/**
 * Settings → This phone. One card per mailbox: address, claim-state chip, the
 * platform rule line, and — where there is a claim of ours to give up — the
 * hand-back. The MAILBOXES-COMPACT idiom in the phone's own primitives. It
 * renders only where this phone could organize, and only over a read:
 * `standaloneAvailable` is the build's answer, `known` the read's; a phone with
 * no engine has nothing to say, one that has not read yet says nothing about
 * who organizes (`world.mailboxes.known`) — both absences are silence. The five
 * chip states are the desktop's keys; the confirm lives in the sheet.
 */
/**
 * THE STANDALONE CARD'S ROW KEY — a constant, and deliberately NOT a mailbox id.
 *
 * The door answers for the one mailbox it serves and the app holds no id for it. This names
 * React's row; the stop it selects takes the engine's own release, which needs no id. It must
 * never reach a route, which is why it is not id-shaped.
 */
const HERE_CARD = "this-phone";

/** A decline this phone's own records state — only over the door in this process (see below). */
const declinedHere = (key: string): boolean =>
  key === HERE_CARD && (organizerRestrictedSaid() || organizerNotificationsOffSaid());

function ThisPhonePanel({ mailbox }: { mailbox?: string }) {
  const w = useWorld();
  const [confirming, setConfirming] = useState<string | null>(null);
  /* WHAT THE LAST PRESS ANSWERED. Its own state and not `organizeRefusal`, which is the LAUNCH
     press's record: a person pressing a verb here is owed an answer about the press they just made.
     ONE RECORD FOR BOTH VERBS, and it is spent by {@link pressSaidLine} against the claim: two
     booleans side by side could both stand over one card, and neither was cleared by anything but
     another press — so a stop the server refused and then honoured left its sentence under
     "Nothing organizes this mailbox" with the Start verb beside it (measured on a device). */
  const [said, setSaid] = useState<PressSaid>(null);
  /* THE RE-SUPPLY SHEET, its field, and what the last send answered — one record, cleared by the
     next press. The password lives here until the door answers and nowhere else: not in a log,
     not in a refusal, not in this app's store. */
  const [resupplying, setResupplying] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [sending, setSending] = useState(false);
  const [resupplySaid, setResupplySaid] = useState<{ ok: boolean; detail: string } | null>(null);
  /* THE SERVER SETTINGS SHEET: its fields (open while non-null) and what the last press said. The
     password lives in `fields` until the door answers, and leaves it either way. */
  const [servers, setServers] = useState<{ fields: StandaloneFields; hadSmtp: boolean } | null>(null);
  const [serverSaid, setServerSaid] = useState<
    { k: "kept" } | { k: "unreadable" } | { k: "refused"; reason: Refusal } | null
  >(null);
  const [serverSending, setServerSending] = useState(false);
  const [serverRevealed, setServerRevealed] = useState(false);
  /* CHECK THIS MAILBOX — what the last press answered; the door in this process only. */
  const [checkPress, setCheckPress] = useState<SelfCheckPress>({ k: "rest" });
  /* The live session, for the one request this panel makes — the door in this process on a
     standalone install, which is the only place the verb is offered. */
  const conn = useConnection();
  /**
   * The door's state, live — this panel was correct only at MOUNT. `standaloneHere()` was read in
   * the render and nothing re-rendered, so `Stopping` and `Organizing` stood for minutes over a
   * finished stop or a mailbox another machine held, settling only when Settings was re-entered.
   * `useSyncExternalStore` over the organizer session's own version counter — the mechanism
   * `world.tsx` uses for the mirror engine — fixes it. No state is copied: a notify means "ask
   * again", and the read below is the same door (`standaloneHereFor`), so there is one answer to whether
   * this phone organizes this mailbox.
   */
  useSyncExternalStore(
    useCallback((cb: () => void) => onOrganizerState(cb), []),
    organizerStateVersion,
    organizerStateVersion,
  );
  /* The ask and the system's own answer, both owned by the hook — this screen consumes them and
     holds no lifecycle of its own, the rule `useWake` is here under. */
  const notify = useNotifyPermission();

  if (!standaloneAvailable({ startEngine: phoneEngineStart() })) return null;

  /**
   * Where the cards come from, and why the door answers first. Deriving this
   * panel from `world.mailboxes` alone folded three outcomes (never asked,
   * refused, answered empty) into one `known: false`, so a phone that had opened
   * its own mailbox rendered nothing with an engine running behind it.
   * `standaloneHere()` is the engine in this process answering for itself, no
   * request; a paired session has no such door and keeps the roster as before.
   * The standalone card's key is a constant, not a mailbox id: it names React's
   * row; the engine's own release needs no id.
   */
  /* SCOPED TO THE ACCOUNT ON SCREEN: the engine outlives a switch, so under another account the
     phone's own mailbox is not this panel's card (`standaloneHereFor`). */
  const here = standaloneHereFor({ standalone: w.standalone });
  /* What each field of the server sheet wears: the press's refusal where it names that field, else
     the port rule the typed value already breaks. */
  const serverWears = (field: ServerField | "password"): { error: string } | Record<string, never> => {
    if (serverSaid?.k === "refused") {
      const on = refusalField(serverSaid.reason)
        ?? (serverSaid.reason.say === "standaloneSignInRefused" || serverSaid.reason.say === "serverSettingsNoPassword"
          ? "password" : null);
      if (on === field) return { error: sayRefusal(serverSaid.reason) };
    }
    const f = servers?.fields;
    const live = f === undefined ? null
      : field === "imapPort" ? portFieldSaid(f.imapPort, "imap")
        : field === "smtpPort" && f.smtpHost.trim() !== "" ? portFieldSaid(f.smtpPort, "smtp")
          : null;
    return live === null ? {} : { error: sayRefusal(live) };
  };
  const setServerField = (next: (f: StandaloneFields) => StandaloneFields): void => {
    setServers((cur) => (cur === null ? cur : { ...cur, fields: next(cur.fields) }));
  };
  /* Only where there is a door to have asked — a paired session's panel says nothing of it. */
  const consentRefusal = here === null ? null : organizeRefusal();
  /* THE SAME VERDICT AND THE SAME SENTENCE THE CHROME RENDERS, from the world rather than
     re-derived here: one ranking, so the top bar and this panel cannot disagree about whether
     the link is gone. */
  const outage = connectionSaid(w.boot.connection);
  /* AND WHAT THE FIRST SYNC PRODUCED — beside the link's sentence, never instead of it. The two
     are true at once and have different remedies: measured against a server that signs you in and
     refuses to hand over the mail, the link reads dead AND nothing has ever been read, and
     "Reconnecting…" on its own sends somebody to look at their network. Silent in every other
     state (`live.ts#firstSyncSaid`). */
  const unreadable = firstSyncSaid(w.boot.firstSync);
  /* Who checks the mailboxes behind this session, for a row whose server says it is not fetching. */
  const lateBy = lateWho(conn.state.k === "live" ? conn.state.session : null);
  const roster = mailbox
    ? w.mailboxes.rows.filter((row) => row.id === mailbox)
    : w.mailboxes.rows;
  if (mailbox && roster.length === 0) return null;
  const cards: readonly { key: string; address: string; claim: PhoneClaim; late?: string | null; error?: ReturnType<typeof mailboxIssue> }[] = here !== null
    ? [{
        key: HERE_CARD,
        address: here.address,
        /* ── AND THE STAND-DOWN IS SAID, WHICH IT WAS NOT ───────────────────────────────────
         *
         * This composed a `claimFrom` read, and `claimFrom` recognises our own claim BY NAME —
         * which every ohmail phone writes identically, so the OTHER phone's claim read as ours.
         * `claimHere` is the door's own state instead and compares no names; the engine's
         * `organizing` is this install's verdict on its own claim, which is the question the name
         * test was standing in for. See the function. */
        /* AND THE HAND-BACK, which no read of the engine can produce: a mailbox this install
           released and one nobody ever claimed answer the same three fields. Read live from the
           session on the same subscription as everything else above — `pokeOrganizerState`
           carries it, so the chip re-derives under an open panel rather than at re-entry. */
        claim: claimHere(here, organizerInstruction(), organizerHandedBack()),
      }]
    : roster.map((row) => ({
        key: row.id,
        address: row.address,
        /* NO NAME, AND NO HAND-BACK ON A PAIRED ROW. See {@link claimFrom}: every holder a paired
           roster can name is another install, so this card names it and offers no verb — and the
           ROLE is what says whether the server that answered organizes it itself, which this
           composed read did not carry and no holder can stand in for. */
        claim: claimFrom({
          known: w.mailboxes.known,
          role: row.organizerRole,
          serverHolds: row.organizedByThisInstall,
          parked: (row.organizerParkedAt ?? null) !== null,
          organizer: claimHolderOf(row),
        }),
        /* NEW MAIL IS LATE for this mailbox: the strip's sentence, for the row it is about. */
        late: notCheckedNoteSaid(row, Date.now(), readerZone(), activeLocale(), lateBy),
        error: mailboxIssue(row),
      }));
  if (cards.length === 0) return null;

  return (
    <>
      <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
        <Section>{Copy.phoneThisPhone}</Section>
        {cards.map((row, i) => {
          const claim = row.claim;
          const chip = claimChipLabel(claim);
          return (
            <View key={row.key}>
              {i > 0 ? <Rule inset={20} /> : null}
              <View style={{ paddingHorizontal: 20, paddingTop: 10, gap: 6 }}>
                <Txt variant="settingsLabel">{row.address}</Txt>
                {/* NO CHIP FOR `unknown`, rather than a chip that guesses — `claimChipLabel`
                    answers null there and this renders the absence. */}
                {chip === null ? null : (
                  <Chip style={{ alignSelf: "flex-start" }}>{chip}</Chip>
                )}
                {/* WHAT THIS PHONE DOES ABOUT THIS MAILBOX, IN THIS STATE. The platform rule was
                    rendered here for every state, including the one where another machine holds
                    the mailbox — where it is false. `claimNoteLine` follows the claim and keeps
                    the platform rule for the three states it is true of. */}
                {/* AND NOTHING WHERE THERE IS NOTHING TRUE TO SAY. The platform rule is a
                    statement about the BUILD, so under "Nothing organizes this mailbox" it was an
                    instruction about a notification that is not showing. `claimNoteLine` answers
                    null there and this renders the absence. */}
                {/* AND NOTHING OVER A DECLINE: under "Notifications are off" or battery saver the
                    rule ("while its notification is shown") is false, and the decline says why. */}
                {claimNoteLine(claim, Platform.OS, { declined: declinedHere(row.key) }) === null ? null : (
                  <Txt variant="note" tone="ink2">
                    {claimNoteLine(claim, Platform.OS, { declined: declinedHere(row.key) })}
                  </Txt>
                )}
                {/* THE SERVER IS NOT CHECKING THIS MAILBOX — calm, no alert and no press: nothing
                    here is the person's to do, and it leaves when the server says fetching runs. */}
                {row.late == null ? null : <Txt variant="note" tone="ink2">{row.late}</Txt>}
                {row.error ? (
                  <Txt variant="note">
                    {row.error.words}{row.error.since ? " · " + Copy.lateSince(
                      setTimeLabel(row.error.since, new Date(), readerZone(), activeLocale()),
                    ) : ""}
                  </Txt>
                ) : null}
                {/* THE CONNECTION, WHERE SOMEBODY ASKING "IS MY MAIL BEING FILED?" IS LOOKING.
                    The chip above answers who ORGANIZES the mailbox; this answers whether
                    anything can reach it. Both, because they are true at once: this phone is
                    still the organizer of a mailbox whose server it cannot dial, and a panel
                    that showed only the first read `Organizing` through a measured outage. */}
                {outage === null ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">
                    {row.key === HERE_CARD ? connectionLineHere(row.address, outage) : outage}
                  </Txt>
                )}
                {/* THE MAIL, NOT THE LINK — see `unreadable` above. */}
                {unreadable === null ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">{unreadable}</Txt>
                )}
                {/* MESSAGES SET ASIDE, below both verdicts and not an alert — see `live.ts#setAsideSaid`. */}
                {w.boot.setAside === null ? null : (
                  <Txt variant="note" tone="ink2">{w.boot.setAside}</Txt>
                )}
                {/* BATTERY SAVER, SAID WHERE THE PLATFORM RULE IS — and only once the background
                    half has actually met it. `organizerRestrictedSaid` is the record
                    `announceRestricted` writes; the deck's own note says this app organizes while
                    it is open instead, which contradicts the rule line above it, so it sits
                    directly under it rather than somewhere else on the screen. */}
                {/* AND THE SAME GATE, FOR THE SAME REASON — see the notifications note below.
                    "It organizes while the app is open, and hands the mailbox back when you
                    leave" is this phone's engine, and on a paired row nothing of the sort
                    happens: the fix that reaches one of a pair and not the other ships the
                    other. */}
                {organizerRestrictedSaid() && row.key === HERE_CARD ? (
                  <Txt variant="note" tone="ink2">{Copy.organizerRestricted}</Txt>
                ) : null}
                {/* A HAND-BACK THAT DID NOT LAND BEFORE THE FREEZE, said on this phone's card —
                    the other install could not take the mailbox meanwhile. */}
                {organizerHandBackLateSaid() && row.key === HERE_CARD ? (
                  <Txt variant="note" tone="ink2">
                    {Copy.organizerHandBackLate(CLAIM_LAPSES_AFTER_MINUTES)}
                  </Txt>
                ) : null}
                {/* AND THE OTHER CAUSE, WHICH IS NOT BATTERY SAVER. Both declines used to reach
                    the sentence above, which names battery saver — false on every Android 13+
                    first install, where `POST_NOTIFICATIONS` starts denied and the service
                    refuses to start behind a notification nobody can see. This one names what is
                    off and carries the only act left: Android never re-asks after a refusal. */}
                {/* ══ AND ONLY OVER THE DOOR IN THIS PROCESS ═══════════════════════════════════
                    "organizing runs only while the app is open" is a statement about THIS
                    phone's engine. Gated on the record alone it also rendered on every PAIRED
                    row, under a chip about a server that organizes whether or not the app is
                    open — a second false sentence beneath the first. One card can be this
                    phone's, and it is the one the start verb above is offered on. */}
                {organizerNotificationsOffSaid() && row.key === HERE_CARD ? (
                  <View style={{ gap: 2 }}>
                    <Txt variant="note" tone="ink2">{Copy.organizerNotificationsOff}</Txt>
                    <Button
                      label={Copy.organizerNotificationsSettings}
                      variant="quiet"
                      onPress={() => { void openNotificationSettings(); }}
                      style={{ alignSelf: "flex-start" }}
                    />
                  </View>
                ) : null}
                {/* WHAT THE CONSENT PRESS ANSWERED, where somebody asking "is my mail being
                    filed?" is already looking. It was written into `syncError` first, which the
                    Servers screen renders inside "Sync failed" — read on a device announcing a
                    sync failure for a mailbox whose sync had not failed. */}
                {consentRefusal === null ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">
                    {sayRefusal(consentRefusal)}
                  </Txt>
                )}
                {/* AND WHAT THE LAST PRESS SAID, beside the press that made it — for as long as
                    it is still true of the claim beside it, and not one render longer. */}
                {pressSaidLine(said, claim) === null || row.key !== HERE_CARD ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">
                    {pressSaidLine(said, claim)}
                  </Txt>
                )}
                {/* WHAT THE STOP LEFT OFF THE MAILBOX: this phone's decisions are on it only. */}
                {settingsLeftLine(organizerSettingsLeft(), claim) === null || row.key !== HERE_CARD ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">
                    {settingsLeftLine(organizerSettingsLeft(), claim)}
                  </Txt>
                )}
                {mayStopHere(claim) ? (
                  <Button
                    label={Copy.settingsStopHere}
                    variant="quiet"
                    onPress={() => setConfirming(row.key)}
                    style={{ alignSelf: "flex-start", marginTop: 4 }}
                  />
                ) : null}
                {/* ══ THE WAY BACK, AND ONLY ON THE DOOR IN THIS PROCESS ══════════════════════
                    A stop on this phone is REMEMBERED on the engine's own row, so nothing resumes
                    it by itself — which is the whole point, and which leaves a person needing a
                    verb. One press, no confirm sheet: nothing is given up and the stop above is
                    the reversal. Withheld on a PAIRED row, where this app holds no engine to ask
                    and the mailbox's organizer is another machine's business. */}
                {mayStartHere(claim) && row.key === HERE_CARD ? (
                  <Button
                    label={Copy.settingsStartHere}
                    variant="quiet"
                    onPress={() => {
                      /* THE PRESS DOES NOT WIPE THE ANSWER TO THE LAST ONE. `setSaid(null)` stood
                         here: the sentence explaining a refused stop was destroyed by the very
                         press somebody made to try again, and the second press then produced
                         nothing to replace it. A record is spent by `pressSaidLine` against the
                         CLAIM — which is a state change — and by this press's own answer below. */
                      /* THROUGH THE ONE DOOR, which reads the instruction in force: pressed during
                         a stop this is queued once and run when the stop completes, rather than
                         racing it. The engine's own verb underneath refuses a live foreign claim,
                         so it can never produce a second organizer. */
                      void pressOrganizeHere("start").then(async (outcome) => {
                        setSaid(pressSaidOf(outcome));
                        /* THE ASK, WHERE ORGANIZING ACTUALLY STARTED — the door's Connect runs the
                           same gate at the same moment. A refused start asks for nothing: a
                           permission spent on a press that achieved nothing is an ask this
                           install never gets back. */
                        if (outcome === "started") await notify.gate();
                      });
                    }}
                    style={{ alignSelf: "flex-start", marginTop: 4 }}
                  />
                ) : null}
                {/* ══ THE PASSWORD CHANGED AT THE PROVIDER ═══════════════════════════════════
                    In every state, because that is when it changes: the server starts refusing
                    a sync LATER. Until this verb existed the only way back was forgetting this
                    mailbox and opening it again, which takes its copy of the mail with it.
                    The door in THIS process only — a paired row's mailbox is another machine's
                    to re-open. */}
                {maySignInAgain(here) && row.key === HERE_CARD ? (
                  <Button
                    label={Copy.signInAgain}
                    variant="quiet"
                    onPress={() => {
                      setResupplySaid(null);
                      setNewPassword("");
                      setRevealed(false);
                      setResupplying(true);
                    }}
                    style={{ alignSelf: "flex-start", marginTop: 4 }}
                  />
                ) : null}
                {/* CHECK THIS MAILBOX — one read of the mail server against this phone's copy, and
                    one sentence back. The door in THIS process only: its engine holds the copy. */}
                {row.key === HERE_CARD && here !== null ? (() => {
                  const check = selfCheckRowSaid(checkPress, filingsWaiting(w.mailboxes.rows.find((m) => m.id === here.id)));
                  return (
                    <View style={{ gap: 2, marginTop: 4 }}>
                      <Button
                        label={check.action}
                        variant="quiet"
                        disabled={check.busy}
                        onPress={() => {
                          const at = conn.state.k === "live" ? conn.state.session : null;
                          const id = here.id ?? "";
                          if (check.busy || at === null || id === "") return;
                          setCheckPress({ k: "busy" });
                          void checkMailbox(at, id).then(
                            (answer) => setCheckPress({ k: "done", check: answer }),
                            () => setCheckPress({ k: "failed" }),
                          );
                        }}
                        style={{ alignSelf: "flex-start" }}
                      />
                      {check.sentence === null ? null : (
                        <Txt variant="note" tone="ink2" accessibilityRole="alert">{check.sentence}</Txt>
                      )}
                    </View>
                  );
                })() : null}
                {/* WHAT THE LAST SEND ANSWERED, beside the verb that made it. */}
                {resupplySaid === null || row.key !== HERE_CARD ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">
                    {resupplySaid.ok
                      ? Copy.signInAgainDone
                      : Copy.signInAgainFailed(resupplySaid.detail)}
                  </Txt>
                )}
                {/* THE SERVERS, EDITED IN PLACE — on the door in this process, beside Sign in again. */}
                {maySignInAgain(here) && row.key === HERE_CARD ? (
                  <Button
                    label={Copy.serverSettings}
                    variant="quiet"
                    onPress={() => {
                      setServerSaid(null);
                      setServerRevealed(false);
                      void standaloneServerSettings().then((at) => {
                        if (at === null) { setServerSaid({ k: "unreadable" }); return; }
                        setServers({ fields: serverFieldsFrom(at), hadSmtp: at.smtp !== null });
                      });
                    }}
                    style={{ alignSelf: "flex-start", marginTop: 4 }}
                  />
                ) : null}
                {servers !== null || serverSaid === null || serverSaid.k === "refused"
                  || row.key !== HERE_CARD ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">
                    {serverSaid.k === "kept" ? Copy.serverSettingsSaved : Copy.serverSettingsUnreadable}
                  </Txt>
                )}
              </View>
            </View>
          );
        })}
      </Panel>

      {/* THE CONSEQUENCE, THEN THE ONE DELIBERATE PRESS — the app's own destructive idiom
          (`FoldersGroup`'s delete confirm). The danger is on the confirm and nowhere else. */}
      {confirming !== null ? (
        <Sheet open onClose={() => setConfirming(null)} label={Copy.settingsStopHere} cancel="own">
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {Copy.settingsStopHereWhat}
          </Txt>
          <SheetRow
            icon="pause"
            label={Copy.settingsStopHereConfirm}
            onPress={() => {
              setConfirming(null);
              /* ══ THE STOP IS ONE INSTRUCTION, AND IT TAKES THE NOTIFICATION WITH IT ═══════
                 `pressOrganizeHere` records the release the ROW keeps — the ceremony a relaunch
                 reads — and drops the session behind it, in that order and as one act. Pressed
                 while a start is in flight it cancels that start rather than running beside it.
                 A release the mail server refused leaves this phone organizing, and the door says
                 `refused` rather than reporting the instruction as already in force — the chip
                 goes back to `Organizing` on its own and this is the sentence beside it.
                 There is one card this sheet can open over: `mayStopHere` answers true only for
                 `ours` and a `blocked` claim this install still holds, which only the door in this
                 process produces. */
              /* AND NOT `setSaid(null)` FIRST — see the start verb. The condition clears a
                 refusal, never a press. */
              void pressOrganizeHere("stop").then((outcome) => {
                setSaid(outcome === "refused" ? "stopRefused" : null);
              });
            }}
          />
          <SheetRow icon="x" label={Copy.settingsStopHereCancel} onPress={() => setConfirming(null)} />
        </Sheet>
      ) : null}

      {/* ONE FIELD, because one field is all this door needs: the server, the port and the
          username are in the credential this mailbox was proved against, and the engine merges
          them itself. It tries the password before it stores it, so a refusal leaves this phone
          exactly as it was — which is why the sheet stays open with the server's own words in it
          rather than closing on a send that changed nothing. */}
      {resupplying ? (
        <Sheet open onClose={() => setResupplying(false)} label={Copy.signInAgain} cancel="own" avoidKeyboard>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 4 }}>
            {signInAgainSaid(here?.address ?? "").lead}
          </Txt>
          <Field
            value={newPassword}
            onChange={setNewPassword}
            label={signInAgainSaid(here?.address ?? "").field}
            hint={Copy.signInAgainHint}
            secret
            revealLabels={{
              show: Copy.phoneStandaloneShowPassword, hide: Copy.phoneStandaloneHidePassword,
            }}
            revealed={revealed}
            onReveal={setRevealed}
            {...(resupplySaid !== null && !resupplySaid.ok
              ? { error: Copy.signInAgainFailed(resupplySaid.detail) }
              : {})}
            input={{ autoCapitalize: "none", autoCorrect: false, autoComplete: "off" }}
          />
          <SheetRow
            icon="check"
            label={sending ? Copy.signInAgainSaving : Copy.signInAgainSave}
            onPress={() => {
              const at = conn.state.k === "live" ? conn.state.session : null;
              const id = here?.id ?? "";
              if (sending || newPassword === "" || at === null || id === "") return;
              setSending(true);
              void resupplyPassword(at, id, newPassword).then((outcome) => {
                setSending(false);
                setResupplySaid(
                  outcome.kind === "sealed"
                    ? { ok: true, detail: "" }
                    : { ok: false, detail: outcome.detail },
                );
                /* THE SECRET LEAVES THIS SCREEN EITHER WAY, and the sheet closes only on the
                   answer that made it worth having: a refusal keeps the field so the sentence
                   beside it has something to be about. */
                setNewPassword("");
                if (outcome.kind === "sealed") setResupplying(false);
              });
            }}
          />
          <SheetRow
            icon="x"
            label={Copy.signInAgainCancel}
            onPress={() => { setNewPassword(""); setResupplying(false); }}
          />
        </Sheet>
      ) : null}

      {/* THE SERVER SETTINGS SHEET — the Connect form's server fields, prefilled from the engine,
          and the password the door tries them with before it keeps anything. A refusal keeps the
          sheet open with the sentence on the field it is about. */}
      {servers !== null ? (
        <Sheet open onClose={() => setServers(null)} label={Copy.serverSettings} cancel="own" avoidKeyboard>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 4 }}>
            {Copy.serverSettingsLead}
          </Txt>
          <Field
            value={servers.fields.imapHost}
            onChange={(v) => setServerField((f) => setTyped(f, "imapHost", v))}
            label={Copy.phoneStandaloneImapHost}
            {...serverWears("imapHost")}
            input={{ keyboardType: "url" }}
          />
          <Field
            value={servers.fields.imapPort}
            onChange={(v) => setServerField((f) => setImapPort(f, v))}
            label={Copy.phoneStandaloneImapPort}
            {...serverWears("imapPort")}
            input={{ inputMode: "numeric", keyboardType: "number-pad", selectTextOnFocus: true }}
          />
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Txt variant="sectionLabel" tone="ink3" style={{ paddingBottom: 4 }}>
              {Copy.phoneStandaloneImapTls}
            </Txt>
            <Segmented<"on" | "off">
              segments={[
                { value: "on", label: Copy.switchOn },
                { value: "off", label: Copy.switchOff },
              ]}
              value={servers.fields.imapTls ? "on" : "off"}
              onChange={(v) => setServerField((f) => setImapTls(f, v === "on"))}
            />
          </View>
          <Field
            value={servers.fields.smtpHost}
            onChange={(v) => setServerField((f) => setTyped(f, "smtpHost", v))}
            label={Copy.phoneStandaloneSmtpHost}
            {...serverWears("smtpHost")}
            input={{ keyboardType: "url" }}
          />
          <Field
            value={servers.fields.smtpPort}
            onChange={(v) => setServerField((f) => setTyped(f, "smtpPort", v))}
            label={Copy.phoneStandaloneSmtpPort}
            {...serverWears("smtpPort")}
            input={{ inputMode: "numeric", keyboardType: "number-pad", selectTextOnFocus: true }}
          />
          <Field
            value={servers.fields.password}
            onChange={(v) => setServerField((f) => ({ ...f, password: v }))}
            label={Copy.serverSettingsPassword}
            hint={Copy.serverSettingsPasswordHint}
            secret
            revealLabels={{
              show: Copy.phoneStandaloneShowPassword, hide: Copy.phoneStandaloneHidePassword,
            }}
            revealed={serverRevealed}
            onReveal={setServerRevealed}
            {...serverWears("password")}
            input={{ autoCapitalize: "none", autoCorrect: false, autoComplete: "off" }}
          />
          {/* A REFUSAL NO FIELD WEARS — the encryption answer, or the engine's own words. */}
          {serverSaid?.k === "refused" && refusalField(serverSaid.reason) === null
            && serverSaid.reason.say !== "standaloneSignInRefused"
            && serverSaid.reason.say !== "serverSettingsNoPassword" ? (
            <Txt variant="note" tone="ink2" accessibilityRole="alert" style={{ paddingHorizontal: 16, paddingTop: 10 }}>
              {sayRefusal(serverSaid.reason)}
            </Txt>
          ) : null}
          <SheetRow
            icon="check"
            label={serverSending ? Copy.serverSettingsSaving : Copy.serverSettingsSave}
            onPress={() => {
              const at = conn.state.k === "live" ? conn.state.session : null;
              const id = here?.id ?? "";
              if (serverSending || at === null || id === "") return;
              /* THE FIELDS' OWN RULES FIRST, so a port nobody can dial never reaches a server. */
              const early = serverSettingsRefusal(servers.fields, servers.hadSmtp)
                ?? (servers.fields.password === "" ? refuse("serverSettingsNoPassword") : null);
              if (early !== null) { setServerSaid({ k: "refused", reason: early }); return; }
              setServerSending(true);
              const change = { ...serverChangeOf(servers.fields), password: servers.fields.password };
              void changeServerSettings(at, id, change).then((outcome) => {
                setServerSending(false);
                /* THE SECRET LEAVES THE SHEET EITHER WAY; the sheet closes only on a kept change. */
                setServerField((f) => ({ ...f, password: "" }));
                if (outcome.kind === "kept") {
                  setServers(null);
                  setServerSaid({ k: "kept" });
                } else setServerSaid({ k: "refused", reason: outcome.reason });
              });
            }}
          />
          <SheetRow
            icon="x"
            label={Copy.serverSettingsCancel}
            onPress={() => { setServers(null); setServerSaid(null); }}
          />
        </Sheet>
      ) : null}

      <NotifyPermission open={notify.open} onAnswer={notify.answer} />
    </>
  );
}

function FacePanel({
  pin,
  account,
  accountKnown,
  pending,
  setPin,
  applyAll,
  standalone,
}: {
  pin: FaceName | null;
  account: FaceName | null;
  accountKnown: boolean;
  pending: boolean;
  setPin: (face: FaceName) => void;
  applyAll: (face: FaceName) => Promise<boolean>;
  /** A phone on its own keeps its look to itself (#421): nothing leaves it, so no "all devices". */
  standalone: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const theme = useTheme();
  const writing = useRef(false);
  const face: FaceName = pin ?? account ?? "paper";
  const governed = !standalone && accountKnown && accountGovernsFace(face, pin, account);
  const canApplyAll = !standalone && accountWideOffered(accountKnown, face, pin, account);
  const sayScope = governed ? Copy.faceScopeAll : Copy.faceScopeDevice;
  const apply = (next: FaceName) => {
    if (writing.current) return;
    writing.current = true;
    setFailed(false);
    void applyAll(next).then((ok) => { if (!ok) setFailed(true); })
      .finally(() => { writing.current = false; });
  };
  return (
    <>
      <Txt variant="bodyMedium">{Copy.face}</Txt>
      {governed || canApplyAll ? (
        <Segmented<"all" | "device"> settings fill={false} disabled={pending}
          accessibilityLabel={Copy.settingsLookScope} accessibilityHint={sayScope}
          value={governed ? "all" : "device"}
          onChange={(scope) => {
            if (pending || writing.current) return;
            if (scope === "all" && canApplyAll) apply(face);
            else if (scope === "device" && governed) {
              setFailed(false);
              setPin(face);
            }
          }}
          segments={[
            { value: "all", label: Copy.settingsLookAllDevices, hint: Copy.faceApplyAll },
            { value: "device", label: Copy.settingsLookThisDevice, hint: Copy.faceScopeDevice },
          ]}
        />
      ) : null}
      <View style={{ paddingTop: mailSize.inset, gap: mailSize.inset + mailSize.rowInset }}>
        {([
          { value: "paper", label: Copy.facePaper },
          { value: "ohmarchy", label: Copy.faceOhmarchy, detail: Copy.settingsLookFollowsOmarchy },
        ] as const).map(({ value, label, ...tile }) => (
          <Tap key={value} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={sayScope}
            accessibilityState={{ selected: value === face }} disabled={pending}
            onPress={() => {
              if (pending || writing.current || value === face) return;
              if (governed) apply(value);
              else {
                setFailed(false);
                setPin(value);
              }
            }}
            style={{
              padding: mailSize.inset, borderRadius: theme.radius.row, borderWidth: 2,
              backgroundColor: theme.c.tint2, borderColor: value === face ? theme.c.ink : "transparent",
            }}>
            <SettingsLookPreview face={value} />
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: mailSize.inset,
              paddingHorizontal: mailSize.rowInset, paddingTop: mailSize.inset }}>
              <Txt variant="bodyMedium"><HeadingEnd variant="caption">{label}</HeadingEnd></Txt>
              {"detail" in tile ? <Txt variant="caption" tone="ink2">{tile.detail}</Txt> : null}
            </View>
          </Tap>
        ))}
      </View>
      {failed ? <Txt variant="caption" tone="ink2" accessibilityLiveRegion="polite">{Copy.faceFailed}</Txt> : null}
    </>
  );
}

/**
 * The Folders pane: the description states the current answer (`useOn`/`useOff` — the webapp
 * catalogue's own sentences), the control moves it, and a refusal is one visible sentence
 * with the control back on the server's value. `pending` guards the double-write exactly
 * like the wake rows above.
 */
function FoldersPanel({
  on,
  pending,
  setEnabled,
}: {
  on: boolean;
  pending: boolean;
  setEnabled: (on: boolean) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  const write = (next: "on" | "off") => {
    if (pending) return;
    setFailed(false);
    void setEnabled(next === "on").then((ok) => {
      if (!ok) setFailed(true);
    });
  };
  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <View style={{ paddingHorizontal: 20, gap: 6 }}>
        <Txt variant="settingsLabel">{Copy.foldersUseTitle}</Txt>
        <Txt variant="note" tone="ink2">{on ? Copy.foldersUseOn : Copy.foldersUseOff}</Txt>
      </View>
      <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
        <Segmented<"on" | "off">
          value={on ? "on" : "off"}
          onChange={write}
          segments={[
            { value: "off", label: Copy.switchOff },
            { value: "on", label: Copy.switchOn },
          ]}
        />
        <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
          {Copy.foldersMicrocopy}
        </Txt>
        {failed ? (
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
            {Copy.foldersFailed}
          </Txt>
        ) : null}
      </View>
    </Panel>
  );
}
