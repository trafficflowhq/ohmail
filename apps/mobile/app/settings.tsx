/**
 * Settings — appearance, new mail, and what this build is. Every control here
 * is real and every claim one this build can keep: the theme switch is the
 * app's own preference, the New mail block registers with the paired server,
 * and the About block states what is live and names what is not. Remaining
 * per-server settings (rules, mailboxes) arrive with later updates — absent,
 * not mocked; the pairing lives on the Servers screen. The New mail block shows
 * a real choice when the phone has distributors installed and one sentence with
 * no control when it does not — read from the device, never a build assumption.
 */
import Constants from "expo-constants";
import { router } from "expo-router";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Platform, View } from "react-native";
import { buildCommit, buildLabel } from "../src/build-info";
import { Copy } from "../src/copy";
import { refuse, sayRefusal, type Refusal } from "../src/refusal";
import { type WakeState } from "../src/net/push";
import { useWake } from "../src/state/wake";
import {
  accountGovernsFace,
  accountWideOffered,
  type FaceName,
  type ThemePref,
} from "../src/theme";
import { usePrefs } from "../src/state/store";
import { useWorld } from "../src/state/world";
import { connectionSaid, firstSyncSaid } from "../src/state/live";
import { Button, Chip, Panel, Rule, Screen, Scroller, Section, TapRow, Txt } from "../src/ui/base";
import { Sheet, SheetRow } from "../src/ui/Sheet";
import { Nav } from "../src/ui/MoreNav";
import { Field } from "../src/ui/Field";
import { useConnection } from "../src/net/connection";
import { changeServerSettings, checkMailbox, resupplyPassword, selfChecksThisSession } from "../src/net/mailboxes";
import { backupExclusion, subscribeBackupExclusion } from "../src/engine/backup-exclusion";
import { phoneEngineStart } from "../src/engine/engine-artifact";
import {
  onOrganizerState, organizeRefusal, organizerHandedBack, organizerInstruction,
  organizerHandBackLateSaid, organizerNotificationsOffSaid, organizerRestrictedSaid, organizerSettingsLeft,
  organizerStateVersion,
  pressOrganizeHere, standaloneHere, standaloneServerSettings,
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
  mayStartHere,
  mayStopHere,
  portFieldSaid,
  pressSaidLine,
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
import { type AppLocale } from "../src/i18n/locale";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { Segmented } from "../src/ui/Segmented";
import { AutoActPanel, readsOnly } from "../src/ui/AutoActPanel";
import { AutoFiledPanel } from "../src/ui/AutoFiledPanel";
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
import { writePhoneDiagnostics } from "../src/engine/diagnostics";
import { nativePhoneDiagnosticDeps, shareDiagnosticFile } from "../src/engine/diagnostics-native";
import { diagnosticSaid, type DiagnosticPress } from "../src/ui/diagnostic-said";
import { selfCheckRowSaid, type SelfCheckPress } from "../src/ui/self-check-said";
import { WaitingStrip } from "../src/ui/WaitingStrip";

/** Gated like the tabs: the About block states a live session's facts, so it needs one. */
export default function SettingsScreen() {
  return (
    <SurfaceBoundary surface="settings">
      <Gated>
        <SettingsBody />
      </Gated>
    </SurfaceBoundary>
  );
}

/**
 * SETTINGS → LANGUAGE, as its own component so the null-provider case is a structural absence
 * rather than a branch inside the settings body.
 *
 * `null` is the segment for "follow this phone", and it is a real third state rather than a
 * cosmetic default — see {@link Copy.language}'s note. The control renders what the DEVICE has
 * stored, never the optimistic pick: a refused keystore write leaves the segments where they were
 * and puts one sentence underneath, which is the contract every other settings control here keeps.
 */
function LanguagePanel() {
  const controls = useLocaleControls();
  const [failed, setFailed] = useState(false);
  if (controls === null) return null;
  /* `Segmented` keys its rows by value, so the "follow this phone" state needs a spelling rather
     than `null`. It is translated at this boundary and nowhere else — `LocaleControls` keeps the
     `null` that says "nothing is stored", which is the distinction the keystore actually holds. */
  const segments: { value: AppLocale | "system"; label: string }[] = [
    { value: "system", label: Copy.languageSystem },
    { value: "en", label: Copy.languageEnglish },
    { value: "de", label: Copy.languageGerman },
  ];
  const chosen: AppLocale | "system" = controls.chosen ?? "system";
  return (
    <View style={{ paddingHorizontal: 16, marginTop: 18 }}>
      <Txt variant="settingsLabel" style={{ marginBottom: 10 }}>{Copy.language}</Txt>
      <Segmented<AppLocale | "system">
        value={chosen}
        onChange={(next) => {
          if (controls.busy || next === chosen) return;
          setFailed(false);
          controls.setLocale(next === "system" ? null : next).catch(() => { setFailed(true); });
        }}
        segments={segments}
      />
      <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
        {failed ? Copy.languageFailed : Copy.languageNote}
      </Txt>
    </View>
  );
}

/**
 * The one sentence the New mail block renders, chosen from the wake state.
 *
 * Exported nowhere and pure, so `test/wake-copy.test.ts` can assert that every state has a
 * sentence and that none of them claims a wake this build can deliver. A `switch` over the union
 * rather than a lookup, because adding a state to {@link WakeState} then fails to compile here
 * instead of silently rendering nothing.
 */
export function wakeSentence(state: WakeState): string {
  switch (state.k) {
    case "no_distributor": return Copy.wakeNoDistributor;
    case "not_supported_here": return Copy.wakeDesktopHost;
    case "server_has_no_key": return Copy.wakeServerNoKey;
    case "on": return Copy.wakeOn;
    // `row_remains` is not "we could not set it up" — it is "we could not take it back", and the
    // two have different sentences and different remedies.
    case "off": return state.reason === "row_remains" ? Copy.wakeRowRemains : Copy.wakeOff(state.reason);
  }
}

function SettingsBody() {
  /* Subscribed: this is the screen the switch is made ON, so it is the screen that must redraw
     under the finger rather than on the next navigation. */
  useLocale();
  const w = useWorld();
  const conn = useConnection();
  /* The live session the "Filed automatically" panel reads through; none, no panel. */
  const session = conn.state.k === "live" ? conn.state.session : null;
  const { themePref, setTheme, facePin, setFacePin, pictureQuality, setPictureQuality } = usePrefs();
  const wake = useWake();
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

  return (
    <Screen>
      <DetailBar title={Copy.settings} />
      <Scroller bounded>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.settings}</Txt>
        </View>

        {/* this phone — first, because it is the only block that says what this phone IS */}
        <ThisPhonePanel />
        <WaitingStrip />

        {/* a "Not now" whose settings document still stands in the mailbox: Import, or Save */}
        <SavedSettingsPanel />

        {/* appearance */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.theme}</Section>
          <View style={{ paddingHorizontal: 16 }}>
            <Segmented<ThemePref>
              value={themePref}
              onChange={setTheme}
              segments={[
                { value: "system", label: Copy.themeAuto },
                { value: "light", label: Copy.themeLight },
                { value: "dark", label: Copy.themeDark },
              ]}
            />
            <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
              {Copy.themeNote}
            </Txt>
          </View>

          {/* PICTURE QUALITY — the web's dial, the same four levels and the same table: how much a
              picked picture is shrunk before it is attached. Kept on this phone. */}
          <Section style={{ paddingTop: 16 }}>{Copy.pictureQuality}</Section>
          <View style={{ paddingHorizontal: 16 }}>
            <Segmented<ImageQualityLevel>
              value={pictureQuality}
              onChange={setPictureQuality}
              segments={IMAGE_QUALITY_LEVELS.map((level) => ({ value: level, label: pictureQualityLabel(level) }))}
            />
            <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
              {Copy.pictureQualityNote}
            </Txt>
          </View>

          {/*
            LANGUAGE — the same shape as the control above it, one row down, because it is the same
            kind of choice. It draws nothing when no locale provider is mounted, which is the demo's
            bare panes and the node suite's component renders: a selector that cannot select is the
            built-and-unreachable shape this screen avoids everywhere else.
          */}
          <LanguagePanel />

          {/*
            LOOK — the face, in the same panel as light/dark because they are the same class of
            decision: how the app is drawn, changing nothing about anybody's mail.
          */}
          <FacePanel
            pin={facePin}
            account={w.face.account}
            accountKnown={w.face.known}
            pending={w.face.pending}
            setPin={setFacePin}
            applyAll={w.face.applyAll}
          />
        </Panel>

        {/*
          New mail — a real control when there is a real choice, a sentence
          otherwise. The list comes from the device (`listDistributors()`), so
          rows show only when the phone has distributors installed. With none —
          and on every iPhone, where UnifiedPush cannot exist — `wake.choices`
          is empty and the pane is one sentence with no control: a toggle that
          cannot move is worse than a paragraph saying why. The `None` row is
          last and separated — the only destructive option: it drops the server
          registration as well as forgetting the distributor.
        */}
        <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.wake}</Txt>
            <Txt variant="note" tone="ink2">{wakeSentence(wake.state)}</Txt>
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

        {/*
          FOLDERS — the feature's master toggle (FOLDERS-SPEC.md §6; owner decision 1: fully
          optional, off by default). The control renders the value the SERVER last answered
          with, never the optimistic pick — a refused write must not draw a folders group the
          account does not have (the webapp FoldersRow's rule; the world layer holds it). A
          plain switch and not a confirm: ON is a read-only act on the mailbox — it shows
          folders that already exist and moves nothing.

          WITHHELD where the door cannot keep the choice (`w.folders.storable`) — the paired
          desktop host, a self-host server, this app's own standalone door: their consent answer
          carries no folders axis, the PATCH is dropped, and the switch used to flip and snap
          back with nothing said. The same structural rule the shared shell applies to its
          Folders section (`consent.foldersStorable`), one client further.
        */}
        {w.folders.storable ? (
          <FoldersPanel
            on={w.folders.enabled}
            pending={w.folders.pending}
            setEnabled={w.folders.setEnabled}
          />
        ) : null}

        {/* THE ACT ON SUGGESTIONS, drawn only where the consent answer carries it. */}
        {w.autoAct ? (
          <AutoActPanel
            on={w.autoAct.on}
            suggestOn={w.autoAct.suggestOn}
            reader={readsOnly(w.mailboxes.known, w.mailboxes.rows)}
            pending={w.autoAct.pending}
            set={w.autoAct.set}
          />
        ) : null}

        {/* WHAT THE SCREENER FILED ON ITS OWN, with Put back — beside the other automatic act.
            The phone has no auto-apply switch of its own; the panel reads the same route pair. */}
        {session !== null ? <AutoFiledPanel session={session} /> : null}

        {/*
          THE AWAY RESPONDER — a row rather than the form, because the form is
          three controls plus three facts it does not change and that is a screen, not a panel.
          Where the webapp keeps it: in Settings, so one product has one home for the one thing
          that sends mail on its own. Its own route so a person can be handed it directly.
        */}
        <Panel style={{ paddingBottom: 8, marginBottom: 14 }}>
          <Nav
            label={Copy.awayRow}
            sub={Copy.awayRowSub}
            chevron
            onPress={() => router.push("/away")}
          />
        </Panel>

        {/* about — one sentence, true of the session on screen */}
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
      </Scroller>
    </Screen>
  );
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
        { reader: engine?.read() ?? null, mailboxes: w.mailboxes.rows, selfChecks: selfChecksThisSession() },
        nativePhoneDiagnosticDeps(),
      );
      setPress(where === null ? { k: "failed" } : { k: "written", where });
    } catch {
      setPress({ k: "failed" });
    }
  }, [connection.state, w.mailboxes.rows]);
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
 * The face and its two scopes — the phone's half of OHMARCHY-PLAN.md §3a. The
 * segmented control is "only this device": it writes the device pin instantly,
 * no server involved. The quiet line, "apply on all devices", PATCHes the
 * account (`{themeFace}` alone), adopts the echo and clears the pin; a pinned
 * device ignores account changes. Apply-all is withheld, not disabled, when
 * nothing is connected or the face is not yet read ({@link World.face.known}):
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

function ThisPhonePanel() {
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
   * again", and the read below is the same `standaloneHere()`, so there is one answer to whether
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
  const here = standaloneHere();
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
  const cards: readonly { key: string; address: string; claim: PhoneClaim }[] = here !== null
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
    : w.mailboxes.rows.map((row) => ({
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
                {/* THE CONNECTION, WHERE SOMEBODY ASKING "IS MY MAIL BEING FILED?" IS LOOKING.
                    The chip above answers who ORGANIZES the mailbox; this answers whether
                    anything can reach it. Both, because they are true at once: this phone is
                    still the organizer of a mailbox whose server it cannot dial, and a panel
                    that showed only the first read `Organizing` through a measured outage. */}
                {outage === null ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">{outage}</Txt>
                )}
                {/* THE MAIL, NOT THE LINK — see `unreadable` above. */}
                {unreadable === null ? null : (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">{unreadable}</Txt>
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
                        setSaid(
                          outcome === "refused" ? "startRefused"
                            : outcome === "unreadable" ? "startUnreadable"
                              : null,
                        );
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
                  const check = selfCheckRowSaid(checkPress);
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
                 `ours`, which only the door in this process produces. */
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
        <Sheet open onClose={() => setResupplying(false)} label={Copy.signInAgain} cancel="own">
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 4 }}>
            {Copy.signInAgainLead}
          </Txt>
          <Field
            value={newPassword}
            onChange={setNewPassword}
            label={Copy.signInAgainField}
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
        <Sheet open onClose={() => setServers(null)} label={Copy.serverSettings} cancel="own">
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
}: {
  pin: FaceName | null;
  account: FaceName | null;
  accountKnown: boolean;
  pending: boolean;
  setPin: (face: FaceName | null) => void;
  applyAll: (face: FaceName) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  /* The face on screen — the provider resolves the same way; this recomputes it rather than
     reading the theme, because the CONTROL must show the choice, and reading `useTheme().face`
     would draw the same value through a longer path. `accountGovernsFace` is the pure rule. */
  const face: FaceName = pin ?? account ?? "paper";
  const governed = accountGovernsFace(face, pin, account);
  return (
    <>
      <Section style={{ paddingTop: 18 }}>{Copy.face}</Section>
      <View style={{ paddingHorizontal: 16 }}>
        <Segmented<FaceName>
          value={face}
          /* Device-local and instant — the "only this device" scope. Never the account. */
          onChange={(next) => {
            if (next === face) return;
            setFailed(false);
            setPin(next);
          }}
          segments={[
            { value: "paper", label: Copy.facePaper },
            { value: "ohmarchy", label: Copy.faceOhmarchy },
          ]}
        />
        <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
          {Copy.faceHint}
        </Txt>
        <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
          {governed ? Copy.faceScopeAll : Copy.faceScopeDevice}
        </Txt>
        {accountWideOffered(accountKnown, face, pin, account) ? (
          <Button
            label={Copy.faceApplyAll}
            variant="quiet"
            style={{ alignSelf: "flex-start", marginTop: 4, paddingHorizontal: 0 }}
            onPress={() => {
              // `pending` guards the double-write, exactly like the wake rows and the Folders
              // pane — one write on the wire at a time, and the second press is not asked for.
              if (pending) return;
              setFailed(false);
              void applyAll(face).then((ok) => {
                if (!ok) setFailed(true);
              });
            }}
          />
        ) : null}
        {failed ? (
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
            {Copy.faceFailed}
          </Txt>
        ) : null}
      </View>
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
