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
import { useCallback, useState, useSyncExternalStore } from "react";
import { Platform, View } from "react-native";
import { buildLabel } from "../src/build-info";
import { Copy } from "../src/copy";
import { sayRefusal } from "../src/refusal";
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
import { Button, Chip, Panel, Rule, Screen, Scroller, Section, TapRow, Txt } from "../src/ui/base";
import { Sheet, SheetRow } from "../src/ui/Sheet";
import { phoneEngineStart } from "../src/engine/engine-artifact";
import {
  claimHereStandalone, onOrganizerState, organizeRefusal, organizerRestrictedSaid,
  organizerStateVersion, standaloneHere, stopOrganizerSession, stopOrganizingStandalone,
} from "../src/engine/organizer-session";
import { PHONE_CLAIM_NAME, standaloneAvailable } from "../src/engine/standalone-door";
import { releaseMailbox } from "../src/net/mailboxes";
import { useConnection } from "../src/net/connection";
import {
  claimChipLabel,
  claimFrom,
  claimHere,
  claimNoteLine,
  type PhoneClaim,
  mayStartHere,
  mayStopHere,
} from "../src/ui/standalone-form";
import { useLocale, useLocaleControls } from "../src/i18n/LocaleProvider";
import { type AppLocale } from "../src/i18n/locale";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { Segmented } from "../src/ui/Segmented";

/** Gated like the tabs: the About block states a live session's facts, so it needs one. */
export default function SettingsScreen() {
  return (
    <Gated>
      <SettingsBody />
    </Gated>
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
  const { themePref, setTheme, facePin, setFacePin } = usePrefs();
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

  return (
    <Screen>
      <DetailBar title={Copy.settings} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.settings}</Txt>
        </View>

        {/* this phone — first, because it is the only block that says what this phone IS */}
        <ThisPhonePanel />

        {/* appearance */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.theme}</Section>
          <View style={{ paddingHorizontal: 16 }}>
            <Segmented<ThemePref>
              value={themePref}
              onChange={setTheme}
              segments={[
                { value: "system", label: Copy.themeSystem },
                { value: "light", label: Copy.themeLight },
                { value: "dark", label: Copy.themeDark },
              ]}
            />
            <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
              {Copy.themeNote}
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
        */}
        <FoldersPanel
          on={w.folders.enabled}
          pending={w.folders.pending}
          setEnabled={w.folders.setEnabled}
        />

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
            <Txt variant="note" tone="ink2">
              {Copy.aboutLive(w.account.name)}
            </Txt>
            {/* What leaving actually leaves — including the one thing this build cannot yet
                take back (an iOS backup carries the copied mail). See `Copy.aboutOnDevice`. */}
            <Txt variant="note" tone="ink3">
              {Copy.aboutOnDevice}
            </Txt>
          </View>
        </Panel>
      </Scroller>
    </Screen>
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
 * The door answers for the one mailbox it serves and the app holds no id for it. This names the
 * `asked` entry and React's row; the stop it selects takes the engine's own `handBack`, which
 * needs no id. It must never reach a route, which is why it is not id-shaped.
 */
const HERE_CARD = "this-phone";

function ThisPhonePanel() {
  const w = useWorld();
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  /* WHICH MAILBOXES THIS PHONE HAS ASKED TO HAND BACK — by id, held for this screen's life. The
     press is the newest word until the row carries the release; the desktop's `stopQueued` rule. */
  const [asked, setAsked] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  /* WHAT A FAILED START SAID. Its own state and not `organizeRefusal`, which is the LAUNCH press's
     record: a person pressing Start is owed an answer about the press they just made. */
  const [startFailed, setStartFailed] = useState(false);
  /**
   * ══ THE DOOR'S STATE, LIVE — this panel was correct only at MOUNT ═══════════════════════════
   *
   * Measured on a device: `Stopping` stood for two and a half minutes over a stop that had
   * finished (claim gone, zero bytes on the wire), and `Organizing` for two minutes over a mailbox
   * another machine held and the engine had already logged a stand-down for. Both settled the
   * instant Settings was left and re-entered, which is the diagnosis: `standaloneHere()` is read in
   * the render and nothing re-rendered.
   *
   * `useSyncExternalStore` over the organizer session's own version counter — the same mechanism
   * `world.tsx` subscribes to the mirror engine with. No state is copied: a notify means "ask
   * again", and the read below is the same `standaloneHere()` it always was, so there is still one
   * answer to "does this phone organize this mailbox".
   */
  useSyncExternalStore(
    useCallback((cb: () => void) => onOrganizerState(cb), []),
    organizerStateVersion,
    organizerStateVersion,
  );

  if (!standaloneAvailable({ startEngine: phoneEngineStart() })) return null;

  /**
   * Where the cards come from, and why the door answers first. Deriving this
   * panel from `world.mailboxes` alone folded three outcomes (never asked,
   * refused, answered empty) into one `known: false`, so a phone that had opened
   * its own mailbox rendered nothing with an engine running behind it.
   * `standaloneHere()` is the engine in this process answering for itself, no
   * request; a paired session has no such door and keeps the roster as before.
   * The standalone card's key is a constant, not a mailbox id: it names the
   * `asked` entry and React's row; the engine's `handBack` releases every mailbox.
   */
  const here = standaloneHere();
  /* Only where there is a door to have asked — a paired session's panel says nothing of it. */
  const consentRefusal = here === null ? null : organizeRefusal();
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
        claim: claimHere(here, asked.includes(HERE_CARD)),
      }]
    : w.mailboxes.rows.map((row) => ({
        key: row.id,
        address: row.address,
        claim: claimFrom(
          { known: w.mailboxes.known, organizer: holderFor(row) },
          /* THE SAME CONSTANT THE CLAIM WAS WRITTEN WITH — never `Copy.phoneThisPhone`, which
             changes with the language and would make this phone read its own claim as a
             stranger's the first time somebody switches. The deck string is the section LABEL
             above, which is the half a reader sees. */
          PHONE_CLAIM_NAME,
          asked.includes(row.id),
        ),
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
                <Txt variant="note" tone="ink2">
                  {claimNoteLine(claim, Platform.OS)}
                </Txt>
                {/* BATTERY SAVER, SAID WHERE THE PLATFORM RULE IS — and only once the background
                    half has actually met it. `organizerRestrictedSaid` is the record
                    `announceRestricted` writes; the deck's own note says this app organizes while
                    it is open instead, which contradicts the rule line above it, so it sits
                    directly under it rather than somewhere else on the screen. */}
                {organizerRestrictedSaid() ? (
                  <Txt variant="note" tone="ink2">{Copy.organizerRestricted}</Txt>
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
                {/* AND WHAT A FAILED START SAID, beside the press that made it. */}
                {startFailed && row.key === HERE_CARD ? (
                  <Txt variant="note" tone="ink2" accessibilityRole="alert">
                    {Copy.settingsStartHereFailed}
                  </Txt>
                ) : null}
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
                      setStartFailed(false);
                      /* A FINGER, SO THE CONSENT PRESS IS LICENSED. `claimHereStandalone` records
                         it through the engine's own door and the door refuses a live foreign claim,
                         so this press can never produce a second organizer. */
                      void claimHereStandalone().then((outcome) => {
                        setStartFailed(outcome === "refused");
                      });
                    }}
                    style={{ alignSelf: "flex-start", marginTop: 4 }}
                  />
                ) : null}
              </View>
            </View>
          );
        })}
      </Panel>

      {/* THE CONSEQUENCE, THEN THE ONE DELIBERATE PRESS — the app's own destructive idiom
          (`FoldersGroup`'s delete confirm). The danger is on the confirm and nowhere else. */}
      {confirming !== null ? (
        <Sheet open onClose={() => setConfirming(null)} label={Copy.settingsStopHere}>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {Copy.settingsStopHereWhat}
          </Txt>
          <SheetRow
            icon="pause"
            label={Copy.settingsStopHereConfirm}
            onPress={() => {
              const id = confirming;
              setConfirming(null);
              /* RECORDED BEFORE THE REQUEST LEAVES, so the chip stops saying "Organizing" the
                 moment the press lands rather than a poll later — and a refusal is not a reason
                 to claim the mailbox is still being filed by a phone that asked to stop. */
              setAsked((cur) => (cur.includes(id) ? cur : [...cur, id]));
              /* ══ THE STOP IS REMEMBERED, WHICH `handBack` WAS NOT ═══════════════════════
                 This pressed the engine's `handBack`, which takes the claim out of the folder and
                 deliberately leaves the ROW saying organizer — right for an app leaving the
                 foreground, wrong for a person pressing stop. Measured: dismiss the notification,
                 reopen the app, and the foreground resume wrote a claim nothing serviced.
                 `stopOrganizingStandalone` goes through the release the row records, which is the
                 same ceremony the paired arm's route takes. */
              if (id === HERE_CARD) void stopOrganizingStandalone();
              else if (session !== null) void releaseMailbox(session, id);
              /* AND THE NOTIFICATION COMES DOWN WITH THE CLAIM. The claim has been given back, so
                 a foreground service left standing would say "Organizing <address>" over a phone
                 that reads — on the one surface a person cannot argue with. */
              void stopOrganizerSession();
            }}
          />
          <SheetRow icon="x" label={Copy.settingsStopHereCancel} onPress={() => setConfirming(null)} />
        </Sheet>
      ) : null}
    </>
  );
}

/**
 * One row's holder in `claimFrom`'s shape — a named holder, or nothing.
 *
 * The KIND rides along: the note under the chip reads it, and dropping it here would give the
 * paired arm the generic sentence for a mailbox a phone organizes. The same fix on both arms.
 */
function holderFor(row: {
  organizedBy: { kind: string | null; name: string | null } | null;
  organizerState: "held" | "stopped" | null;
}): { name: string; stopped: boolean; kind: string | null } | null {
  const name = row.organizedBy?.name ?? "";
  return name === ""
    ? null
    : { name, stopped: row.organizerState === "stopped", kind: row.organizedBy?.kind ?? null };
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
