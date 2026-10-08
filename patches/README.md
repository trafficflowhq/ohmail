# Patched dependencies

Every file here is a change to somebody else's package that we carry ourselves. Each one says what
it changes, why it could not be worked around from our side, and what would let us drop it.

## How a build gets them

The development workspace installs with pnpm, which applies every file here as it installs. The
published tree installs with `npm ci`, which applies nothing, so each build made from it (the
Android and desktop workflows, the Flatpak and the three self-host images) runs

```bash
node scripts/apply-patches.mjs apply
```

straight after the install. It applies each patch to every installed copy of its package with
`git apply`, and refuses by name when one does not apply: a patch naming a version the tree does
not hold, a hunk whose surroundings changed, no patches at all, or no git. A copy that already
reads as the patch's result, because a newer upstream release took the same change, is named as
carrying it; git proves that by applying the patch in reverse.

The builds then check what they made, not what they installed. `apply-patches.mjs markers` prints
the string literals each patch adds, and `apply-patches.mjs assert --in <file or directory>
--require <package>` refuses bytes that hold the package (an upstream literal it always carries)
without every one of them. The three engine bundlers run it over the bundle they write, the
Android workflow over the APK's dex, the desktop workflow over the packaged engine, and the image
workflow over the bundle inside each image. The markers are read out of the patch, so a changed
patch moves them with it. Literals in Apple sources are listed apart (`apple` in `markers`,
`appleMarkers` in `--json`) and never asked of a dex or a bundle: no workflow here builds for iOS.
The three patches that touch only Apple sources add no literal.

## `react-native-tcp-socket@6.4.2`

MIT, so it may be modified and redistributed in an AGPL program. Upstream:
<https://github.com/Rapsssito/react-native-tcp-socket>.

This is the TCP and TLS transport a phone's mail engine dials over. Two defects in its **Android**
half made it unusable for mail; its iOS half has neither and is untouched.

**1. TLS validated the chain and not the name.** `TcpSocketClient.connect` built the secure socket
with the no-argument `createSocket()` and then connected it by address, so the socket had no peer
name: no SNI went out, and nothing checked the certificate against the host the caller asked for.
Nothing anywhere set `setEndpointIdentificationAlgorithm` or a hostname verifier. Measured against a
real provider: dialling the server by its IP, with a certificate carrying 35 DNS names and no IP,
authenticated successfully — where the same code on a desktop refuses with
`Hostname/IP does not match certificate's altnames`. A mail client whose TLS accepts any valid
certificate for any name hands the password to whoever answers.

The patch connects a plain socket first and layers TLS over it with the name the caller asked for,
turns endpoint identification on for every TLS socket, honours a `minVersion` option by filtering
the ENABLED protocols (the platform has no option of that name, so a caller's floor was otherwise
discarded in silence — and filtering the SUPPORTED list instead, which an earlier version of this
patch did, turns an option that may only narrow into one that switches TLS 1.0 and 1.1 back on),
and stops `rejectUnauthorized: false` from selecting a trust-nothing factory
— options may ADD a root and may not take the default checks away.

**2. STARTTLS could not work at all.** `startTLS` layered a secure socket over the live connection
while the receiver thread was still inside a blocking read on the same stream, so the two raced for
the server's first handshake record and the handshake lost — `SSLException: Unable to parse TLS
packet header`. It could not be worked around from JavaScript: the class exposes `pause()`, but the
loop checked that flag only AFTER an unbounded read, and it held a buffered reader bound to the
plaintext socket that it never re-opened after the swap, so even a perfect pause would have gone on
reading plaintext past the handshake.

The patch bounds the receive so a pause takes effect promptly, waits for the reader to leave its
read before the handshake, re-opens the stream on the socket that replaced the old one, and gives
the handshake a deadline of its own — sharing the receive poll with it made every real-network dial
fail with `Read timed out`, a message naming neither TLS nor the poll it came from.

**3. A client identity disabled certificate checking.** Supplying `key`/`cert` or a keystore alias
selected a factory that installed a trust manager accepting every chain. A client certificate says
who WE are; it has no bearing on who the server may be, and conflating the two meant an option about
our own credentials silently switched off every check on theirs. Endpoint identification does not
rescue it either: hostname verification is performed BY the trust manager, and only the extended
interface receives the socket carrying that request — installing a plain one quietly undoes it while
every other line still reads as if TLS were verified. The blind manager is deleted outright, a
supplied `ca` now ADDS an anchor to the platform's rather than replacing them, and the manager is
extended so the name is checked.

**4. The minimum protocol version could raise nothing and lower something.** It filtered the
SUPPORTED protocol list, but the platform supports TLS 1.0 and 1.1 and deliberately does not enable
them — so a floor of `TLSv1` switched two dead protocols back on. An unrecognised value applied no
floor at all: the caller asks for more protection and silently receives less. It is now the
intersection of what is already enabled with what the caller will accept, and an unknown value or an
empty result is a refusal.

**5. A failed upgrade left a live cleartext socket.** The caller has already sent STARTTLS and
believes the next byte is encrypted, so anything written afterwards goes out in the clear. A failed
upgrade now closes the connection. Alongside it: the receiver's pause moved inside the `try` (giving
up used to leave it paused for the life of the process — a connection open, silent, and never
delivering again), flow-control `resume()` defers while an upgrade is in flight, and plaintext
still sitting UNREAD ON THE SOCKET when the upgrade begins is treated as injected and refuses the
upgrade.

That last one is narrower than it first read here, and the boundary is worth stating exactly:
`available()` reports what the socket still holds, so it says nothing about bytes that have already
been delivered upward into a protocol parser. Those are invisible from this layer by construction.
The mail-sending client is patched separately for that half — it refuses the upgrade when its own
parser is holding a response, or a fragment of one, that arrived alongside the server's go-ahead.

**6. The upgrade's pause had a window, and flow control could lift it.** A second review found the
receiver checking "am I paused" and marking "I am reading" as two operations, so an upgrade could
see an idle reader between them and start a handshake the reader then consumed the first record of.
The two pause reasons — flow control's and the upgrade's — now live under one monitor, waiting and
marking are a single synchronized step, and `resume()` can no longer reach the upgrade's pause at
all. The interlock boolean that narrowed that window is gone with it.

**7. The floor now checks itself.** Filtering the SUPPORTED protocol list instead of the ENABLED one
re-enables versions the platform switched off, and NO dial can reveal it — a handshake with any
modern server still negotiates the best version both sides offer. So after applying the floor the
code re-reads the enabled set and throws if anything below it survived. On a platform that no longer
supports those versions the check is inert; it exists for the platforms that do.

**8. The peer certificate was read as RSA whatever its key.** `getCertificateInfo` cast the key to
`RSAPublicKey`, so a server with an ECDSA certificate made `getPeerCertificate` reject, and the
STARTTLS confirmation reads the peer certificate to know the handshake finished. The key is now
read by its type: RSA keeps its three fields, EC reports its size and the NIST curve names node's
`tls` reports, any other key reports neither. A guard in the development workspace runs the method
on a JVM over RSA, the three NIST curves and Ed25519, and again with upstream's cast put back.

**How to verify a build actually carries this, and why that needs saying.** The package manager keeps
more than one copy of a patched module in its store, and Android autolinking compiled a copy the
patch had not reached — six device checks passed against a build whose Java was upstream's. Editing
the module inside `node_modules` has the same shape: the edit lands in the copy the JavaScript
resolver sees, not the one Gradle compiles. Gradle's build cache then restores the stale class even
after the module's build directory is deleted, so a successful build proves nothing.

Change this patch by re-running `pnpm patch` and `pnpm patch-commit` — never by editing
`node_modules` — then rebuild with `--no-build-cache`, and check the artifact: the literals this
patch introduces must be in the APK's dex, which is what the Android workflow's
`apply-patches.mjs assert` step reads before any APK or bundle is uploaded.

**What would let us drop this:** upstream taking these changes. They are independent of anything
specific to this program, and every one of them is a correctness fix for any user of the library.

## `expo-image-picker@57.0.19`

MIT (Expo). Upstream: <https://github.com/expo/expo/tree/main/packages/expo-image-picker>.

This is the system photo picker the phone's composer opens for **Attach a photo**. Its iOS half
decided what a picked item was in this order: ask `NSItemProvider.canLoadObject(ofClass:
PHLivePhoto.self)`, THEN read whether the caller had asked for live photos. On the iOS 27.1 beta
that probe throws inside the Photos framework (`+[PHLivePhoto readableTypeIdentifiersForItemProvider]`
builds an array with a nil entry), Swift has no catch for an Objective-C exception, and the app aborts
— measured on the iPhone Duo simulator on 2026-09-21: one photo picked, SIGABRT via `std::terminate`,
the composer and its text gone.

It could not be worked around from our side: the composer already asks for `["images"]` alone, and
the probe ran before that option was read. The patch is upstream's own fix (expo/expo#50435),
carried here because it is unpublished for SDK 57: the option is read first, and the live-photo
question is asked of the registered type identifier (`UTType.livePhoto`) rather than of the class.
iOS-only by nature — the Android half has no such probe.

A test in the development workspace asserts the composer's options, the patch's own hunk, and
that the store copy autolinking resolves carries it with no pristine copy beside it.

**What would let us drop this:** a published `expo-image-picker` 57.x carrying #50435, or the move
to the SDK that ships it.

## `nodemailer@6.10.1`

MIT. Upstream: <https://github.com/nodemailer/nodemailer>.

This is the SMTP client the mail engine sends with: the desktop engine, the phone's engine and
both self-host hosts bundle it. Its STARTTLS upgrade did not look at what was still unread when
the server said to go ahead. A server may send nothing between its `220` and the client's
handshake, so a second response waiting in the queue, or a partial line, was written by somebody
who is not the server; it would be read back after the handshake and answered as though it had
arrived encrypted. For the AUTH stage that reply is the credentials.

The patch refuses the upgrade when anything is queued or buffered at that moment. The IMAP client
in this program already refused on the same condition; this is the sending half. It complements
section 5 of the transport patch above, which sees the bytes still on the socket and cannot see
the ones already handed to this parser.

It could not be worked around from our side: the queue and the buffered remainder are the
connection's private state, read inside `_upgradeConnection` just before the socket is swapped,
and nothing outside the class sees that moment.

**What would let us drop this:** upstream refusing the upgrade on the same condition.

## `expo-sqlite`

MIT (Expo). Upstream: <https://github.com/expo/expo/tree/main/packages/expo-sqlite>.

The phone's local mirror is an SQLite file opened through this module. Its **iOS** half built the
database's URL with `URL(string:)`, which treats a filesystem path as a URL string: it
percent-encodes a space and answers a non-file URL whose `toFilePath()` is the encoded string. So
for any container whose path holds a space, sqlite was handed `/…/a%20b/…/x.db` and could not
open it, and the directory the module created was the encoded one. Every simulator run on a Mac
whose home sits on a volume with a space in its name reaches that path.

The patch keeps `URL(string:)` as the validation it can be and builds the URL it hands onward
with `URL(fileURLWithPath:)`, in both the sqlite and the libsql module. Accepted inputs are
unchanged. The container's path is the system's, so no choice on our side avoids the space.

Unversioned: pnpm applies it to whichever version is installed, and so does the applier.

**What would let us drop this:** upstream building the file URL from the path.

## `expo-modules-jsi`

MIT (Expo). Upstream: <https://github.com/expo/expo>.

Apple sources only: `JavaScriptCodable+Date.swift` calls `abs(milliseconds)` on a `Double`, which
the Swift 6.2 compiler reads as ambiguous, so the iOS build cannot get past it. The patch is
upstream's own one-line change, `milliseconds.magnitude`: the same value, one overload.

The development workspace holds 57.0.4, where the file still reads `abs(…)`. Release 57.1.1 took
the same change upstream, so a tree that installs it (the published tree's npm resolution can)
is reported as already carrying this patch rather than refused.

**What would let us drop this:** a release past 57.0.4 that also builds under the current Swift.
57.0.8 and later change `RuntimeScheduler.h` in a way that fails worse here, so the version is not
the fix yet.

## `react-native-webview@13.16.1`

MIT. Upstream: <https://github.com/react-native-webview/react-native-webview>.

The phone draws an html message in a WebView with JavaScript off, so the document cannot measure
itself. Without its height the view gets a guessed one and scrolls inside it, and a drag that
starts on the message moves that box instead of the reader around it. The patch reports the
document's own height to JavaScript through the `onScroll` event the library already has:
`contentSize.height` is the document height whenever it changes. Android sends it on the draw that
changes `getContentHeight()`, which is the document in CSS pixels; `computeVerticalScrollRange()`
is not used, because during a resize it reads about twice the document. iOS observes the web
view's `scrollView.contentSize` and sends the same event whether its scrolling is enabled or not.
Both send it again after the view is resized, so a resize is always answered with a reading. No
event or property is added, so the generated component spec is unchanged.

The Android literal `ohmail-webview-document-height` is what the Android workflow reads in the
dex. The iOS half's literal, `ohmail-webview-document-height-ios`, is the observer's KVO context, for
a Pods build guard to read once there is an iOS build here; that half has not been measured on a
device yet.

**What would let us drop this:** upstream reporting the document height natively, or the reader
drawing html mail without a WebView.
