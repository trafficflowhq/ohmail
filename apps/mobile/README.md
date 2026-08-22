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

- **Compose/reply, search, tags and attachment-open are not built yet.** No
  control for them renders; the More screen and the About block say they
  arrive with later updates.
- **ohmail.app (the managed service) does not offer device pairing yet.** The
  picker's managed card negotiates against the real server and reports what it
  answers — today, that pairing arrives with a later update. No date is
  promised.
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

## Stack, and why

| Decision | Reason |
| --- | --- |
| **Expo SDK 57** (React Native 0.86, React 19), managed workflow | No committed `ios/` or `android/` directory whose contents nobody reads; `expo prebuild` generates them when a native build needs them. |
| **Expo Router** | File-based routes give deep links (`ohmail://…`), which reach every screen. |
| **`@ohmail/client-engine` consumed live**, over an injected `SqlExecutor` | The engine is not forked for React Native. `src/engine/boot.ts` composes the same `OhmailEngine` every other client runs — `SqlMirrorStore` over expo-sqlite, uuid from expo-crypto, RN's own `fetch`, no EventSource (this build polls) — and a sqlite failure surfaces as a refusal, never a silent in-memory fallback. |
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
header and no log line. React Native's fetch has no secure-context gate and no
CORS, so a plain `http://192.168…` LAN door pairs and syncs exactly like an
https one — which is why the desktop's LAN pane says "browsers use Tailscale,
the mobile app uses LAN".

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

App icon, splash and the Android adaptive/monochrome layers are generated from
the product mark itself, not a redraw. The adaptive foreground keeps the mark
inside Android's 66dp safe circle (launchers mask the 108dp canvas), so the
icon renders at the size every other launcher icon does.

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
| `/more` | The desktop rail's lower half: piles, settings, the pairing door — and one honest sentence about search arriving later. |
| `/triage` **Piles** | Answer Later · Parked · Resurface, counts derived from the items. |
| `/settings` | Appearance, and an About block that states what is live on this build and names what is not. |

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

iOS builds in the simulator but ships no artifact: there is no sideload path,
and a store build needs an Apple Developer Program membership this project
does not hold yet. Nothing here pretends otherwise.
