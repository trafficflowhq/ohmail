# ohmail — iOS & Android

**Status: pairs with your own server, reads and triages real mail.** The app
opens empty and connects — there is no sample data and no demo account. First
run is a single welcome screen and then the pairing flow: scan the QR from a
desktop install's Devices screen or a self-hosted server's setup page, paste
the pairing link, or type the address by hand (over the LAN or a tailnet).
Once paired, the same `@ohmail/client-engine` every other client runs syncs
your mail into an on-device, per-account sqlite mirror, and the Ohbox, Reads,
Receipts and Screener screens read and triage it — mark-read, screening
decisions, releases and piles all round-trip to the server and survive an app
kill. Disconnecting keeps the pairing; forgetting the last pairing returns the
app to the welcome screen.

Honest edges, stated here and on the screens themselves:

- **Reply, forward and tags are live on an open message** — the same verbs the
  web and desktop clients offer (reply, reply all, forward, the three triage
  horizons with the resurface chooser, tag, screening, move, the read switch),
  named the same and dispatched through the same engine mutations. With
  "Use folders" on, the message sheet also carries **Delete**, behind its own
  confirm: it files the message to the Trash folder on your own mail server —
  never an expunge, and ohmail never erases mail. With the switch off, the
  reader is the previous reader, with no Delete verb.
- **Your mail server's own folders show when you turn them on.** Off by
  default; the switch in Settings reads and writes your account's consent on
  the paired server. On, the More screen lists the folders as the tree they
  already are on the server — first level by default, unread counts that roll
  up into a collapsed branch — and each folder opens as its own list.
  Read-only for now (no create, rename or move-to-folder), matching the web
  client's foundation stage, and the folder screens say plainly that they show
  what is on this phone's mirror rather than claiming a folder is empty.
- **Compose from scratch, search and attachment-open are not built yet.** No
  control for them renders; the More screen and the About block say they
  arrive with later updates.
- **The picker never claims a door works — it asks.** Each card negotiates
  `GET /hello` against the real server and offers a pairing step only where that
  server answers `features.pairing: true`. The managed service answers that it
  does, so its card leads to the code on the web client's Settings → Devices
  pane; a self-hosted server answers for itself. Nothing here is a promise about
  a server this app has not asked.
- **New-mail wake works whether the app is open, backgrounded, or closed.** The
  server sends a fifteen-byte signal, encrypted to this device, through a
  [UnifiedPush][up] distributor you choose and install yourself; no Google or
  Apple push service is in the path, and the app carries no client for either.
  While the app is running (open or in the background) a wake is handled
  silently — the app fetches your mail directly and it appears. When the app has
  been swiped away, a small native renderer draws a single plain "New mail"
  notice whose tap opens the app; that notice is the only thing a content-free
  wake can show, and it carries no subject, no sender and no count. The renderer
  reads no field out of the payload — it acts only on the exact wake constant, so
  a paired server cannot draw a notification in ohmail's name. The closed-app
  notice depends on the OS notification permission (Android asks for it from
  Android 13 on); without it the app still syncs the next time it is opened, and
  foreground sync and pull-to-refresh remain the floor underneath all of it.
  Settings shows the distributors found on your phone and one sentence when there
  are none.
- The server must have a signing keypair for a wake to be renderable — the
  managed service has one, and a self-hosted install generates its own with
  `node scripts/vapid-keygen.mjs`. Without one, Settings says so rather than
  showing a control that cannot work.

[up]: https://unifiedpush.org
- The theme choice resets to "system" on relaunch; a persisted preference is a
  later update.

---

## Run it

From a clone of this repository:

```bash
npm ci                               # repo root — installs the workspace
cd apps/mobile
npx expo start                       # Metro on the default port
```

Then, from the Metro prompt: `i` for the iOS simulator, `a` for an Android
emulator. Everything here runs inside Expo Go; no native build is required for
development.

### iOS simulator, from scratch

Xcode alone is not enough — since Xcode 15 the simulator *runtimes* are a
separate download, and a machine with Xcode but no runtime reports zero
devices:

```bash
xcrun simctl list runtimes                       # empty? then:
xcodebuild -downloadPlatform iOS                 # ~10 GB, once
xcrun simctl boot "iPhone 17 Pro" && open -a Simulator
```

### Android, from source

`.github/workflows/android.yml` builds the APK in this repository's own
Actions on every push (and attaches a signed one to `android-v*` releases —
see below). To build locally you need JDK 17 and the Android SDK, then:

```bash
cd apps/mobile
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleRelease
# apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

The generated `android/` directory is build output and is not committed.

---

## Identity and version

The application identifier is **`app.ohmail`** on both platforms — the reverse-DNS
form of the product's domain. It is the iOS `bundleIdentifier` and the Android
`applicationId`/`namespace`, and it is written once, in `app.json`.

Earlier builds used `app.ohmail.preview`. **An install of one of those will not
update in place**, because Android and iOS both treat the identifier as the app's
identity: a package with a different identifier is a different app. A tester
holding a `.preview` build has to uninstall it and install the new one. Nothing is
migrated across that boundary and nothing needs to be — a phone holds only a copy
of what is on the server, so the new install pairs again (one scan per server) and
syncs the same mail back down. The `.preview` app's own data goes with it when it
is removed, which is the same take-back an uninstall has always been here.

### `app.json` is the only place a version is written

| What | Where it is authored | What it becomes |
| --- | --- | --- |
| `version` | `expo.version` | iOS `CFBundleShortVersionString`, Android `versionName` |
| iOS build number | `expo.ios.buildNumber` | `CFBundleVersion` |
| Android version code | `expo.android.versionCode` | Gradle `versionCode` |

`android/app/build.gradle` carries `applicationId`, `versionCode` and `versionName`
as *generated* values: `expo prebuild` writes them from the three fields above, and
`android/` is not committed. So a number that looks wrong in that file is a stale
prebuild, not a second source of truth — regenerate rather than edit it, because an
edit there is deleted by the next prebuild.

The app shows it too. The About block under Settings renders `Version <version>
(<build number>)` from the config the artifact embeds — Android's version code,
iOS's build number — so a tester holding a sideloaded APK can name the build they
are looking at without a shell. `test/build-info.test.ts` holds that line equal to
the generated `build.gradle` wherever a prebuild has produced one.

To confirm what the current configuration actually resolves to, without building
anything:

```bash
cd apps/mobile
npx expo config --type public   # ids, version, buildNumber, versionCode
```

---

## What the iOS build asks the system for

Every entry below is here because a line of this app's own code asks for it. The
rule is the awkward direction of that sentence: a purpose string for a capability
the app does not use is not harmless padding — it is a claim about the app that is
false, and the person reading the prompt has no way to check it.

| Key | Why it is there |
| --- | --- |
| `NSCameraUsageDescription` | `app/scan.tsx` asks for the camera to read a pairing QR code, and treats a refusal as a state rather than a dead end. Supplied through `expo-camera`'s `cameraPermission` so the string is written once. |
| `ITSAppUsesNonExemptEncryption: false` | The app implements no encryption. Transport is the platform's own HTTPS, credentials sit in the platform Keychain, and the only use of `expo-crypto` is `randomUUID()` for identifiers. Answering here means the question is not asked again on every upload. |

And the keys that are deliberately **absent**, each one a capability this app
declines rather than one nobody thought about:

- **Microphone.** `expo-camera` declares `NSMicrophoneUsageDescription` among its
  defaults, and Expo's `applyPermissions` writes a default string whenever the
  option is left undefined — only the literal value `false` removes the key. So
  "we never set it" was shipping *"Allow ohmail to access your microphone"* for an
  app that records nothing. It is now `microphonePermission: false`. The Android
  half of this decision was already made — `recordAudioAndroid: false` keeps
  `RECORD_AUDIO` out of the manifest — and iOS was the half still missing.
- **Face ID.** `expo-secure-store` defaults `NSFaceIDUsageDescription` the same
  way. This app stores refresh tokens with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and
  never asks for biometric authentication, so the key is removed with
  `faceIDPermission: false`.
- **Photo library, contacts, calendar, location.** No API for any of them appears
  in the app.
- **Local network.** Nothing browses for services, and a same-network address is
  refused rather than reached (see *Pairing, in one paragraph*). A purpose string
  would describe a capability the app turns down.
- **Background modes and remote notifications.** New-mail wake is UnifiedPush, and
  UnifiedPush is Android-only (see below), so the iOS binary contains no push
  client to wake. An entitlement for something that cannot fire is worse than not
  having it.
- **Associated domains.** Deep links are the `ohmail://` scheme, which Expo Router
  serves. Verified app links would need `/.well-known/apple-app-site-association`
  and `/.well-known/assetlinks.json` served from the domain; neither exists today,
  so neither platform has them and the entitlement would fail to validate.

### The privacy manifest

`ios.privacyManifests` in `app.json` writes the app target's
`PrivacyInfo.xcprivacy`. It declares no tracking, no tracking domains, and the four
required-reason API categories the shipped binary genuinely reaches, with the
reason that is true of *our* use:

| Category | Reason | What actually uses it |
| --- | --- | --- |
| `FileTimestamp` | `C617.1` | Files inside the app container — the per-account sqlite mirrors and the install-generation database. |
| `UserDefaults` | `CA92.1` | Read and written only for this app. |
| `SystemBootTime` | `35F9.1` | Measuring elapsed time. |
| `DiskSpace` | `E174.1` | Checking there is room before writing. `85F4.1` — *displaying* free space to the person — is deliberately **not** claimed, because no screen shows a disk figure. |

The first three are what React Native's own aggregation adds for its core
(`react-native/scripts/cocoapods/privacy_manifest_utils.rb`, `get_core_accessed_apis`);
the fourth comes from `expo-file-system`, which arrives as a dependency of `expo`
and declares it in its own pod manifest. That same aggregation step *merges* the
pods' declarations into whatever the app target already has and de-duplicates the
reasons, so declaring them here is additive rather than a conflict — and it puts
the decision in a reviewed file instead of only in generated output.

### iPad

`supportsTablet` is **false**. The layout is phone-shaped on purpose: the rail and
the two-pane deck were dropped rather than scaled (see *Tokens → React Native*),
so a tablet build today would be a stretched single column. iPhone apps still
install and run on an iPad in compatibility mode, so nothing is withheld from
anyone — what is withheld is a claim to be an iPad app. Turning it on is a real
piece of work, not a flag: a layout that uses the width, and screenshots to match.
Android has no equivalent switch, and a phone-shaped layout stretches on an Android
tablet too; that is the open half rather than a solved one.

### Three halves that exist on Android and not on iOS

Stated here because the app's own screens say so, and because a reader comparing
the two builds should not have to infer it:

| Feature | Android | iOS |
| --- | --- | --- |
| **Same-network pairing with a computer** | Works. `modules/host-pinning` pins the desktop's self-signed key, installed before React Native starts. | Refused. The native half is named but not built, `canPin()` is false, and the seam refuses rather than connecting unpinned. The remedy the screen offers is the Tailscale address from the same pane, which works on both. |
| **New-mail wake** | Works, through a UnifiedPush distributor you install. | Absent. `expo-unified-push` declares `platforms: ["android"]`, so there is no wake client in the iOS binary. Foreground sync and pull-to-refresh are the floor on both. |
| **Mail kept out of the OS backup** | Done, by this app's own rules (`plugins/backup-exclusions.js`). | Open. `expo-sqlite` writes into the documents directory, which the platform's backups include unless each file carries the exclude attribute — native code this repository does not yet write. Refresh tokens are *not* affected on either platform; they are Keychain items marked this-device-only. |

---

## Stack, and why

| Decision | Reason |
| --- | --- |
| **Expo SDK 57** (React Native 0.86, React 19), managed workflow | No committed `ios/` or `android/` directory whose contents nobody reads; `expo prebuild` generates them when a native build needs them. |
| **Expo Router** | File-based routes give deep links (`ohmail://…`), which reach every screen. |
| **`@ohmail/client-engine` consumed live**, over an injected `SqlExecutor` | The engine is not forked for React Native. `src/engine/boot.ts` composes the same `OhmailEngine` every other client runs — `SqlMirrorStore` over expo-sqlite, uuid from expo-crypto, RN's own `fetch`, no EventSource (this build polls) — and a sqlite failure surfaces as a refusal, never a silent in-memory fallback. Writes to one mirror file are **serialised** (`src/engine/sql-queue.ts`): expo's `withExclusiveTransactionAsync` runs on a second connection to the same database, so two overlapping writes are two writers and the loser aborts with `database is locked`. |
| **`@ohmail/ui` NOT reused** | It is DOM and CSS. Nothing in it survives translation to React Native, and pretending otherwise would produce a `react-native-web` shim, not a native app. |
| **`@ohmail/tokens` translated, not re-typed** | `src/theme/` holds the authored OKLCH values verbatim and converts them at load. Documented below. |
| **No state library** | State is the engine's own mirror behind `src/state/live.ts`; `src/state/model.ts` is the row vocabulary; app-local preference is one small provider. |
| **No sample data in the app** | The app is empty until it is connected, and says so. Sample content exists only on the product's website; the test suites build their own synthetic corpora, which never ship. |
| **Refresh tokens live in the device keystore** | expo-secure-store (iOS Keychain / Android Keystore), never a file and never a backup that multiplies a credential. A restored phone re-pairs with one scan per server. |

### Pairing, in one paragraph

Every server flavor pairs the same way: the picker asks `GET /hello` what the
address is and offers a pairing step only when the server says
`features.pairing: true` — never a dead button. The credential is
`${origin}/pair#${token}`: the token rides the link's fragment, is spent
exactly once in the body of `POST /pair/redeem`, and appears in no URL, no
header and no log line.

**A plain `http://` address is refused, and refused by this app rather than by
the platform.** React Native's fetch has no secure-context gate and no CORS, so
nothing in the runtime would stop a cleartext request to `http://192.168…` — the
transport gate in `src/net/pairing.ts` (`admitOrigin`) does, before the first
request to an origin, and it says why in words. Loopback is the one exception,
because it is not a network hop. Two more refusals sit beside it: an IP-literal
https address is either pinned or unverified, and unverified is worth nothing; and
a build that cannot install a pin refuses rather than connecting without one. That
is why the generated iOS configuration carries no transport-security exception and
no local-network purpose string — the rule the app enforces in JavaScript is the
one the platform's default already enforces, and an exception would only widen
what the app declines to use.

### Metro in a workspace

`metro.config.js` does two non-obvious things, both commented in the file: it
watches the workspace root and adds both `node_modules` directories (without
`disableHierarchicalLookup`, which breaks isolated layouts), and it teaches
Metro the TypeScript `extensionAlias` rule so `@ohmail/client-engine`'s
NodeNext `./engine.js` imports resolve from source.

---

## Tokens → React Native

Everything below lives in `src/theme/`. Every OKLCH value is the authored
token from `@ohmail/tokens`, converted once at load; the sRGB hex each one
resolves to is recorded beside it in `palette.ts`, so fidelity is reviewable
by eye.

**Contrast, measured rather than assumed.** Every ink × surface pair in the
shipped palette was composited over its real backdrop (the translucent tokens
are alpha-composited first, not read as if opaque) and scored against WCAG.
All 30 pairs clear 4.5:1 in both schemes.

| Token | RN form | Fidelity |
| --- | --- | --- |
| `color.{light,dark}` (OKLCH) | `src/theme/oklch.ts` → `#rrggbb` / `rgba()` | **Exact.** Ottosson's reference matrix. Every token's sRGB hex is recorded beside it. |
| `shadow.lift0…3`, `barEdge` | `boxShadow: BoxShadowValue[]` | **Exact.** RN ≥ 0.76 accepts multi-layer shadows *with spread*, which is the CSS model. `liftUp()` mirrors the ladder for the one bar that occludes upward. |
| `radius.*`, `spacing.*` | plain numbers | **Exact.** CSS px are RN points at 1×. |
| `typography.size` | `fontSize` | **Exact**, half-points included. |
| `typography.tracking` (em) | `letterSpacing` (pt) | **Exact**: `em × size`. |
| `typography.leading` (multiplier) | `lineHeight` (pt) | **Exact**: `size × multiplier`. |
| `typography.weight` 450/500/550/600/650 | `fontWeight` `'400'/'500'/'600'/'600'/'700'` | **Lossy — the one lossy step.** RN exposes whole hundreds only; 550 and 600 fold together. The fold is argued in `src/theme/type.ts`. |
| `motion.easing` | `Easing.bezier(...)` control points | **Exact.** Durations are ms instead of s. |
| `motion.reducedMotion` | `theme.ms()` returns 0 | A transition becomes *instant*, never merely slower. Stack animations switch to `none`. |
| `gradient.scFade` | `react-native-svg` `<LinearGradient>` | The one functional gradient, reused once for the dock band (below). Decorative gradients stay banned. |
| icon set | `src/ui/Icon.tsx` | The design prototype's `<symbol>` paths, byte for byte, on the same 16×16 grid at stroke 1.3. Three new glyphs (`reads`, `receipts`, `more`) exist because a tab bar needs marks the typographic desktop rail never did; they are drawn on the same grid and marked in the file. |
| `layout.rail`, `layout.split` | — | Dropped. A phone has no rail and no two-pane deck; the rail's contents live under the **More** tab. |

App icon, splash and the Android adaptive/monochrome layers are drawn from the
product mark itself, not a redraw. The adaptive foreground keeps the mark inside
Android's 66dp safe circle (launchers mask the 108dp canvas), so the icon renders
at the size every other launcher icon does.

**There are two icon sources, and the second one exists because of what the iOS
build does to the first.** `assets/icon.png` keeps its transparent rounded corners,
which is what Android wants — the legacy launcher icon and the store listing both
take transparency, and the adaptive icon composites its foreground over
`#fbfaf9` anyway. The iOS pipeline instead flattens the icon and forces the
background to pure white, so those transparent corners came out as four white
wedges around a field that is `#fbfaf9` everywhere else, and Apple's own mask does
not sit exactly where the baked-in rounding does. Driven through Expo's real icon
generator, today's source produced ~45 000 pure-white pixels; `assets/icon-ios.png`
— the same art with the corners filled to the icon's own ground and no alpha
channel at all — produces none, and every opaque pixel is unchanged. The rounding
is then applied once, by the platform, which is the only place it belongs.

**The launch screen renders the configured colour and mark**, and there is one
place it is configured. It comes from the `expo-splash-screen` config plugin, whose
entry in `app.json` carries its properties outright: the plugin is a no-op when
called without them, so a bare entry would look configured and change nothing.
`imageWidth` is 200 rather than the default 100, which puts the visible mark at
118dp — the mark occupies 58% of its own transparent canvas.

The older top-level `splash` block is gone. Those keys are the pre-SDK-52 form of
the same settings, nothing reads them any more, and leaving them beside the plugin
entry left two sources for one setting with nothing to say which the build honours.
Deleting them changes no generated file: a clean `expo prebuild --platform android`
produces the same tree, sha256 for sha256, before and after. What that tree carries
is the plugin's own output — `splashscreen_background` is `#fbfaf9` in `values/` and
`#0e0b08` in `values-night/`, and `splashscreen_logo.png` is the product mark across
ten buckets, five densities and five night.

### Two phone-only decisions the desktop never had to make

**The dock band.** The dock floats above the canvas instead of sitting welded
to an edge. On a phone the scroller runs *under* the capsule and on into the
home-indicator strip, so a fully legible half-row would strand itself beneath
the dock and read as a clipping bug. `FadeOut` paints the reserved band —
transparent → `canvas`, solid from 55 % — across exactly the room every
`Scroller` already reserves. Content dissolves as it reaches the dock, which
is the truth: there is more, and it is behind the dock.

**The first-run gate.** The mail screens render only a live mirror. With
nothing paired the app opens into the welcome/connect flow; paired but
disconnected lands on the Servers screen with the reason in words and every
remedy (switch, re-pair, forget); the launch instant renders nothing at all,
so a paired phone never flashes the welcome screen on its way to mail. The
whole rule is one pure function (`src/state/gate.ts`) with its own tests.

---

## Screens

Five tabs, in a floating capsule dock rather than a bar welded to the bottom
edge — the desktop dock's shape, at thumb height.

| Route | What it is |
| --- | --- |
| `/welcome` | First run: what the app is, then straight into connecting. Shown only while nothing is paired. |
| `/` **Ohbox** | New / previously seen (+ a Resurfaced pin group), the Screener doorbell, routing rationale, tracker chips. Reading never moves the unread count. |
| `/screener` **Screener** | Three shelves (waiting · screened out · spam). A row shows an AI suggestion only where the server sent one — no classifier runs client-side. |
| `/sender/[seg]/[id]` | **The decision.** Every held message in full — each body hydrates and says so while it is still a snippet — then the bar: five destinations, each a split capsule whose ✓ half files *and* marks read. |
| `/reads` **Reads** | The skim stream. Scrolling past marks seen **in place**; leaving the screen commits the waterline, once per visit. |
| `/receipts` **Receipts** | Day groups, right-aligned tabular amounts, same scroll-seen rule, its own waterline. |
| `/message/[id]` | Reading view: why it landed here, what was blocked, the protected-OTP block, the conversation, triage actions. Opening marks read through the engine and asks for the full text — the pane says when it is still showing the preview. |
| `/servers` | The pairings this phone holds: switch, forget (which also revokes server-side), live sync status, and the three add choices. |
| `/scan`, `/connect` | The QR scan and the by-hand fallback. One parser, one redeem ceremony. |
| `/more` | The desktop rail's lower half: piles, the Folders group while "Use folders" is on, settings, the pairing door — and one honest sentence about search arriving later. |
| `/folder/[id]` | One of the mailbox's own folders: New / Earlier over the mirror's rows, with a tail that states what is on this phone rather than claiming the folder is empty. |
| `/triage` **Piles** | Answer Later · Parked · Resurface, counts derived from the items. |
| `/settings` | Appearance, the Use-folders switch (the server-confirmed answer, never an optimistic one), and an About block that names the build — `Version 0.16.1 (5)`, read from the app config the artifact embeds — then states what is live on this build and what is not. |

Light and dark throughout; reduced motion honoured; 44/48 pt touch targets;
every row and control carries an accessibility label.

---

## What is checked, not claimed

The app's test suite runs against every change in the development workspace;
the suites join this repository later, with the broader test-suite
publication. What they hold:

- **gate** — the first-run rule: nothing paired opens the connect flow, a
  paired phone boots to mail without a welcome flash, disconnected-with-a-
  pairing lands on Servers with the reason.
- **no-collapse** — a synthetic corpus is seeded into a real loopback server,
  synced through the real engine, and every identity the screens' selectors
  put on screen is enumerated at every depth (lists, day groups, held bags,
  conversations, pile items): nothing collapsed into an "and 3 more", nothing
  invented.
- **theme** — the OKLCH→sRGB port reproduces the recorded hexes byte for
  byte; the shadow ladder matches the token CSS layer for layer; no screen
  holds a colour literal.
- **privacy** — no banned term anywhere; network APIs appear only in the
  enumerated connection-seam files; nothing outside that seam imports the
  engine package; and no shipped source imports the sample-content package or
  carries inline sample mail — the app ships empty.
- **engine-boot / pairing / bearer / transitions / servers** — the real
  engine over the sqlite mirror against a live loopback server: snapshot
  bootstrap, delta polls, kill+relaunch rehydration with the cursor intact;
  the dead-sqlite refusal (never a silent memory mirror); the full pairing
  ceremony with its refusals; token rotation, 401/403-only judgment, and the
  serialized connection transitions.
- **live-screens** — the world layer against a real server: piles match
  a second client's, mark-read round-trips, decisions and releases rewrite
  the holding rules rather than issuing bare moves, sweep geometry never
  marks off-screen mail read.
- **body-hydration** — opening a message renders the message. The loopback
  server answers both body routes in the API's own shapes, and every case runs
  twice: over `node:sqlite`, whose batches are synchronous and can never
  interleave, and over a database with expo-sqlite's transaction semantics — a
  second connection per transaction, which is the one that can fail. The body
  has to be stored, not merely on screen: a case reopens the mirror in a new
  session and reads it back.
- **build-info** — the version line, per platform, and its agreement with the
  generated native project.

---

## The APK

`.github/workflows/android.yml` has two lanes:

- **Build check** — every push builds the release APK (signed with the
  generated debug keystore, installable for smoke-testing) and keeps it as a
  short-lived workflow artifact. Pull requests build the same way and never
  touch signing secrets.
- **Release** — pushing an `android-v*` tag builds the same APK, signs it
  with the project's release keystore (an Actions secret; forks cannot read
  it), verifies the signature, and attaches `ohmail-android.apk` to the
  GitHub release for that tag.

The release signature is a developer signature, not a store listing: Android
verifies updates against it, so an APK signed with a different key will not
install over an existing one. If the key is ever lost, the recovery is
uninstall/reinstall.

iOS ships no artifact yet. There is no sideload path on that platform, and a
store build needs an Apple Developer Program membership this project does not
hold. What *is* done is everything that does not need one: the bundle identifier
is the final `app.ohmail`, the version and build number are authored in
`app.json`, the Info.plist asks for the camera and nothing else, the privacy
manifest is declared, and the app icon is flattened for Apple's pipeline rather
than left to acquire white corners. `npx expo prebuild --platform ios` generates
the project on a Mac, and `npx expo config --type public` shows what it will
carry from any machine. The membership is the only thing between that and a
build — which is a real gap, not a formality, and it is not described here as
anything smaller than it is.
