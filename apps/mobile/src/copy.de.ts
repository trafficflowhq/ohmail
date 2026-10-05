/**
 * Der Kopie-Satz des Telefons auf Deutsch — the phone's copy deck, in German. `Deck` is derived
 * from the English table in `copy.en.ts`, so shape is compiler-checked: a missing key, an extra
 * key or a differing parameter list is a build error; `test/copy-parity.test.ts` adds what a
 * type cannot see. The vocabulary is not invented here: `apps/webapp/messages/de.json` settled
 * it — Ohbox, News, Screener, Spam, Tag, paper and ohmarchy stay; Receipts is Belege, screened
 * out is aussortiert, Park is Parken/Geparkt, Trash is the Papierkorb. Where the phone shares a
 * whole sentence with the web client, this deck carries its German byte for byte. Register: Du,
 * never Sie; plain statements, no slogans. Plurals are a ternary on the number.
 */

import type { BackupExclusion } from "./engine/backup-exclusion";
import { isPinFailure } from "./net/host-pinning";
import type { Deck } from "./copy.en";

const BOOT_MIGRATING = "Der Postspeicher auf diesem Telefon wird aktualisiert…";

/** Hoisted for the same reason its English twin is — see `copy.en.ts`. */
const PIN_CHANGED =
  "Die Identität dieses Computers hat sich geändert, seit du dich mit ihm gekoppelt hast, deshalb "
  + "hat ohmail angehalten, statt ihm zu vertrauen. Wenn du ohmail auf diesem Computer neu "
  + "installiert oder aus einem Backup wiederhergestellt hast, öffne dort Einstellungen → Geräte "
  + "und koppele dieses Telefon mit einem frischen Code erneut. Wenn nicht, antwortet etwas in "
  + "deinem Netz an seiner Stelle.";

export const DE: Deck = {
  /* --------------------------------------------------------------- welcome */

  welcomeTitle: "Welches Postfach ist das?",
  welcomeLead:
    "Was deine Post organisiert, muss laufen — ein Computer, ein Server oder dieses Telefon, solange ohmail offen ist. Deine Post bleibt auf deinem Mailserver.",

  /* ------------------------------------------------------------------ doors */

  doorsLead: "Eine Frage, vier Antworten — welcher Rechner organisiert?",
  doorsHead: "Was deine Post organisiert",

  doorCloud: "ohmail Cloud",
  doorCloudSay:
    "Unser gehosteter Dienst organisiert; dieses Telefon hält eine Kopie. Melde dich im Web an, öffne Einstellungen → Geräte und scanne den Code, den es zeigt.",

  doorOwnServer: "Dein eigener Server",
  doorOwnServerSay:
    "Ein Server, den du betreibst, organisiert; dieses Telefon hält eine Kopie. Gib seine Adresse an, und diese App prüft, was dort ist.",

  doorDesktop: "Dein eigener Computer",
  doorDesktopSay:
    "Die ohmail-App auf deinem Computer organisiert; dieses Telefon hält eine Kopie. Öffne dort Einstellungen → Geräte und scanne den Code.",
  doorDesktopNoPin:
    "Nimm auf diesem Telefon die Tailscale-Adresse, die dieselbe Ansicht zeigt — ohmail kann einen Computer, der über dein eigenes Netz erreicht wird, hier noch nicht prüfen.",

  /* Die vierte Tür — see the English deck's note. The third line is the one platform fork on
     any of these screens; both sentences live in both decks. */
  doorPhone: "Eigenständig auf diesem Telefon",
  doorPhoneSay: "Dein Postfach, auf diesem Telefon organisiert.",
  doorPhoneNeedIos:
    "Nur solange die App offen ist. Wenn du sie verlässt, gibt sie das Postfach zurück.",
  doorPhoneNeedAndroid:
    "Nur solange die App offen ist — oder im Hintergrund hinter einer sichtbaren Benachrichtigung.",

  doorsTravel:
    "Du kannst jederzeit wechseln. Deine aussortierten Absender, deine Regeln und deine Benachrichtigungseinstellungen liegen in deinem eigenen Postfach und sind hinter jeder Tür dieselben — das Postfach ist immer das Original.",

  /* ------------------------------------------------- the self-hosted door */

  doorSelfTitle: "Dein eigener Server",
  doorSelfLead:
    "Gib die Adresse an, unter der du ohmail im Browser öffnest. Diese App prüft, ob dein Server dort ist, bevor sie irgendetwas anderes tut.",
  doorSelfAddress: "Die Adresse deines Servers",
  doorSelfAddressHint: "Zum Beispiel ohmail.example.com — nichts hinter dem Host.",
  doorSelfAddressPlaceholder: "ohmail.example.com",
  doorSelfGo: "Weiter",
  doorSelfChecking: "Dein Server wird geprüft…",
  doorSelfCert:
    "Dein Server braucht ein https-Zertifikat von einer Stelle, der dieses Telefon schon vertraut. "
    + "Ein Server auf einem öffentlichen Namen bekommt eines automatisch. Ein Server auf einem "
    + "privaten Namen wie ohmail.test stellt sich sein eigenes aus, und ob dieses Telefon das "
    + "akzeptiert, hängt vom Telefon ab: Auf Android nicht — ohmail vertraut nur den Stellen, die "
    + "mit dem System gekommen sind, eine selbst installierte Wurzel ändert also nichts — während "
    + "auf iPhone und iPad eine Wurzel zählt, die du installierst und unter Einstellungen → "
    + "Allgemein → Info → Zertifikatsvertrauenseinstellungen einschaltest. Ein öffentlicher Name "
    + "oder eine Tailscale-Adresse funktioniert auf beiden.",
  doorSelfReached: (origin: string, flavor: string) =>
    `${origin} erreicht — ein ohmail-Server (${flavor}).`,
  doorSelfApiUnder: (base: string) => `Seine Mail-API liegt unter ${base}.`,

  /* ------------------------------------------------ the standalone door */

  /* Die drei gesetzten Sätze — see the English deck. The iPhone sentence says the mailbox is
     handed back and never promises the background; that is the ruling, not a shortening. */
  phoneStandaloneTitle: "Auf diesem Telefon organisieren",
  phoneStandaloneL1Ios:
    "Es organisiert, solange ohmail geöffnet ist. Wenn du die App verlässt, gibt es das Postfach zurück.",
  phoneStandaloneL1Android:
    "Es organisiert, solange seine Benachrichtigung angezeigt wird. Wische sie weg, um zu stoppen.",
  phoneStandaloneL2: "Ein Postfach auf diesem Telefon.",
  phoneStandaloneL3:
    "Dein Mailserver behält alles. Nichts hier ist eine Kopie, die du verlieren könntest.",
  phoneStandaloneGo: "Weiter",
  phoneStandaloneBack: "Anders wählen",

  /* Jedes Feldlabel ist das des Web-Katalogs, Byte für Byte. */
  phoneStandaloneFormTitle: "Dein eigenes Postfach",
  phoneStandaloneFormLead:
    "Dieses Telefon verbindet sich direkt mit deinem Mailserver. Dein Passwort liegt auf diesem Telefon, verschlüsselt mit einem Schlüssel aus seinem Schlüsselspeicher, und geht nie an uns.",
  phoneStandaloneAddress: "Postfachadresse",
  phoneStandalonePassword: "Postfachpasswort",
  phoneStandaloneShowPassword: "Passwort zeigen",
  phoneStandaloneHidePassword: "Passwort verbergen",
  phoneStandaloneAdvanced: "Servereinstellungen",
  phoneStandaloneImapHost: "Posteingangsserver (IMAP)",
  phoneStandaloneImapPort: "IMAP-Port",
  phoneStandaloneImapTls: "Implizites TLS",
  phoneStandaloneImapTlsHint:
    "Ein bedeutet Port 993. Aus bedeutet Port 143, der per STARTTLS verschlüsselt wird. Wenn du den Port änderst, wandert dieser Schalter mit.",
  phoneStandaloneSmtpHost: "Postausgangsserver (SMTP)",
  phoneStandaloneSmtpPort: "SMTP-Port",
  phoneStandaloneConnect: "Verbinden",
  phoneStandaloneConnecting: "Postfach wird geöffnet…",
  phoneStandaloneUseHost: (host: string) => `${host} nehmen`,
  probeTlsHostname: (certHost: string, expectedHost: string, protocol: string) =>
    `Das Zertifikat dieses Servers gilt für ${certHost}, nicht für ${expectedHost}, wir haben also abgebrochen, bevor das Passwort rausging. Frag deinen Anbieter nach dem richtigen ${protocol}-Server.`,
  probeTlsHostnameSuggest: (certHost: string, expectedHost: string, suggestedHost: string, protocol: string) =>
    `Das Zertifikat dieses Servers gilt für ${certHost}, nicht für ${expectedHost}, wir haben also abgebrochen, bevor das Passwort rausging. Er antwortet auf ${suggestedHost} — nimm das als ${protocol}-Server.`,

  /* Die fünf Zustandslabels sind die des Desktops, Byte für Byte. */
  phoneThisPhone: "Dieses Telefon",
  phoneStateOrganizing: "Organisiert",
  phoneStateStopping: "Wird beendet",
  phoneStateStopPending: "Stopp ausstehend",
  phoneStateStopPendingWhy: "Ein Stopp steht bereits aus; es wartet auf das Postfach.",
  phoneStateStopSiblingLapse: "Eine andere Kopie dieses Telefons hält den Anspruch auf das Postfach noch; der Stopp endet, wenn dieser Anspruch verfällt.",
  /* Ohne Desktop-Zwilling: nur auf dem Telefon kann ein Start hinter einem Stopp warten. */
  phoneStateStarting: "Wird gestartet",
  phoneStateNotOrganized: "Dieses Postfach wird von nichts organisiert",
  /* Der Übergangszustand: zurückgegeben und noch nicht wieder übernommen. */
  phoneStateHandedBack: "Zurückgegeben",
  phoneStateHandedBackWhy: "Ein anderer Computer kann dieses Postfach jetzt übernehmen.",
  phoneStateParked: "Pausiert, während das Konto geschlossen war — das Organisieren läuft von selbst wieder an",
  phoneStateReader: (name: string) => `Organisiert von ${name}`,
  phoneStateReaderLegacy: "Organisiert von einer anderen Installation",
  /* Der normale gekoppelte Zustand. Es wird keine Maschine genannt, weil keine auf der Leitung
     steht — der antwortende Server organisiert selbst —, und der Server heißt hier nicht
     "ohmail Cloud": dieses Telefon kann ebenso mit einem selbst gehosteten Server gekoppelt sein. */
  phoneStatePairedServer: "Organisiert vom gekoppelten Server",
  phoneStatePairedServerWhy:
    "Er organisiert dieses Postfach, ob ohmail auf diesem Telefon offen ist oder nicht. Dieses "
    + "Telefon liest es; es verschiebt nichts und sortiert nichts aus.",
  /* Der zweite Satz ist `mailboxes.readerReadsOnly` aus dem Web-Katalog, mit "dieses Telefon"
     statt "dieser Computer"; die Telefon-Variante folgt `blocked_organized_elsewhere_mobile`. */
  phoneStateReaderWhy: (name: string) =>
    `${name} organisiert dieses Postfach. Dieses Telefon liest es; es verschiebt nichts und sortiert nichts aus.`,
  phoneStateReaderWhyPhone: (name: string) =>
    `${name} organisiert dieses Postfach, und ein Telefon organisiert nur, solange ohmail darauf offen ist. Dieses Telefon liest es; es verschiebt nichts und sortiert nichts aus.`,
  phoneStateReaderWhyUnnamed:
    "Eine andere Installation organisiert dieses Postfach. Dieses Telefon liest es; es verschiebt nichts und sortiert nichts aus.",
  phoneStateReaderWhyUnnamedPhone:
    "Ein anderes Telefon organisiert dieses Postfach, und ein Telefon organisiert nur, solange ohmail darauf offen ist. Dieses Telefon liest es; es verschiebt nichts und sortiert nichts aus.",
  settingsStopHere: "Hier nicht mehr organisieren",
  settingsStopHereWhat:
    "Dieses Telefon sortiert dieses Postfach nicht mehr ein und liest es weiter. Deine Ordner und alles darin bleiben, wo sie sind. Danach kann jede Installation es übernehmen, auch diese.",
  settingsStopHereConfirm: "Postfach zurückgeben",
  settingsStopHereCancel: "Weiter organisieren",
  settingsStartHere: "Hier organisieren",
  settingsStartHereFailed:
    "Dieses Telefon konnte dieses Postfach nicht zu organisieren beginnen. Nichts hat sich geändert. Versuche es in einem Moment noch einmal.",
  settingsStopHereFailed:
    "Dieses Telefon konnte dieses Postfach nicht zurückgeben und organisiert es weiter. Versuche "
    + "es in einem Moment noch einmal.",
  settingsStopLeftOther:
    "Die Einstellungen dieses Telefons sind auf diesem Telefon geblieben: Das Postfach enthält Einstellungen aus einem neueren ohmail, die dieses nicht lesen kann.",
  settingsStopLeftUnsaved:
    "Die Einstellungen dieses Telefons konnten nicht im Postfach gespeichert werden und sind nur auf diesem Telefon.",
  /* Ein Blick, der nicht angekommen ist — eigener Satz, nicht der darüber: hier ist auf diesem
     Telefon nichts schiefgegangen, das Postfach konnte nur nicht gefragt werden. */
  settingsStartHereUnreadable:
    "Dieses Telefon konnte nicht lesen, ob ein anderer Computer dieses Postfach organisiert. Nichts hat sich geändert. Versuche es noch einmal.",
  /* Die Sätze der Desktop-Zeile, Wort für Wort (`sync.blocked_meta_*`). */
  phoneStateMetaFolderFull:
    "Wird nicht synchronisiert — der Ordner ohmail/_meta auf diesem Server enthält mehr Nachrichten, als ohmail lesen kann. Verschiebe dort abgelegte Mails in einen anderen Ordner und lass die Nachrichten von ohmail stehen (ihr Betreff beginnt mit „ohmail“). ohmail macht dann von selbst weiter.",
  phoneStateMetaUndeletable:
    "Wird nicht synchronisiert — der Mailserver lässt ohmail seine eigenen Nachrichten in ohmail/_meta nicht entfernen. Gib diesem Ordner die Berechtigung zum Löschen oder frag deinen Anbieter. ohmail macht dann von selbst weiter.",

  /* Die Absagen der eigenständigen Tür. Keine davon trägt je das Passwort. */
  standaloneNoEngine:
    "Dieser Build kann auf diesem Telefon kein Postfach organisieren. Verbinde es stattdessen mit einem Computer, einem Server oder ohmail Cloud.",
  standaloneNoHost: "ohmail braucht deinen Posteingangsserver (IMAP). Gib seine Adresse an.",
  standaloneNoSmtpHost: "ohmail braucht deinen Postausgangsserver (SMTP). Gib seine Adresse an.",
  standaloneNoPort: "Der IMAP-Port ist eine ganze Zahl von 1 bis 65535.",
  standaloneNoSmtpPort: "Der SMTP-Port ist eine ganze Zahl von 1 bis 65535.",
  standaloneSignInRefused:
    "Dein Mailserver hat diese Adresse und dieses Passwort nicht akzeptiert. Prüfe beides und versuche es erneut — es wurde nichts gespeichert.",
  standaloneNoEncryption:
    "Dein Mailserver bietet auf diesem Port keine verschlüsselte Verbindung, und ohmail sendet dein Passwort nicht im Klartext. Versuche Port 993 in den Servereinstellungen.",
  standaloneCertificateRefused:
    "Dieses Telefon hat das Zertifikat deines Mailservers nicht akzeptiert, ohmail hat also abgebrochen, bevor das Passwort rausging. Prüfe mit deinem Anbieter den Namen des Posteingangsservers.",
  /* Auch der Postausgangsserver wird beim Verbinden gewählt, und jede seiner drei Antworten nennt ihn. */
  standaloneSmtpSignInRefused:
    "Dein Postausgangsserver (SMTP) hat diese Adresse und dieses Passwort nicht akzeptiert. Prüfe ihn und versuche es erneut — es wurde nichts gespeichert.",
  standaloneSmtpNoEncryption:
    "Dein Postausgangsserver (SMTP) bietet auf diesem Port keine verschlüsselte Verbindung, und ohmail sendet dein Passwort nicht im Klartext. Versuche Port 465 oder 587.",
  standaloneSmtpUnreachable:
    "ohmail hat deinen Postausgangsserver (SMTP) unter dieser Adresse und diesem Port nicht erreicht. Prüfe beides und versuche es erneut — es wurde nichts gespeichert.",
  standaloneRefused: (detail: string) =>
    `Das Öffnen des Postfachs wurde abgebrochen: ${detail}`,
  /* Die drei des Neustarts. Jede benennt ein anderes Fehlen. */
  standaloneNoSealedCredential:
    "Auf diesem Telefon ist nichts gespeichert, womit sich dieses Postfach öffnen ließe. Nimm die Tür noch einmal und gib das Passwort des Postfachs an.",
  standaloneOtherMailbox:
    "Das Postfach auf diesem Telefon ist nicht das, welches dieser Eintrag nennt. Entferne den Eintrag und öffne das Postfach erneut.",
  standaloneNotStored: (detail: string) =>
    `Dieses Telefon konnte das gerade geöffnete Postfach nicht speichern: ${detail}. Es wurde `
    + "wieder geschlossen und nichts behalten — versuch Verbinden noch einmal.",
  standaloneAlreadyOpen:
    "Dieses Telefon hat schon ein Postfach geöffnet. Entferne es unter Server, bevor du ein "
    + "anderes öffnest.",
  /* Die zwei des Entfernungsgurts. Keine nennt das entfernte Postfach — der Vermerk trägt nur eine Kennung. */
  standaloneMailboxRemoved:
    "Dieses Postfach wurde von diesem Telefon entfernt, und der Rest davon wurde soeben gelöscht. Öffne wieder ein Postfach, um zu beginnen.",
  standaloneRemovalUnfinished: (detail: string) =>
    `Ein von dir entferntes Postfach ist noch teilweise auf diesem Telefon (${detail}), deshalb `
    + "öffnet ohmail kein anderes darüber. Starte ohmail neu, um die Löschung abzuschließen.",
  /* Der Einwilligungs-Aufruf. Keine dieser Zeilen behauptet, das Telefon organisiere gerade. */
  organizeHereUnreachable: (detail: string) =>
    `ohmail konnte nicht darum bitten, dieses Postfach zu organisieren: ${detail}`,
  organizeHereUnreadable:
    "Die Antwort zum Organisieren dieses Postfachs war nicht lesbar, es wurde nichts gespeichert. Zieh zum Aktualisieren, um erneut zu fragen.",
  organizeHereDisconnected:
    "Dieses Postfach ist ausgeschaltet, ohmail sortiert es nicht ein. Verbinde es wieder, dann übernimmt ohmail von dort.",
  organizeHereStillLooking:
    "ohmail konnte nicht prüfen, ob ein anderer Computer dieses Postfach hat — vielleicht verbindet es sich noch. Es wurde nichts gespeichert; versuch es gleich noch einmal.",
  organizeHereRefused: (status: number) =>
    `Das Organisieren dieses Postfachs wurde abgelehnt (${status}). Vielleicht hält es eine andere Maschine — sieh in den Einstellungen nach, was es organisiert.`,
  organizeStartFailed: (detail: string) =>
    `Das Organisieren hat nicht begonnen: ${detail}. Dieses Telefon hat das Postfach zurückgegeben, `
    + "ein anderer Computer kann es also übernehmen, und es versucht es beim nächsten Öffnen von "
    + "ohmail erneut.",

  /* --------------------------------------------------- servers & pairing */

  serversTitle: "Server",
  serversRow: "Mit einem Server verbinden",
  serversNote:
    "Koppele dieses Telefon mit dem Computer oder Server, auf dem deine Post liegt. Gekoppelt wird über einen QR-Code oder einen kurzlebigen Token, und dafür wird kein Passwort eingetippt.",
  serversActive: "Verbunden",
  serversProfiles: "Gekoppelte Server",
  /* Die eigene Zeile des Telefons in der Liste. Sie benennt, was der Eintrag IST, und verspricht
     nichts über den Augenblick — siehe die englische Fassung. */
  serversOrganizedHere: "Das Postfach, das dieses Telefon selbst geöffnet hat.",
  serversStopHere: "Beenden und entfernen",
  serversForget: "Vergessen",
  serversForgetNote:
    "Vergessen löscht die Kopplung und die Post, die dieses Telefon kopiert hatte. Über die Geräteliste des Servers lässt sie sich auch dort widerrufen. Wer ein Postfach auf dem Server selbst entfernt, kann dort auch die Kopie seiner Post bei ohmail löschen.",
  /* Dieselbe Notiz, wo es keinen Server gibt — siehe die englische Fassung. */
  serversForgetNoteHere:
    "Entfernen gibt das Postfach zurück, ohmail sortiert es hier nicht weiter ein, und die Post, die dieses Telefon kopiert hatte, wird gelöscht. Das Postfach auf deinem Mailserver bleibt unberührt.",
  serversForgetFailed: (reason: string) => reason,
  serversEmpty: "Noch keine Kopplungen.",
  serversInstallUnknown: (detail: string) =>
    "ohmail konnte nicht prüfen, ob dies dieselbe Installation ist, die deine Anmeldungen "
    + `gespeichert hat (${detail}), und hat sie deshalb nicht geöffnet — entfernt hat es sie aber `
    + "auch nicht. Starte die App neu, um es erneut zu versuchen.",
  serversPurgeRefused: (detail: string) =>
    "Dieses Telefon hält noch Anmeldungen aus einer früheren Installation von ohmail, und es "
    + `wollte sie nicht hergeben (${detail}). ohmail wird sie nicht öffnen. Widerrufe dieses Gerät `
    + "in der Geräteliste deines Servers und starte die App dann neu.",

  askAddress: "Serveradresse",
  askAddressHint: "Die https-Adresse, die die Desktop-App unter Einstellungen → Geräte zeigt",
  askGo: "Diese Adresse prüfen",
  askChecking: "Der Server wird gefragt, was er ist…",
  stepScan: "Seinen QR-Code scannen",
  stepManual: "Kopplungstoken eingeben",
  stepPairOffered: (flavor: string) => `Das ist ein ohmail-Server (${flavor}), und er koppelt Geräte.`,
  managedDeferred:
    "ohmail.app bietet gerade keine Gerätekopplung an — das sagt seine eigene Beschreibung. Hier ist heute nichts zu tun.",
  noPairing: "Dieser Server bietet keine Gerätekopplung an.",
  notOhmail: "Diese Adresse antwortet, aber nicht als ohmail-Server.",
  /* Die Ursache wird nach Form erkannt (`unreachableClause`); eine unerkannte endet nach dem
     Punkt — der Wortlaut der Plattform gehört nicht in einen Satz für Menschen. */
  unreachable: "Diese Adresse war nicht erreichbar.",
  unreachableWhy: (clause: string) => `Diese Adresse war nicht erreichbar. ${clause}`,
  unreachableDns: "Dieser Name wurde nicht aufgelöst — prüfe die Adresse auf einen Tippfehler.",
  unreachableRefused: "Die Adresse wurde aufgelöst, aber auf diesem Port antwortet nichts.",
  unreachableTimeout: "Es kam keine Antwort in der vorgesehenen Zeit.",
  notEncrypted:
    "ohmail konnte zu dieser Adresse keine verschlüsselte Verbindung aufbauen und hat "
    + "deshalb nichts gesendet. Meist antwortet der Server auf dem angegebenen Port "
    + "unverschlüsselt über http — ohmail koppelt nur über https.",

  scanTitle: "Kopplungs-QR scannen",
  scanHint: "Richte die Kamera auf den QR-Code, den dein Computer oder Server zeigt.",
  scanBadCode: "Kein ohmail-Kopplungscode. Der QR-Code steht auf dem Bildschirm „Geräte“.",
  scanCameraOff: "Der Kamerazugriff ist aus, es gibt also nichts zum Scannen.",
  scanAllow: "Kamera erlauben",
  scanManual: "Stattdessen von Hand eingeben",
  scanAgain: "Erneut scannen",

  /* ── DIE BESTÄTIGUNG, BEVOR EIN CODE EINGELÖST WIRD ────────────────────────────────────────
     Siehe `copy.en.ts` für die Begründung. */
  pairConfirmTitle: "Dieses Telefon koppeln?",
  pairConfirmLead:
    "Einen Code kann man nicht mit dem Auge lesen \u2014 prüfe darum, was geantwortet hat, "
    + "bevor er eingelöst wird.",
  pairConfirmWhatLabel: "Was geantwortet hat",
  pairConfirmWhat: (flavor: string) =>
    flavor === "local" || flavor === "desktop-host"
      ? "Die ohmail-App auf einem Computer"
      : flavor === "selfhost"
        ? "Ein ohmail-Server"
        : flavor === "managed"
          ? "Der gehostete ohmail-Dienst"
          : `Ein ohmail-Server (${flavor})`,
  pairConfirmAddressLabel: "Adresse",
  pairConfirmKeyLabel: "Sein Schlüssel",
  pairConfirmKeyWhy:
    "Dieselben Zeichen wie dort unter Einstellungen \u2192 Geräte. Weichen sie ab, antwortet "
    + "etwas anderes an Stelle dieses Computers \u2014 dann nicht koppeln.",
  pairConfirmNoKeyWhy:
    "Diese Adresse hat ein Zertifikat, das dein Telefon selbst prüft; es gibt also keinen "
    + "Schlüssel zum Vergleichen.",
  pairConfirmGo: "Koppeln",
  pairConfirmCancel: "Nicht koppeln",

  staleAsOf: (time: string) => `Stand ${time} · wird nachgeholt`,
  staleAsOfIdle: (time: string) => `Stand ${time}`,

  connectionLost: "Verbindung verloren. Verbinde neu …",
  connectionNeedsPassword: "Dieses Postfach braucht sein Passwort erneut. Gib es ein, damit wieder synchronisiert wird.",
  connectionGoneSince: (time: string) => `Seit ${time} keine Verbindung`,
  connectionMailHeld: "Neue Post konnte auf diesem Telefon nicht gespeichert werden. Deine Post liegt weiter auf deinem Server.",

  networkOffline: "Dieses Telefon hat kein Netz. ohmail holt nach, sobald es wieder da ist.",
  networkOfflineHeld: "Dieses Telefon hat kein Netz — angezeigt wird die neuere Post, die es hat.",

  firstSyncNothingReadable: "Aus diesem Postfach konnte noch nichts gelesen werden.",
  connectionSetAside: (n: number) => n === 1
    ? "Eine Nachricht konnte nicht gelesen werden und wurde zurückgelegt."
    : `${n} Nachrichten konnten nicht gelesen werden und wurden zurückgelegt.`,

  firstSyncContinuesAt: (folder: string) => `Erste Synchronisierung läuft bei ${folder} weiter`,

  pairingBusy: "Wird gekoppelt…",
  pairedOk: "Gekoppelt. Deine Post wird synchronisiert.",

  /* --------------------------------------------------------------- connect */

  connectTitle: "Von Hand koppeln",
  connectNote:
    "Tippe die Serveradresse und den Kopplungstoken ein, der neben dem QR-Code steht — oder füge den ganzen Kopplungslink in das Token-Feld ein.",
  connectOrigin: "Serveradresse",
  connectOriginHint: "Die https-Adresse, die die Desktop-App unter Einstellungen → Geräte zeigt. Für einen Computer in deinem eigenen Netz scanne stattdessen seinen Code — die Adresse allein genügt nicht.",
  connectToken: "Kopplungstoken",
  connectGo: "Koppeln",
  connectBooting: "Der Spiegel auf dem Gerät wird geöffnet…",
  bootMigrating: BOOT_MIGRATING,
  bootMigratingOf: (applied: number, total: number) => `${BOOT_MIGRATING} (${applied} von ${total})`,
  bootMigratingSlow: "Bei einem großen Postfach kann das einige Minuten dauern.",
  connectRefusedTitle: "Abgelehnt",
  connectSyncing: "Wird synchronisiert…",
  connectSyncNow: "Jetzt synchronisieren",
  connectDisconnect: "Trennen",
  connectMirrored: (n: number, cursor: string) =>
    `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`} auf diesem Gerät · Cursor ${cursor}`,
  pinChanged: PIN_CHANGED,
  /* Die andere Hälfte eines fehlgeschlagenen Handshakes — siehe `copy.en.ts`. */
  pairKeyMismatch:
    "Der Kopplungscode nennt einen Computer, und unter dieser Adresse hat etwas anderes "
    + "geantwortet \u2014 deshalb hat ohmail angehalten, bevor irgendetwas gesendet wurde. Auf "
    + "diesem Telefon hat sich nichts geändert. Öffne auf dem Computer, mit dem du koppeln "
    + "wolltest, Einstellungen \u2192 Geräte und scanne den Code, der dort steht. Stammt dieser "
    + "Code von dort, antwortet etwas in deinem Netz an seiner Stelle.",
  connectSyncFailed: (detail: string, pinned: boolean) =>
    isPinFailure(detail)
      ? pinned
        ? `Synchronisierung angehalten. ${PIN_CHANGED}`
        : "Synchronisierung angehalten. Dieses Telefon hat das Zertifikat unter dieser Adresse "
          + "nicht akzeptiert und deshalb nichts gesendet. Der Server braucht ein https-Zertifikat "
          + "von einer Stelle, der dieses Telefon schon vertraut — siehe den Hinweis bei der Tür "
          + "„Dein eigener Server“."
      : `Synchronisierung fehlgeschlagen — der Spiegel behält, was er hat. ${detail}`,

  /* ------------------------------------------- transport & pairing refusals */

  admitCleartext:
    "Diese Adresse ist eine unverschlüsselte Verbindung, und ohmail sendet deine Post nicht "
    + "darüber. Ein Computer, auf dem ohmail läuft, stellt eine sichere Adresse bereit — öffne "
    + "dort Einstellungen → Geräte und nimm den Code, den es zeigt.",
  admitNoPin:
    "Dieser Kopplungscode trägt die Identität dieses Computers nicht, ohmail kann seine "
    + "Verbindung deshalb nicht von allem anderen in deinem Netz unterscheiden. Erzeuge einen "
    + "frischen Code unter Einstellungen → Geräte der Desktop-App und scanne den.",
  admitCannotPin:
    "Die Kopplung mit einem Computer in deinem eigenen Netz gibt es in diesem Build der "
    + "ohmail-App noch nicht. Nimm stattdessen die Tailscale-Adresse aus Einstellungen → Geräte "
    + "dieses Computers — sie funktioniert auf jeder Plattform.",
  admitPinNotStored:
    "ohmail konnte die Identität dieses Computers auf diesem Telefon nicht speichern und hat "
    + "deshalb angehalten, statt ohne sie zu verbinden.",
  admitPinUnenforceable:
    "Dieser Kopplungscode enthält einen Schlüssel, aber die Adresse darin ist ein Name, dessen "
    + "Zertifikat dieses Telefon selbst prüft \u2014 der Schlüssel lässt sich also nicht prüfen, "
    + "und ohmail zeigt ihn nicht so, als wäre er geprüft. Nimm den Code, den der Computer oder "
    + "Server anzeigt, mit dem du koppeln willst.",

  pairBadAddress: (origin: string) => `keine Serveradresse: „${origin}“`,
  pairEmptyToken: "der Kopplungscode ist leer",
  helloStatus: (status: number) => `der Server hat mit ${status} geantwortet`,
  pairUnreachable: "dieser Server war nicht erreichbar",
  pairUnreachableWhy: (clause: string) => `dieser Server war nicht erreichbar. ${clause}`,
  pairNotOhmail: "diese Adresse antwortet, aber nicht als ohmail-Server",
  pairManagedDeferred: "ohmail.app bietet gerade keine Gerätekopplung an — das sagt seine eigene Beschreibung",
  pairNoPairing: "dieser Server bietet keine Gerätekopplung an",
  pairNotStoredClosed: (detail: string) =>
    `dieses Telefon konnte die Kopplung nicht speichern (${detail}) — die Sitzung wurde geschlossen; erzeuge einen frischen Code und versuch es nochmal`,
  pairNotStoredOpen: (detail: string) =>
    `dieses Telefon konnte die Kopplung nicht speichern (${detail}), und der Server war nicht `
    + "erreichbar, um die gerade geöffnete Sitzung zu schließen — widerrufe dieses Gerät in "
    + "seiner Geräteliste, erzeuge dann einen frischen Code und versuch es nochmal",
  pairEnded:
    "Dieses Telefon wurde abgemeldet, weil seine Kopplung auf dem Server beendet wurde. "
    + "Koppele dieses Telefon erneut.",
  pairAgain: "Erneut koppeln",
  accountErased:
    "Dieses ohmail-Konto wurde gelöscht, deshalb ist seine Kopie deiner Post von diesem Telefon "
    + "entfernt. Die Post auf deinem Mailserver ist unberührt.",
  pairRedeemUnreachable: "dieser Server war nicht erreichbar, um die Kopplung einzulösen",
  pairCodeRejected: "dieser Kopplungscode wurde nicht angenommen — erzeuge einen frischen und scanne erneut",
  pairNoAccountName:
    "gekoppelt, aber der Server konnte das Konto nicht benennen, das diese Kopplung öffnet — "
    + "erzeuge einen frischen Code und koppele erneut, sobald es Post hält",
  pairOwedDeletion: (detail: string) =>
    "Dieses Telefon schuldet für die kopierte Post dieses Postfachs noch eine Löschung und konnte "
    + `sie nicht ausführen (${detail}). Starte ohmail neu, damit es das abschließen kann, und `
    + "koppele dann mit einem frischen Code erneut.",
  notPairedHere: "dieser Server ist auf diesem Telefon nicht mehr gekoppelt",
  pairingsUnreadable: (detail: string) =>
    `die gespeicherten Kopplungen dieses Telefons ließen sich nicht lesen — ${detail}`,

  forgetCannotStart: (detail: string) =>
    `Dieses Telefon konnte nicht beginnen, diesen Server zu vergessen (${detail}). Starte ohmail `
    + "neu, damit es die Löschungen abschließen kann, die es schon schuldet, und versuch es dann nochmal.",
  forgetKeystoreRefused: (detail: string) =>
    `Dieses Telefon wollte die Kopplung nicht hergeben (${detail}). `
    + "Widerrufe dieses Gerät in der Geräteliste des Servers — das beendet die Sitzung, wo immer sie gehalten wird.",
  forgetMailRemains: (detail: string) =>
    "Die Kopplung ist entfernt, aber die Post, die dieses Telefon kopiert hatte, ließ sich nicht "
    + `löschen (${detail}). ohmail versucht es beim nächsten Start erneut.`,
  forgetEngineRemains: (detail: string) =>
    "Das Postfach auf diesem Telefon ließ sich nicht entfernen: seine Post oder der Schlüssel zu "
    + `seinem gespeicherten Passwort ist noch hier (${detail}). Sonst wurde nichts angerührt — `
    + "starte ohmail neu, das schließt die Löschung ab, bevor es etwas öffnet.",
  forgetServerUnreachable:
    "Die Kopplung und die Post, die dieses Telefon kopiert hatte, sind weg. Der Server war nicht "
    + "erreichbar, um die Sitzung zu beenden, und zählt dieses Telefon womöglich noch als "
    + "verbunden — widerrufe dieses Gerät in seiner Geräteliste, um das abzuschließen.",
  forgetClaimStands: (minutes: number) =>
    "Das Postfach und seine Post sind von diesem Telefon weg. Sein Anspruch auf das Postfach ließ "
    + `sich nicht zurückgeben, deshalb kann eine andere Maschine das Postfach in etwa ${minutes} `
    + "Minuten übernehmen.",
  forgetStillPending:
    "Dieser Server wird auf diesem Telefon noch vergessen — ohmail konnte seine Anmeldung noch "
    + "nicht entfernen. Starte die App neu, damit sie das abschließen kann, oder widerrufe dieses "
    + "Gerät in der Geräteliste des Servers.",

  baseAddressMissing: "Die Adresse deines Servers fehlt.",
  baseNeedsTheCode:
    "Das ist eine numerische Adresse in einem Netz, und dafür kann keine Zertifizierungsstelle "
    + "bürgen — ohmail kann ihr deshalb nur über den Code vertrauen, den dein Computer zeigt. "
    + "Öffne dort Einstellungen → Geräte und scanne den.",
  baseCleartext:
    "Das ist eine unverschlüsselte Adresse, und ohmail sendet deine Post nicht darüber. Gib die "
    + "https-Adresse an, unter der du ohmail im Browser öffnest.",
  baseNotAnAddress:
    "Das sieht nicht nach einer Serveradresse aus. Gib die Adresse an, unter der du ohmail im "
    + "Browser öffnest — zum Beispiel https://ohmail.example.com — mit nichts hinter dem Host.",

  baseApiUnreachable: (detail: string) =>
    `dieser Server war nicht erreichbar, um seine Mail-API zu finden — ${detail}`,
  baseApiStopped:
    "Dieser Server hat zu antworten begonnen und dann aufgehört, ohmail hat deshalb nicht weiter "
    + "gewartet. Wenn du ihn betreibst, prüfe, ob sein Proxy die Anfragen an die ohmail-API "
    + "durchreicht.",
  baseApiTimeout:
    "Dieser Server hat nicht rechtzeitig geantwortet, ohmail hat deshalb nicht weiter gewartet. "
    + "Das kann am Netz zwischen diesem Telefon und ihm liegen oder an einer Route auf dem Server, "
    + "die nie antwortet.",
  baseApiMixed: (detail: string) =>
    "Eine der beiden Adressen, die ohmail versucht hat, hat geantwortet und war nicht seine "
    + `Mail-API, und die andere war nicht erreichbar — ${detail}. Wenn du diesen Server `
    + "betreibst, prüfe, ob er /api an die ohmail-API durchreicht.",
  baseApiNotFound:
    "Diese Adresse antwortet, aber ohmail konnte ihre Mail-API nicht finden — weder unter der "
    + "Adresse selbst noch unter /api. Wenn du diesen Server betreibst, prüfe, ob sein Proxy /api "
    + "an die ohmail-API durchreicht.",

  /* ----------------------------------------------------------------- ohbox */

  ohbox: "Ohbox",
  groupNew: "Neu",
  groupSeen: "Gesehen",
  metaUnreadOf: (unread: number, total: number) => `${unread} ungelesen von ${total}`,
  metaNew: (n: number) => `${n} neu`,
  metaWaiting: (n: number) =>
    `${n} ${n === 1 ? "Erstabsender wartet" : "Erstabsender warten"}`,
  metaWaitingOnDevice: (n: number) =>
    `${n} ${n === 1 ? "Erstabsender wartet" : "Erstabsender warten"}, auf diesem Telefon gezählt`,
  metaItems: (n: number) => `${n} ${n === 1 ? "Eintrag" : "Einträge"}`,
  mailRowAria: (from: string, subject: string, time: string, unread: boolean) =>
    `${from}. ${subject.trim() === "" ? "" : `${subject}. `}${time}.${unread ? " Ungelesen." : ""}`,
  senderRowAria: (name: string, address: string, held: number) =>
    `${name}, ${address}, ${held} zurückgehalten`,
  deliveredTo: (label: string) => `Zugestellt an ${label}`,
  readsCollapse: "Zuklappen",
  readsReadInFull: "Ganz lesen",
  readsCardAria: (subject: string, open: boolean) =>
    `${subject}. ${open ? "Zuklappen" : "Ganz lesen"}.`,
  decideAria: (done: string, suggested: boolean) => `${done}${suggested ? ", vorgeschlagen" : ""}`,
  decideReadAria: (done: string) => `${done}, und als gelesen markieren`,
  /*
   * "Alle 1 angenommene Nachricht wird gezeigt" is not German — "alle" cannot govern one thing.
   * The singular gets its own phrasing rather than a branch inside the plural's frame, which is
   * what a count sentence needs whenever the quantifier itself is number-bearing.
   */
  ohboxTail: (shown: number) =>
    shown === 1
      ? "Die eine angenommene Nachricht wird gezeigt."
      : `Alle ${shown} angenommenen Nachrichten werden gezeigt.`,
  ohboxEmptyTitle: "Hier ist noch nichts.",
  ohboxEmptyHint: "Post von Absendern, zu denen du Ja gesagt hast, landet hier, sobald sie synchronisiert wird.",
  ohboxEmptyNothingReadable:
    "Aus diesem Postfach konnte noch nichts gelesen werden. Deine Post liegt weiter auf deinem Server.",
  /*
   * Two pieces, the count and a quieter tail, as in English. The tail takes the count too, so
   * the verb agrees ("1 neuer Absender wartet", "3 neue Absender warten"); a tail naming the
   * Screener would repeat the link beside it.
   */
  doorbell: (n: number) => `${n} ${n === 1 ? "neuer Absender" : "neue Absender"}`,
  doorbellRest: (n: number) => (n === 1 ? "wartet" : "warten"),
  doorbellGo: "Screener",
  doorbellAria: (n: number, go: string): string =>
    (n === 1 ? `1 neuer Absender wartet. ${go}` : `${n} neue Absender warten. ${go}`),
  /** The faces the stack did not draw. The figure is the same on both sides. */
  doorbellMore: (n: number) => `+${n}`,

  /* --------------------------------------------------------- reads/receipts */

  reads: "News",
  receipts: "Belege",
  waterline: "Bis hierher gesehen",
  readsTail: (shown: number) =>
    (shown === 1
      ? "Die eine Ausgabe wird gezeigt."
      : `Alle ${shown} Ausgaben werden gezeigt.`)
    + " Vorbeiscrollen markiert einen Beitrag als gesehen.",
  receiptsTail: (shown: number) =>
    shown === 1 ? "Der eine Beleg wird gezeigt." : `Alle ${shown} Belege werden gezeigt.`,
  readsEmptyTitle: "Noch keine Ausgaben.",
  readsEmptyHint: "Newsletter und lange Texte, die du hier ablegst, kommen an, sobald sie synchronisiert werden.",
  receiptsEmptyTitle: "Noch keine Belege.",
  receiptsEmptyHint: "Bestellungen, Rechnungen und Tickets, die du hier ablegst, kommen an, sobald sie synchronisiert werden.",
  today: "heute",
  streamSeenHint: "Vorbeiscrollen markiert als gesehen",

  /* ------------------------------------------------------------- protected */

  protectedPreview: "Bestätigungscode ······ (geschwärzt)",
  protectedCodeLabel: "Bestätigungscode",
  protectedRedacted: "······",
  protectedLead: "Geschützt",

  /* -------------------------------------------------------------- screener */

  screener: "Screener",
  segWaiting: "Wartend",
  segScreened: "Aussortiert",
  segSpam: "Spam",
  destScreenOut: "Aussortieren",
  aiSuggests: (dest: string, confidence: number) => `${dest} · ${confidence.toFixed(2)}`,
  scopeSender: "dieser Absender",
  scopeDomain: "ganze Domain",
  decideRule: (target: string) =>
    `Wird zur Regel — künftige Post von ${target} wird automatisch einsortiert. Die ✓-Hälfte markiert diese Post außerdem als gelesen.`,
  decideReadToggle: "& gelesen",
  decideReadOn: "Wird als gelesen einsortiert — der Zähler bewegt sich nicht.",
  decideReadOff: "Wird ungelesen einsortiert — sie meldet sich.",
  heldCaption: (n: number, firstContact?: string) => {
    /* "alle" cannot govern one thing — `vollständig` says the same and takes no number. */
    const head = `${n === 1 ? "1 zurückgehaltene Nachricht" : `${n} zurückgehaltene Nachrichten`} — vollständig gezeigt`;
    return firstContact ? `${head} · erster Kontakt ${firstContact}` : head;
  },
  screenedNote: (date: string, held: number) =>
    `Aussortiert ${date} · ${held} zurückgehalten, vollständig gezeigt. Zulassen gibt jede einzelne davon in die gewählte Ansicht frei.`,
  /* No trailing preposition: the destination is chosen in the control beside this label, and
     "freigeben nach Belege" is not German. The label states the act; the picker states the place. */
  allowLabel: "Zulassen — zurückgehaltene Post freigeben",
  notSpamLabel: "Kein Spam — alle zurückgehaltene Post verschieben",
  spamNote:
    "Die Erkennung liest die Struktur — Absender, Header, Linkziele. Inhalte werden nirgendwohin gesendet.",
  waitingEmptyTitle: "Es wartet niemand.",
  waitingEmptyHint: "Erstabsender klopfen hier an, bevor irgendetwas in deine Ohbox kommt.",
  cutlinePending:
    "Deine Screening-Einstellungen werden gelesen — bis sie da sind, steht diese Liste nicht fest.",
  screenedEmptyTitle: "Niemand aussortiert.",
  screenedEmptyHint: "Absender, zu denen du Nein sagst, warten hier — zurückgehalten, nie gelöscht.",
  spamEmptyTitle: "Kein Spam zurückgehalten.",
  spamEmptyHint:
    "Vermuteter Spam wartet hier auf deinen Blick — von sich aus löscht ohmail ihn nie. Post, die du als Spam bestätigst, wandert in den eigenen Spam-Ordner deines Mailservers, oder bleibt hier zurückgehalten, wenn dein Postfach keinen hat.",

  /* ---------------------------------------------------------------- triage */

  triage: "Stapel",
  replyLater: "Später antworten",
  setAside: "Geparkt",
  park: "Parken",
  resurface: "Wieder auftauchen",
  pileEmpty: "Hier ist noch nichts.",

  /* Die drei Stapel-Beschreibungen — siehe `copy.en.ts` für die zweite Deck-Geschichte. */
  replyLaterNote: "Antworten, die du schuldest. Eine Antwortrunde geht sie einzeln durch, eine pro Bildschirm.",
  setAsideNote: "Bleibt in Sicht, ohne die Ohbox zu beschäftigen.",
  resurfaceNote: "Kommt von selbst zurück, zu der Zeit, die du gewählt hast.",

  storeFault: (code: string): string => {
    switch (code) {
      case "origin_not_normalized": return "diese Serveradresse hatte nicht die Form, in der dieses Telefon sie speichert";
      case "account_id_missing": return "der Server hat das Konto nicht benannt, das diese Kopplung öffnet";
      case "pairing_not_recorded": return "dieses Telefon konnte die Kopplung nicht erfassen, bevor es sie speichert";
      case "pairing_still_held": return "dieses Telefon hält die Kopplung weiterhin";
      case "pairing_still_listed": return "dieses Telefon führt die Kopplung weiterhin in seiner Liste";
      case "no_such_profile": return "eine solche Kopplung gibt es auf diesem Telefon nicht";
      case "wipe_queue_full": return "dieses Telefon hat bereits mehr unerledigte Löschungen, als es erfassen kann";
      case "wipe_not_recorded": return "dieses Telefon konnte nicht erfassen, dass für die kopierte Post eine Löschung aussteht";
      case "wipe_still_owed": return "dieses Telefon führt für dieses Postfach noch eine ausstehende Löschung";
      case "wake_queue_full": return "dieses Telefon hat bereits mehr unerledigte Weckruf-Abmeldungen, als es erfassen kann";
      case "wake_not_recorded": return "dieses Telefon konnte nicht erfassen, dass für die Weckruf-Registrierung eine Abmeldung aussteht";
      case "wake_still_owed": return "dieses Telefon führt für diese Registrierung noch eine ausstehende Abmeldung";
      case "index_unreadable": return "die Kopplungsliste dieses Telefons ließ sich nicht lesen";
      case "purge_refused": return "der Schlüsselspeicher wollte die Kopplungen der früheren Installation nicht hergeben";
      case "mirror_not_deleted":
        return "dieses Telefon konnte die gespeicherte Post dieses Kontos nicht löschen";
      case "sync_held_pre_identity":
        return "ohmail prüft noch, welches Konto dieser Server öffnet";
      case "account_mismatch":
        return "dieser Server synchronisiert ein anderes Konto als das, auf das diese Kopplung lautet";
      case "index_not_removed": return "der Schlüsselspeicher wollte die Kopplungsliste nicht entfernen";
      /* Das Entfernen des Postfachs auf diesem Telefon. Jede benennt, welcher Speicher nicht
         losgelassen hat — der nächste Schritt hängt davon ab. */
      case "engine_removal_not_recorded":
        return "dieses Telefon konnte nicht vermerken, dass das Postfach auf ihm entfernt wird";
      case "engine_removal_still_recorded":
        return "dieses Telefon vermerkt noch eine unabgeschlossene Entfernung des Postfachs auf ihm";
      case "engine_store_not_deleted":
        return "dieses Telefon konnte die Post und das gespeicherte Passwort des Postfachs auf ihm nicht löschen";
      case "engine_key_not_removed":
        return "der Schlüsselspeicher wollte den Schlüssel nicht entfernen, der das gespeicherte Passwort dieses Postfachs öffnet";
      default: return code;
    }
  },

  verbatimDetail: (detail: string) => detail,

  /* --------------------------------------------------------------- folders */

  folders: "Ordner",
  folderEmpty: "Noch keine Ordner auf deinem Mailserver.",
  junkNote: (folder: string) =>
    `Der eigene ${folder}-Ordner deines Mailservers steht nicht in dieser Liste — ohmail spiegelt ihn nicht.`,
  junkNoteUnnamed:
    "Der eigene Spam-Ordner deines Mailservers steht nicht in dieser Liste — ohmail spiegelt ihn nicht.",
  folderFilter: "Ordner filtern",
  folderNoMatch: "Kein Ordner passt.",
  folderShowAll: (n: number) => `Alle ${n} anzeigen…`,
  folderShowFewer: "Weniger anzeigen",
  folderExpand: (name: string) => `${name} aufklappen`,
  folderCollapse: (name: string) => `${name} zuklappen`,
  folderTail: (n: number) =>
    `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`} aus diesem Ordner auf diesem Telefon.`,
  folderEmptyTitle: "Von diesem Ordner ist keine Post auf diesem Telefon.",
  folderEmptyHint:
    "Dieses Telefon spiegelt die neuere Post deines Servers. Der Ordner selbst liegt auf deinem Mailserver und kann dort ältere Post enthalten.",

  history: "Historie",
  historyNavSub: "Alles, was dir gehört, neueste zuerst",
  historyMeta: (n: number) => `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`}`,
  historyExplainer: "Jede Nachricht, die dir gehört, die neueste zuerst — bis zur ersten zurück.",
  historyExplainerMore:
    "Verschoben wurde nichts: Jede Nachricht liegt weiter dort, wo dein Mailserver sie hat, und ihre Zeile nennt diesen Ordner. Die Monate und Jahre rechts springen an jede Stelle.",
  historyExplainerMoreLabel: "Was in der Historie liegt, und wo es liegt",
  historyEmptyTitle: "Noch nichts da.",
  historyEmptyHint: "Deine Post erscheint, sobald sie synchronisiert ist.",
  historyTail: (n: number) => `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`} in der Historie.`,
  historyLoading: "Deine Post wird geladen.",
  historyStoreUnavailable: "Dein Server hat nicht geantwortet — angezeigt wird die neuere Post, die dieses Gerät hat.",
  historyStoreRetry: "Erneut versuchen",
  historyRailLabel: "Zu einem Jahr springen",
  historyUndated: "Ohne Datum",

  folderNew: "Neuer Ordner",
  folderNewSub: "Neuer Unterordner",
  ariaLabelCount: (label: string, count: number): string => `${label}, ${count}`,
  ariaLabelDetail: (label: string, detail: string): string => `${label}, ${detail}`,
  ariaNameThenSentence: (name: string, say: string): string => `${name}. ${say}`,
  folderNewSubIn: (parent: string): string => `Neuer Unterordner — ${parent}/`,
  folderRename: "Umbenennen",
  folderDelete: "Löschen…",
  folderMenuAria: (name: string) => `Ordnermenü für ${name}`,
  folderNamePlaceholder: "Ordnername",
  folderRenamePlaceholder: "Neuer Name",
  folderCreating: "Wird auf deinem Mailserver angelegt…",
  folderRenaming: (name: string) => `Wird auf deinem Mailserver zu ${name} umbenannt…`,
  folderDeleting: "Wird gelöscht — die Nachrichten wandern zuerst in den Papierkorb deines Servers…",
  folderDismiss: "OK",
  folderErrRefused: "Dein Mailserver hat diese Änderung abgelehnt.",
  folderErrBadName: "Dein Mailserver nutzt eines dieser Zeichen, um Ordner zu trennen — wähle einen anderen Namen.",
  folderErrExists: "Ein Ordner mit diesem Namen existiert bereits.",
  folderErrGone: "Diesen Ordner gibt es auf deinem Mailserver nicht mehr.",
  folderErrNoTrash: "Dieses Postfach hat keinen Papierkorb, und ohmail löscht nie endgültig — lösche den Ordner in deinem eigenen Mailprogramm.",
  folderErrGotMail: "In diesen Ordner kam neue Post, während er geleert wurde — er wurde nicht gelöscht. Lösche ihn erneut, um noch einmal zu leeren.",
  folderNameEmpty: "Gib dem Ordner einen Namen.",
  folderNameSpaces: "Der Name darf nicht mit einem Leerzeichen beginnen oder enden.",
  folderNameChars: "Der Name darf kein % und kein * enthalten.",
  folderNameLong: "Dieser Name ist zu lang.",
  folderNameReserved: "Dieser Name ist in deinem Postfach reserviert.",
  folderNameTaken: "Ein Ordner mit diesem Namen existiert bereits.",
  folderDeleteCounting: "Zähle, was verschoben wird…",
  folderDeleteConfirm: (messages: number, folders: number) => {
    const scope = folders === 1 ? "diesem Ordner" : `diesen ${folders} Ordnern`;
    const seen = messages === 0
      ? "keine Nachrichten"
      : messages === 1 ? "die eine Nachricht" : `die ${messages} Nachrichten`;
    const tail = folders === 1 ? "der Ordner wird" : "die Ordner werden";
    return `Alles in ${scope} wandert in den Papierkorb auf deinem Mailserver — ${seen}, die ohmail gesehen hat, und alles, was es noch nicht gesehen hat; ${tail} danach entfernt.`;
  },
  folderDeleteConfirmUncounted: "Alles darin wandert in den Papierkorb auf deinem Mailserver; der Ordner wird danach entfernt.",
  folderDeleteGo: "Ordner löschen",
  folderDeleteCancel: "Abbrechen",
  folderVerbFailed: "Diese Ordneränderung hat dein Postfach nicht erreicht — nichts wurde geändert.",

  foldersUseTitle: "Ordner verwenden",
  foldersUseOn:
    "Die Ordner deines Mailservers erscheinen im Menü, jeder öffnet sich als eigene Liste mit Ungelesen-Zähler.",
  foldersUseOff: "Deine Ordner bleiben ausgeblendet. ohmail liest sie weiterhin für Suche und Historie.",
  foldersMicrocopy:
    "Einschalten zeigt nur, was ohnehin existiert — verschoben wird nichts. Ausschalten blendet die Ordner wieder aus, ohne deine Mail anzurühren.",
  foldersFailed: "Das ließ sich nicht speichern — versuch es nochmal.",
  autoActTitle: "Sichere Vorschläge für mich umsetzen",
  autoActDescription:
    "Ist ein Vorschlag zu einem wartenden Absender zu mindestens 90 % sicher, legt ohmail diesen Absender dort ab, wo der Vorschlag es sagt — in der Ohbox, in News, bei den Belegen, unter Aussortiert oder im Spam — und schreibt die Regel für dich. Jede solche Regel ist als Regel von ohmail markiert, und du kannst sie unter Einstellungen → Regeln rückgängig machen. Absender, denen du geschrieben hast, und sensible Post werden so nie abgelegt. Standardmäßig aus.",
  autoActNeedsSuggest: "Braucht automatische Vorschläge",
  autoActReader: "Stell das auf der Installation ein, die deine Post organisiert.",
  autoFiledTitle: "Automatisch einsortiert",
  autoFiledSummary: (n: number) => `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`} für dich aus dem Screener einsortiert.`,
  autoFiledSummaryMore: (n: number) => `Die neuesten ${n} Nachrichten, die für dich aus dem Screener einsortiert wurden.`,
  autoFiledReview: "Ansehen",
  autoFiledHide: "Ausblenden",
  autoFiledRow: (from: string, subject: string, place: string) => `${from} · ${subject} · in ${place}`,
  autoFiledPutBack: "Zurücklegen",
  autoFiledPutBackAll: (n: number) => `Alle ${n} zurücklegen`,
  autoFiledPutBackDone: (n: number) =>
    `${n === 1 ? "1 Nachricht kommt" : `${n} Nachrichten kommen`} zurück in deinen Screener. Sie werden nicht wieder automatisch einsortiert.`,
  autoFiledRequested: "An die Installation geschickt, die dieses Postfach organisiert. Sie legt sie zurück.",
  autoFiledNone: "Nichts mehr zurückzulegen.",
  autoFiledFailed: "Konnte nicht zurückgelegt werden — versuch es noch einmal.",
  autoActFailed: "Diese Einstellung wurde nicht gespeichert. Sie ist unverändert.",
  switchOff: "Aus",
  switchOn: "An",

  /* ---------------------------------------------------------------- search */

  search: "Suche",
  /* SUCHE — der `search`-Namespace des Web-Katalogs, wo die Fläche dieselbe ist. */
  searchPlaceholder: "Alles durchsuchen — Tippfehler sind erlaubt",
  searchResultsHead: (n: number) => (n === 1 ? "Ein Treffer" : `${n} Treffer`),
  searchSimilarHead: "Ähnlich",
  searchSimilarHint: "Nichts stimmte genau überein — das sind die nächstliegenden Wörter.",
  searchSimilarHintSynced: "In der bisher synchronisierten Post stimmte nichts genau überein — das sind die nächstliegenden Wörter.",
  searchEmptyTitle: "Nichts gefunden.",
  searchPartReach: "Ein Teil innerhalb eines Wortes wird in Betreff, Absendern, Empfängern und Namen von Anhängen gesucht, nicht im Text der Nachricht.",
  searchIndexing: "Deine neuere Post wird noch gelesen.",
  searchWholeSearching: "Dein ganzes Postfach wird durchsucht …",
  searchWhole: (n: number) => (n === 0 ? "Dein ganzes Postfach wurde durchsucht — nichts gefunden" : `Dein ganzes Postfach wurde durchsucht — ${n} gefunden`),
  searchWholeAtLeast: (n: number) => `Dein ganzes Postfach wurde durchsucht — mindestens ${n} gefunden`,
  searchWholeAbout: (n: number) => `Dein ganzes Postfach wurde durchsucht — etwa ${n} gefunden`,
  searchSynced: (n: number) => (n === 0 ? "Die bisher synchronisierte Post wurde durchsucht — nichts gefunden" : `Die bisher synchronisierte Post wurde durchsucht — ${n} gefunden`),
  searchSyncedAtLeast: (n: number) => `Die bisher synchronisierte Post wurde durchsucht — mindestens ${n} gefunden`,
  searchSyncedAbout: (n: number) => `Die bisher synchronisierte Post wurde durchsucht — etwa ${n} gefunden`,
  searchSyncing: "Der Rest deiner Post ist noch nicht synchronisiert.",
  searchServerMs: (ms: number) => `${ms} ms`,
  searchUnanswered: "Dein Server hat nicht geantwortet — angezeigt wird die neuere Post, die dieses Gerät hat.",
  searchWholeRetry: "Ganzes Postfach erneut durchsuchen",
  searchIndexingProgress: (percent: number) => `Ältere Post wird noch indiziert — ${percent} % erledigt.`,
  searchBounded: (n: number) => `Angezeigt werden die ${n} besten Treffer — nach Datum sortieren, um alle durchzugehen.`,
  searchEmptyAddressScopes: (address: string) =>
    `Eine Adresse ist ihre eigene Suche — alles, was ${address} geschickt hat, oder alles von oder an sie.`,
  searchAddressAll: "Alle",
  searchAddressFrom: "Von ihnen",
  searchAddressTo: "An sie",
  searchAddressToggleAria: "Welche Richtung",
  searchAddressCounts: (any: number, from: number, to: number) =>
    `Alle ${any} · Von ihnen ${from} · An sie ${to}`,
  searchAddressEmptyAny: (address: string) => `Nichts von oder an ${address}.`,
  searchAddressEmptyFrom: (address: string) => `Nichts von ${address}.`,
  searchAddressEmptyTo: (address: string) => `Nichts an ${address} geschickt.`,

  /* ------------------------------------------------ zwei Bereiche (große Displays) */

  sidebar: "Seitenleiste",
  paneNothingOpen: "Nichts geöffnet",
  paneNothingOpenHint: "Hier erscheint die Mail, die du in der Liste auswählst.",

  /* -------------------------------------------------------------- settings */

  settings: "Einstellungen",
  theme: "Erscheinungsbild",
  themeNote: "Automatisch folgt dem System. Bleibt auf diesem Telefon.",
  pictureQuality: "Bildqualität",
  pictureQualityNote:
    "JPEG- und PNG-Bilder werden auf diesem Telefon verkleinert, bevor sie angehängt werden. Niedrigere Qualität bedeutet kleinere Dateien. Ein Bild, das dadurch nicht kleiner würde, wird unverändert angehängt, und „Original“ wird nie neu codiert. Bleibt auf diesem Telefon.",
  pictureQualityLow: "Niedrig",
  pictureQualityMedium: "Mittel",
  pictureQualityHigh: "Hoch",
  pictureQualityOriginal: "Original",
  themeAuto: "Automatisch",
  themeLight: "Hell",
  themeDark: "Dunkel",

  language: "Sprache",
  languageNote: "Folgt diesem Telefon, solange du nichts wählst. Gilt für ohmail auf diesem Gerät.",
  /* Identisch zum englischen Deck, mit Absicht — siehe dort. */
  languageSystem: "System",
  languageEnglish: "English",
  languageGerman: "Deutsch",
  languageFailed: "Das ließ sich nicht speichern — versuch es nochmal.",

  face: "Stil",
  faceHint: "ohmarchy — ein Kachel-Stil, tastaturzentriert, inspiriert von Omarchy.",
  facePaper: "paper",
  faceOhmarchy: "ohmarchy",
  faceScopeAll: "Gilt auf allen deinen Geräten.",
  faceScopeDevice: "Gilt nur auf diesem Gerät.",
  faceApplyAll: "Auf allen Geräten anwenden",
  faceFailed: "Das ließ sich nicht speichern — versuch es nochmal.",

  /* ────────────────────────────────────────────────── who organizes this mailbox */

  phoneBanner: (name: string) => `Organisiert von ${name}`,
  phoneBannerWhy:
    "Dieses Telefon liest das Postfach. Entschieden wird dort, wo es organisiert wird.",
  phoneBannerStopped: (name: string) =>
    `${name} meldet sich nicht mehr. Bis wieder etwas dieses Postfach organisiert, wartet neue Post im Posteingang.`,

  about: "Über diesen Build",
  buildVersion: (version: string) => `Version ${version}`,
  buildVersionWithCode: (version: string, build: string) => `Version ${version} (${build})`,
  buildCommit: (commit: string) => `Build ${commit}`,
  aboutLive: (origin: string) =>
    `Gekoppelt mit ${origin}. Post wird in einen Spiegel auf dem Gerät synchronisiert; Lesen, neue Nachrichten schreiben, Sortieren, Antworten, Weiterleiten, Tags und Suche sind live.`,
  aboutLiveHere:
    "Dieses Telefon verbindet sich selbst mit deinem Mailserver und synchronisiert die Post in einen Spiegel auf dem Gerät; Lesen, neue Nachrichten schreiben, Sortieren, Antworten, Weiterleiten, Tags und Suche sind live.",
  aboutOnDevice:
    "Einen Server zu vergessen löscht seine Kopplung und die Post, die dieses Telefon kopiert "
    + "hatte. Die App zu löschen nimmt die kopierte Post mit; auf iPhone und iPad bleibt die "
    + "Kopplung im Schlüsselbund des Telefons, bis ohmail wieder geöffnet wird — dann wird sie "
    + "verworfen, bevor irgendetwas geöffnet wird, und wenn das nicht gelingt, wird gar nichts "
    + "geöffnet. Um sie sofort zu beenden, widerrufe dieses Gerät in der Geräteliste des Servers. "
    + "Die Kopplung ist nie in einem Backup enthalten.",

  aboutOnDeviceBackup: (state: BackupExclusion): string =>
    state === "excluded"
      ? "Die kopierte Post ist es auch nicht: Die gespeicherte Post dieser App ist so markiert, "
        + "dass sie aus den Cloud- und Computer-Backups des Telefons herausbleibt, und dieser "
        + "Build hat diese Markierung zurückgelesen."
      : state === "included"
        ? "Die kopierte Post ist es: Sie liegt in den gespeicherten Dateien dieser App, und die "
          + "Cloud- und Computer-Backups des Telefons schließen sie ein."
        : "Ob die kopierte Post in einem Backup enthalten ist, konnte auf diesem Build nicht "
          + "gelesen werden — hier wird deshalb weder das eine noch das andere behauptet.",

  /* --------------------------------------------- the diagnostic file */

  diagnosticLabel: "Diagnosedatei",
  diagnosticWhy:
    "Schreibt eine Datei darüber, wie ohmail auf diesem Telefon läuft: Versionen, Anzahlen, "
    + "Fehlercodes und die letzten Log-Ereignisse, nie Adressen, Betreffzeilen oder Ordnernamen. "
    + "Es wird nichts gesendet.",
  diagnosticAction: "Datei schreiben",
  diagnosticWriting: "Wird geschrieben…",
  diagnosticWritten: (path: string): string =>
    `Gespeichert unter ${path}, neben der kopierten Post dieses Telefons. Es wurde nichts `
    + "gesendet. Teile sie selbst mit uns, wenn wir sie ansehen sollen.",
  diagnosticShare: "Datei teilen",
  diagnosticShareFailed:
    "Dieses Telefon konnte das Teilen-Menü nicht öffnen. Die Datei liegt weiter dort, wo sie "
    + "geschrieben wurde; es wurde nichts gesendet.",
  diagnosticFailed: "Die Datei konnte nicht geschrieben werden. Es wurde nichts gesendet.",

  /* --------------------------------------------- organizing in the background */

  stateOrganizing: "Organisiert",
  notifBody: (address: string): string => `Organisiert ${address}.`,
  notifStop: "Nicht mehr organisieren",
  notifStopFailed: "Stopp nicht abgeschlossen — wird erneut versucht.",
  organizerRestricted:
    "Der Energiesparmodus lässt ohmail auf diesem Telefon nicht im Hintergrund organisieren. "
    + "Es organisiert, solange die App offen ist, und gibt das Postfach zurück, wenn du sie "
    + "verlässt.",
  organizerNotifyTitle: "Im Hintergrund organisieren",
  organizerNotifyWhy:
    "ohmail zeigt eine Benachrichtigung, während es dein Postfach im Hintergrund ordnet. Ohne sie "
    + "endet das Ordnen, wenn du die App verlässt.",
  organizerNotifyGo: "Weiter",
  organizerNotifyNotNow: "Jetzt nicht",
  organizerNotificationsOff:
    "Benachrichtigungen sind aus — organisiert wird nur, solange die App offen ist.",
  organizerHandBackLate: (minutes: number) =>
    "Als ohmail zuletzt in den Hintergrund ging, konnte es das Postfach nicht rechtzeitig "
    + `zurückgeben, deshalb konnte eine andere Maschine es bis zu ${minutes} Minuten nicht übernehmen.`,
  organizerNotificationsSettings: "Benachrichtigungen einstellen",

  /* ------------------------------------------------------------- new mail */

  wake: "Neue Mail",
  wakeNoDistributor:
    "Auf diesem Telefon ist kein Push-Verteiler gewählt, es weckt diese App also nichts zwischen "
    + "deinen Besuchen. UnifiedPush-Verteiler sind eigene Apps, die du selbst wählst — ein Push-"
    + "Dienst von Google oder Apple ist so oder so nicht beteiligt. Post kommt an, wenn du die App "
    + "öffnest oder zum Aktualisieren ziehst.",
  wakeDesktopHost:
    "Weckrufe brauchen einen gehosteten Server. Mit einem Desktop gekoppelt synchronisiert diese "
    + "App, wenn du sie öffnest und wenn du zum Aktualisieren ziehst.",
  wakeServerNoKey:
    "Dieser Server hat keinen Signaturschlüssel eingerichtet und kann daher keine Weckrufe senden, "
    + "die dieses Telefon annehmen würde. Wer ihn betreibt, kann einen erzeugen — siehe die "
    + "Anleitung zum Selbsthosten. Post kommt weiterhin an, wenn du die App öffnest oder zum "
    + "Aktualisieren ziehst.",
  wakeOn:
    "Solange ohmail läuft — geöffnet oder im Hintergrund — sagt dein Server diesem Telefon, dass "
    + "sich etwas geändert hat, und die App holt deine Post direkt. Wenn du die App schließt, kommt "
    + "stattdessen ein schlichter Hinweis „Neue Mail“ (sofern du Benachrichtigungen erlaubt hast); "
    + "ein Tippen darauf öffnet ohmail. So oder so trägt das Signal weder Betreff noch Absender "
    + "noch Anzahl.",
  wakeDistributor: "Push-Verteiler",
  wakeDistributorHint:
    "Die App, die das Wecksignal zu diesem Telefon trägt. Du wählst sie, du kannst sie wechseln, "
    + "und außer deinem eigenen Server ist sie das Einzige auf dem Weg.",
  wakeDistributorNone: "Keiner",
  wakeDistributorNoneHint:
    "Das auszuschalten beendet die Weckrufe und entfernt die Registrierung von deinem Server.",
  wakeRowRemains:
    "Weckrufe sind auf diesem Telefon aus. Dein Server wollte die Registrierung nicht entfernen "
    + "und versucht die alte Adresse womöglich noch eine Weile — versuch es nochmal, oder widerrufe "
    + "dieses Gerät in der Geräteliste des Servers.",
  wakeOff: (reason: string): string => reason === "endpoint_refused"
    ? "Der Server hat die Adresse deines Verteilers abgelehnt, Weckrufe sind deshalb aus. Post "
      + "kommt weiterhin an, wenn du die App öffnest oder zum Aktualisieren ziehst."
    : "Weckrufe konnten nicht eingerichtet werden. Post kommt weiterhin an, wenn du die App "
      + "öffnest oder zum Aktualisieren ziehst.",

  /* ------------------------------------------------- world (phone-specific) */

  groupResurfaced: "Wieder aufgetaucht",
  newSinceResurfaced: (n: number) => `${n} neu`,
  liveSaveFailed: "Diese Änderung ließ sich nicht speichern. Versuch es nochmal.",
  liveDecided: (dest: string, target: string) =>
    `${dest} — künftige Post von ${target} wird automatisch dorthin einsortiert.`,
  liveAlsoUnsubscribing: (said: string) =>
    `${said} ohmail meldet dich dort auch ab, sofern der Absender Ein-Klick-Abmeldung anbietet.`,
  liveDecidedElsewhere: (name: string, target: string) =>
    `Entschieden — ${name} sortiert ${target} beim nächsten Durchlauf ein.`,
  liveDecidedElsewhereUnknown: (target: string) =>
    `Entschieden — die Installation, die dieses Postfach organisiert, sortiert ${target} beim nächsten Durchlauf ein.`,
  liveDecideSent: (name: string, target: string) =>
    `An ${name} geschickt — ${target} wird dort innerhalb weniger Minuten einsortiert.`,
  liveDecideSentUnknown: (target: string) =>
    `An die Installation geschickt, die dieses Postfach organisiert — ${target} wird dort innerhalb weniger Minuten einsortiert.`,
  relayWaiting: (name: string) => `An ${name} geschickt — wartet darauf, dass es ausgeführt wird.`,
  relayWaitingUnknown: "An den Organisator geschickt — wartet darauf, dass es ausgeführt wird.",
  relayRefused: (reason: string) => `Nicht ausgeführt — ${reason}`,
  relayRefusedUnknown: "Nicht ausgeführt. Der Organisator hat keinen Grund genannt.",
  relayReasonUnauthenticated: "es konnte nicht erkennen, dass die Entscheidung von dir kam",
  relayReasonConflict: "für denselben Absender kam zuerst eine andere Entscheidung an",
  relayReasonAccountErased: "das zugehörige Konto gibt es nicht mehr",
  relayReasonStale: "sie blieb zu lange unbeantwortet",
  relayReasonUnhandledKind: "es weiß nicht, wie diese Entscheidung auszuführen ist",
  relayReasonInvalidPayload: "es konnte die Entscheidung nicht lesen",
  relayReasonOtherMailbox: "die Entscheidung nannte ein Postfach, das es nicht organisiert",
  senderSentThere: (name: string) =>
    `Was du hier entscheidest, wird an ${name} geschickt und dort innerhalb weniger Minuten ausgeführt.`,
  readingAtConnect: (name: string) =>
    `Dieses Telefon liest dieses Postfach. ${name} organisiert es, und was du hier entscheidest, wird dorthin geschickt.`,
  readingAtConnectUnknown:
    "Dieses Telefon liest dieses Postfach. Eine andere Installation organisiert es, und was du hier entscheidest, wird dorthin geschickt.",
  liveVerdictKept: (count: number, place: string, kept: number, keptPlace: string, term: string) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place} · ${kept === 1 ? "1 bleibt" : `${kept} bleiben`} nach deiner Regel »${term}« in ${keptPlace}.`,
  liveVerdictKeptDomain: (count: number, place: string, kept: number, keptPlace: string, domain: string, term: string) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place} · ${kept === 1 ? "1 bleibt" : `${kept} bleiben`} nach deiner Regel für alle bei ${domain} (Betreff enthält »${term}«) in ${keptPlace}.`,
  liveVerdictKeptDomainBody: (count: number, place: string, kept: number, keptPlace: string, domain: string, term: string) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place} · ${kept === 1 ? "1 bleibt" : `${kept} bleiben`} nach deiner Regel für alle bei ${domain} (Text enthält »${term}«) in ${keptPlace}.`,
  liveVerdictKeptMany: (count: number, place: string, kept: number) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place} · ${kept === 1 ? "1 bleibt" : `${kept} bleiben`}, wo deine Regeln sie einsortieren.`,
  liveVerdictStill: (count: number, place: string, still: number, stillPlace: string) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place} · ${still === 1 ? "1 liegt" : `${still} liegen`} noch in ${stillPlace}.`,
  liveVerdictStillSpread: (count: number, place: string, still: number) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place} · ${still === 1 ? "1 liegt" : `${still} liegen`} noch an mehreren Orten.`,
  liveVerdictUndecided: (count: number, place: string, still: number, stillPlace: string, term: string) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place} · ${still === 1 ? "1 liegt" : `${still} liegen`} noch in ${stillPlace}, wo deine Regel für Text mit »${term}« sie halten kann.`,
  liveVerdictStillLegacy: (count: number, place: string, still: number, folder: string, stillPlace: string) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place} · ${still === 1 ? "1 liegt" : `${still} liegen`} noch im Ordner ${folder}, dem alten Namen von ${stillPlace}.`,
  liveVerdictApplying: (count: number, place: string) =>
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place}. Auf den Rest ihrer Post im Postfach wendet ohmail die Regel gerade an.`,
  liveDecideFailed: (sender: string) =>
    `Diese Entscheidung ließ sich nicht speichern — ${sender} wartet weiter.`,
  liveDecideUndoLate: "Zu spät — diese Entscheidung ist schon raus.",
  undoReplaced: "Eine spätere Wahl für diesen Absender hat diese ersetzt, hier gibt es nichts rückgängig zu machen.",
  /*
   * ── THE DESTINATION LEADS, BECAUSE GERMAN CANNOT TAKE IT AFTER A PREPOSITION ────────────────
   *
   * The English is "Released 3 held messages to News". Translated literally that is "… nach
   * Belege freigegeben", and it is wrong: the place names have genders and numbers ("die Belege",
   * "die Ohbox"), so any preposition in front of a `${dest}` hole needs a case the hole cannot
   * carry. Naming the destination first and following it with a dash removes the preposition
   * entirely — the shape the web client's own screening toasts use ("{place} — …"), so this is
   * following the product rather than inventing for the phone.
   */
  liveReleased: (n: number, dest: string) =>
    `${dest} — ${n === 1 ? "1 zurückgehaltene Nachricht" : `${n} zurückgehaltene Nachrichten`} freigegeben. Es wurde keine Regel geändert.`,
  liveReleasedRuled: (n: number, dest: string) =>
    `${dest} — ${n === 1 ? "1 zurückgehaltene Nachricht" : `${n} zurückgehaltene Nachrichten`} freigegeben; die zurückhaltende Regel sortiert jetzt auch dorthin ein.`,
  liveReleasedAddress: (n: number, dest: string, domain: string) =>
    `${dest} — ${n === 1 ? "1 zurückgehaltene Nachricht" : `${n} zurückgehaltene Nachrichten`} freigegeben; dieser Absender ist dort ab jetzt zugelassen, die Regel für ${domain} sortiert alle anderen dort weiterhin aus.`,
  liveReleaseRuleStands: (sender: string, domain: string) =>
    `Nichts geändert — die Regel für ${domain} entscheidet über Post von ${sender}. Ändern kannst du sie im Web unter Einstellungen → Regeln.`,
  liveReleaseFailed: (sender: string) =>
    `Diese Freigabe ließ sich nicht speichern — Post von ${sender} liegt, wo sie lag.`,
  livePileAdded: (title: string) => `${title} — hinzugefügt.`,
  livePileFailed: (title: string) => `${title} — ließ sich nicht speichern. Versuch es nochmal.`,
  liveBodyLoading: "Die ganze Nachricht wird geladen…",
  liveBodyFailed: "Nur die Vorschau ließ sich laden. Öffne sie erneut, um es nochmal zu versuchen.",
  liveBodyWithheld:
    "Nicht gespeichert — dein Speicherplatz war voll, als sie ankam. Das hier ist die Vorschau; die Nachricht selbst liegt sicher in deinem Postfach auf deinem Mailserver.",
  liveBodyWithheldJunk:
    "Hier nicht gespeichert — dein Spam-Urteil hat diese Nachricht in den Spam-Ordner deines eigenen Mailservers einsortiert. Dort lebt sie weiter; das hier ist die Vorschau.",
  liveBodyWithheldExpunged:
    "Keine gespeicherte Kopie mehr — jede Kopie dieser Nachricht ist aus den Ordnern verschwunden, die ohmail auf deinem Mailserver liest: dort gelöscht oder von einem anderen Mailprogramm verschoben. Diese Vorschau ist, was bleibt.",
  liveBodyWithheldTooLarge:
    "Nicht heruntergeladen — diese Nachricht ist größer als 64 MB, mehr lädt ohmail nicht herunter. Text und Dateien werden hier deshalb nicht gezeigt. Öffne sie bei deinem Mailanbieter.",
  liveBodyJunkLoading: "Diese Nachricht wird von deinem Mailserver geladen…",

  /* ------------------------------------------------- the mail body's frame */

  mailImagesBlockedOne: "1 externes Bild blockiert.",
  mailImagesBlockedMany: (n: number) => `${n} externe Bilder blockiert.`,
  mailPixelOne: "Eines davon ist ein Zählpixel.",
  mailPixelMany: (n: number) => `${n} davon sind Zählpixel.`,
  mailPixelOnly: "Ein Zählpixel wurde blockiert.",
  mailPixelsRefused: (n: number) => `${n} Zählpixel wurden blockiert.`,
  mailSheetBlockedOne:
    "Ein externes Stylesheet wurde blockiert; diese Nachricht kann darum schlicht aussehen.",
  mailSheetBlockedMany: (n: number) =>
    `${n} externe Stylesheets wurden blockiert; diese Nachricht kann darum schlicht aussehen.`,
  mailImagesFromPhone:
    "Bilder werden von diesem Telefon geladen; jeder Absender sieht darum seine Netzwerkadresse.",
  mailImagesFromComputer:
    "Bilder werden über deinen Computer geladen; jeder Absender sieht darum dessen Netzwerkadresse.",
  mailImagesRefused: "Die Bilder konnten nicht geladen werden. Versuch es noch einmal.",
  mailImagesTooLarge:
    "Mit den Bildern ist diese Nachricht zu groß, um sie sicher darzustellen; die Bilder werden darum nicht angezeigt.",
  mailShowImages: "Bilder anzeigen",
  mailShowAsText: "Als Text anzeigen",
  mailShowOriginal: "Original anzeigen",
  bodyShowMore: (percent: number) => `Mehr anzeigen (${percent} % angezeigt)`,
  mailOversize:
    "Der HTML-Teil dieser Nachricht ist zu groß, um ihn sicher darzustellen. Die Textfassung wird gezeigt.",
  mailOpenLinkTitle: "Diesen Link öffnen?",
  mailOpenLinkOpen: "Öffnen",
  mailOpenLinkCancel: "Abbrechen",
  linkOpenRefused: "Nichts auf diesem Telefon kann diesen Link öffnen.",
  attachmentEmbedded: "eingebettet",
  attachmentEmbeddedLabel: (name: string) => `${name}, eingebettet`,
  attachmentOpening: "Wird geöffnet…",
  attachmentTooLarge: "Diese Datei ist zu groß, um sie hier zu öffnen.",
  attachmentFaultOhmail: "ohmail konnte diese Datei nicht holen.",
  attachmentFaultBusy: "ohmail hat die Verbindungen zu diesem Postfach schon offen.",
  attachmentFaultUnreachable: "Dein Mailserver hat nicht geantwortet.",
  attachmentFaultServerBusy: "Dein Mailserver bedient dieses Postfach gerade nicht.",
  attachmentFaultNotSecured: "Dein Mailserver hat die Verbindung nicht gesichert, darum wurde die Datei nicht geholt.",
  attachmentFaultLoginRefused: "Dein Mailserver hat die Anmeldung abgelehnt. Prüf das Passwort des Postfachs in den Einstellungen.",
  attachmentFaultReconnect: "Die Anmeldung dieses Postfachs ist abgelaufen. Verbinde es in den Einstellungen neu.",
  attachmentFaultNotSignedIn: "Dieses Postfach ist hier nicht angemeldet. Melde es in den Einstellungen neu an.",
  attachmentFaultGone: "Diese Nachricht ist nicht dort, wo dein Postfach sie hatte. Sie wurde verschoben oder gelöscht.",
  attachmentFaultRefused: "ohmail kann diese Datei hier nicht holen.",
  attachmentFaultOffline: "ohmail war nicht erreichbar. Prüf deine Verbindung.",
  attachmentFaultSignedOut: "Deine Sitzung ist beendet. Melde dich neu an.",
  attachmentTapToRetry: "Tippe, um es nochmal zu versuchen.",
  attachmentShareRefused: "Nichts auf diesem Telefon kann diese Datei öffnen.",
  mailFrameLabel: "Nachrichteninhalt",

  /* -------------------------------------------------------- message actions */

  routedBy: "Warum sie hier gelandet ist",
  earlierInThread: (n: number) =>
    n === 1
      ? "Früher in diesem Verlauf — vollständig gezeigt"
      : `Früher in diesem Verlauf — alle ${n} gezeigt`,
  openMessage: "Öffnen",
  back: "Zurück",

  actionReply: "Antworten",
  actionReplyAll: "Allen antworten",
  actionForward: "Weiterleiten",
  actionLater: "Später",
  actionSetAside: "Parken",
  actionResurface: "Wieder auftauchen",
  actionTag: "Tag",
  actionScreening: "Einordnen",
  actionMove: "Verschieben",
  actionMarkRead: "Als gelesen markieren",
  actionMarkUnread: "Als ungelesen markieren",
  actionDone: "Erledigt",
  actionMore: "Mehr",
  tabMore: "Mehr",
  standaloneName: "ohmail auf diesem Telefon",

  actionDelete: "Löschen",
  deleteAsk: "Diese Nachricht löschen?",
  deleteNote:
    "Sie wandert in den Papierkorb-Ordner auf deinem eigenen Mailserver — ohmail löscht nie unwiderruflich. Ab dort gelten die Papierkorb-Regeln deines Mailservers.",
  toastDeleted: "In den Papierkorb verschoben.",
  deleteFailed: "Das Löschen konnte nicht gespeichert werden — die Nachricht ist noch an ihrem Platz.",

  resurfaceWhen: "Wann wieder auftauchen?",
  resurfaceNow: "Jetzt",
  resurfaceTomorrow: "Morgen",
  resurfaceNextWeek: "Nächste Woche",
  resurfacePick: "Datum wählen",
  /** The hour the three dated answers land at (mail 0110) — the webapp strip's own word,
   *  standing over the sheet's first row and over the half-hour list it opens. */
  resurfaceTime: "Uhrzeit",
  resurfaceSkipNote: (horizon: string, booked: string, asked: string) =>
    `${horizon}: ${booked} — die Uhren überspringen ${asked} in dieser Nacht.`,

  /*
   * "verschieben nach" sits directly above the destination rows (`→ Belege`, `→ Ohbox`), which
   * recreates exactly the case problem `toastMoved` was fixed for: "nach" wants a case the place
   * names cannot carry. The web catalogue says the same thing (`ohbox.moveLabel`) and, by the
   * ruling that settled `toastMoved`, a matching translation elsewhere is a SHARED DEFECT rather
   * than evidence. A bare noun heading takes no case and reads correctly above every row; the web
   * client's twin is filed to be fixed the same way.
   */
  moveLabel: "Ziel",
  moveCancel: "Abbrechen",

  placeOhbox: "Ohbox",
  placeReads: "News",
  placeReceipts: "Belege",
  placeScreened: "Aussortiert",
  placeSpam: "Spam",

  toastQueued: "In „Später antworten“ vorgemerkt",
  toastUnqueued: "Aus „Später antworten“ entfernt",
  toastAside: "Geparkt",
  toastUnparked: "Nicht mehr geparkt",
  toastResurface: (when: string) => `Taucht ${when} wieder auf`,
  toastResurfaceCleared: "Taucht nicht wieder auf",
  toastResurfaceNow: "Wieder ganz oben",
  toastResurfaceDone: "Erledigt — unter „Gesehen“ abgelegt",
  toastSentAndDone: "Gesendet · erledigt",
  /*
   * CASE-NEUTRAL, and this one diverges from the web client's German ON PURPOSE.
   *
   * "Nach Belege verschoben." is wrong — "nach" wants a case the place name cannot carry, and the
   * places have gender and number ("die Belege", "die Ohbox"). The web catalogue said the same
   * thing and matching it was the argument for leaving this alone; a matching translation on
   * another surface is evidence of a SHARED DEFECT, not that the sentence is correct. The colon
   * takes no case, so this reads for every destination. The web twin was repaired the same way
   * and has since been retired with its caller, so this is the only home of the sentence.
   */
  toastMoved: (place: string) => `Verschoben: ${place}.`,
  /* Die Worte des Web-Katalogs (`screening.toastRuledMoved` / `toastRuledFuture`), siehe `copy.en.ts`. */
  toastRuledMoved: (place: string, n: number, sender: string) =>
    `${place} — ${n === 1 ? `1 Nachricht von ${sender} verschoben` : `${n} Nachrichten von ${sender} verschoben`}. Künftige Post von ihm geht auch dorthin. Ihre übrige Post hier bleibt, wo sie ist.`,
  toastRuledFuture: (place: string, sender: string) =>
    `${place} — künftige Post von ${sender} geht auch dorthin. Post, die schon hier ist, bleibt, wo sie ist.`,
  toastMoveAlready: (place: string) => `Schon in ${place}.`,
  /** Siehe `copy.en.ts`: 202 heisst vorgemerkt, nicht erledigt — verschoben wurde nichts. */
  toastMoveQueued: (place: string, holder: string) =>
    `Für ${holder} vorgemerkt — beim nächsten Durchgang: ${place}.`,
  toastMoveQueuedUnknown: (place: string) =>
    `Für den Organizer vorgemerkt — beim nächsten Durchgang: ${place}.`,
  toastDeleteQueued: (holder: string) => `Für ${holder} vorgemerkt — gelöscht wird beim nächsten Durchgang.`,
  toastDeleteQueuedUnknown: "Für den Organizer vorgemerkt — gelöscht wird beim nächsten Durchgang.",
  /* UNDO — die Worte des Web-Katalogs (`ohbox.undo`-Familie). */
  undo: "Rückgängig",
  toastUndone: "Rückgängig gemacht.",
  deleteUndone: "Nicht gelöscht — die Nachricht ist noch an ihrem Platz.",
  deleteUndoLost: "Das Rückgängigmachen konnte nicht gespeichert werden — die Nachricht ist im Papierkorb.",
  toastRoutingUndone: "Die Post ist wieder da, wo sie war, und es wurde keine Regel angelegt.",
  /* Siehe `copy.en.ts`. Der Doppelpunkt vor dem Ort nimmt keinen Fall — `toastMoved`s Regel. */
  routingReplayedTo: (n: number, place: string) =>
    n === 1
      ? `Beim Schließen von ohmail wartete noch 1 Nachricht — verschoben: ${place}.`
      : `Beim Schließen von ohmail warteten noch ${n} Nachrichten — verschoben: ${place}.`,
  routingReplayed: (n: number) =>
    n === 1
      ? "Beim Schließen von ohmail wartete noch 1 Nachricht — jetzt verschoben."
      : `Beim Schließen von ohmail warteten noch ${n} Nachrichten — jetzt verschoben.`,
  routingReplayExpired: (n: number) =>
    `${n === 1 ? "1 Regel wurde" : `${n} Regeln wurden`} nie angelegt — seit der Anfrage ist zu viel Zeit vergangen. Verschiebe die Post noch einmal, wenn du die Regel weiterhin willst.`,
  deleteReplayExpired: (n: number) =>
    `${n === 1 ? "1 Nachricht wurde" : `${n} Nachrichten wurden`} nicht in den Papierkorb verschoben — seit der Anfrage ist zu viel Zeit vergangen. Lösche sie noch einmal, wenn du das weiterhin willst.`,
  deleteReplayGone: (n: number) =>
    `${n === 1 ? "1 Nachricht wurde" : `${n} Nachrichten wurden`} nicht in den Papierkorb verschoben — dieses Telefon hat sie beim nächsten Start nicht gefunden. Lösche sie noch einmal, wenn du das weiterhin willst.`,
  /* Das Angebot der Ohbox — die `screener.unscreened*`-Sätze des Web-Katalogs, Wort für Wort. */
  unscreenedLead: (n: number) =>
    n === 1
      ? "1 Nachricht von einem Absender, über den du nie entschieden hast, liegt noch im Posteingang auf deinem Mailserver."
      : `${n} Nachrichten von Absendern, über die du nie entschieden hast, liegen noch im Posteingang auf deinem Mailserver.`,
  unscreenedAll: (n: number) => `${n} in den Screener`,
  unscreenedMoved: (n: number) => `${n} in den Screener gelegt. Dein Organizer verschiebt sie beim nächsten Durchlauf.`,
  unscreenedMovedNone: "Nichts mehr zu screenen.",
  unscreenedFailed: "Screenen nicht möglich. Versuch es noch einmal.",
  toastRead: "Als gelesen markiert.",
  toastUnread: "Als ungelesen markiert.",
  /* ALLES ALS GELESEN — der `markAll`-Namespace des Web-Katalogs. */
  markAll: "Alles als gelesen markieren",
  markAllAria: (n: number) =>
    n === 1
      ? "1 ungelesene Nachricht als gelesen markieren"
      : `Alle ${n} ungelesenen Nachrichten als gelesen markieren`,
  markAllAriaFresh: (n: number) =>
    n === 1
      ? "1 Nachricht, die seit deinem letzten Besuch neu ist, als gelesen markieren"
      : `Alle ${n} Nachrichten, die seit deinem letzten Besuch neu sind, als gelesen markieren`,
  markAllDone: (n: number) =>
    n === 1 ? "1 Nachricht als gelesen markiert" : `${n} Nachrichten als gelesen markiert`,
  /* TRASH — die Sätze des Web-Katalogs (`trash`-Namespace), wo die Fläche dieselbe ist. */
  trashTitle: "Papierkorb",
  trashEmptyTitle: "Der Papierkorb ist leer.",
  trashEmptyHint: "Mails, die du in ohmail löschst, erscheinen hier.",
  trashUnavailable: "Der Papierkorb ist hier nicht verfügbar.",
  trashFoot:
    "Mails, die du in ohmail gelöscht hast — die einzigen gelöschten Mails, die ohmail zurücklegen kann. In anderen Apps gelöschte Mails bleiben im Papierkorb deines Mailservers — und dein Mailserver entscheidet, wie lange er sie behält.",
  trashDeletedAt: (when: string) => `Gelöscht ${when}`,
  trashFromLine: (name: string, address: string) => `${name} · ${address}`,
  /* Nominativ nach Doppelpunkt-freiem „in": Dativ ist hier fest — „legt sie zurück in den …"
     bräuchte den Artikel des Ortsnamens; die Ortsnamen sind Eigennamen (Ohbox, News), also
     ohne Artikel, wie der Web-Katalog sie in `toastRestoringTo` verwendet. */
  trashRestoresTo: (place: string) => `Wiederherstellen legt sie zurück in ${place}.`,
  trashRestore: "Wiederherstellen",
  trashRestoring: "Wird wiederhergestellt…",
  trashToastRestoring: (place: string) => `Wird in ${place} wiederhergestellt…`,
  trashToastRestoreFailed: "Konnte nicht wiederhergestellt werden — sie ist noch im Papierkorb.",
  trashNoErase: "ohmail löscht nie unwiderruflich — zum endgültigen Entfernen nutze deinen eigenen Mail-Client.",
  trashListFailed: "Der Papierkorb ließ sich gerade nicht lesen.",
  trashRetry: "Nochmal versuchen",
  trashShowOlder: "Ältere zeigen",
  trashRowGone: "Diese Nachricht ist nicht mehr im Papierkorb.",
  trashPreviewNote: "Das ist die gespeicherte Vorschau — stelle die Nachricht wieder her, um alles zu lesen.",
  pressQueuedForOrganizer: (holder: string) =>
    `Für ${holder} vorgemerkt — passiert beim nächsten Durchgang.`,
  pressQueuedForOrganizerUnknown: "Für den Organizer vorgemerkt — passiert beim nächsten Durchgang.",
  organizerStillWaiting: (holder: string) => `Warte weiterhin auf ${holder}.`,
  organizerStillWaitingUnknown: "Warte weiterhin auf den Organizer.",

  replyTo: (name: string) => `Antwort an ${name}`,
  replyToAll: (names: string) => `Antwort an ${names}`,
  replyCcLine: (names: string) => `Kopie an ${names}`,
  replyPlaceholder: "Schreib deine Antwort …",
  replySend: "Senden",
  sendAndDone: "Senden + Erledigt",
  replyCancel: "Abbrechen",
  replySending: "Wird gesendet …",
  replySent: "Antwort gesendet.",
  replyEarlierWent: "Diese Antwort wurde bereits gesendet. Dein neuerer Text wurde nicht als zweite Kopie gesendet.",
  earlierGoing: "Eine frühere Fassung dieser Nachricht wird bereits gesendet. Dein neuerer Text wird nicht als zweite Kopie gesendet.",
  replyQueued: "Noch nicht gesendet. ohmail versucht es weiter.",
  replySendingLong: "Sendet noch.",
  replyQueuedOffline: "Noch nicht gesendet. Dieses Telefon hat kein Netz; die Nachricht geht raus, sobald es wieder da ist.",
  replyUnverified: "Wir konnten diesen Versand nicht bestätigen. Schau in deinen Gesendet-Ordner, bevor du nochmal sendest.",
  replyAlreadySent: "Zu spät zum Abbrechen. Diese Nachricht ist schon unterwegs.",
  replyCancelUnreachable: "Der Server war zum Abbrechen nicht erreichbar. ohmail fragt weiter nach und sendet das nicht noch einmal.",
  replyFailed: "Senden hat nicht geklappt. Versuch es nochmal.",
  replyNotSecured: "Nicht gesendet. Die Verbindung zu deinem Mailserver konnte nicht gesichert werden.",
  replyLoginRefused: "Nicht gesendet. Dein Mailserver hat die Anmeldung abgelehnt.",
  replyUnreachable: "Nicht gesendet. Dein Mailserver war nicht erreichbar.",
  replyNotSignedIn: "Nicht gesendet — dein Entwurf ist gesichert. Dieses Postfach ist hier nicht angemeldet. Melde es in den Einstellungen neu an.",
  replyForwardOriginalUnavailable: "Nicht gesendet. Das Original konnte nicht geladen werden, darum wurde es nicht weitergeleitet.",
  composeNotSentOffline: "Nicht gesendet. Dieses Telefon erreicht deinen Mailserver nicht. Die Nachricht liegt in den Entwürfen — sende sie erneut, sobald du wieder online bist.",
  replyUnverifiedAgain: "Nicht nochmal gesendet. Der erste Versand ist vielleicht schon raus, schau also zuerst in deinen Gesendet-Ordner.",
  /* Die Anhänge des Editors — `apps/webapp/messages/de.json` (`compose.attach*`) byte für Byte,
     wo der Satz dort existiert. */
  attachFile: "Dateien anhängen",
  attachPhoto: "Ein Foto anhängen",
  attachCap: (size: string) => `Bis zu ${size} insgesamt`,
  attachRefused: (size: string) =>
    `Einige Dateien wurden nicht hinzugefügt — sie hätten das Total über ${size} gebracht.`,
  attachUnreadable: "Einige Dateien konnten nicht gelesen werden und wurden nicht hinzugefügt.",
  attachDuplicate: (filenames: string) => `Bereits angehängt: ${filenames}`,
  attachRemove: (filename: string) => `${filename} entfernen`,
  attachUnavailable: "Dateien können auf diesem Gerät gerade nicht ausgewählt werden.",
  composeNeedContent: "Schreib etwas oder häng eine Datei an.",
  forwardHead: "Weiterleiten — du wählst, wer sie bekommt",
  forwardAskOtp: "ohmail hat in dieser Nachricht einen Einmalcode erkannt.",
  forwardAskVerification: "ohmail hat diese Nachricht als Kontobestätigung erkannt.",
  forwardAskPasswordReset: "ohmail hat diese Nachricht als Passwort-Zurücksetzung erkannt.",
  forwardAskSecurityAlert: "ohmail hat diese Nachricht als Sicherheitswarnung zu einem Konto erkannt.",
  forwardAskSensitive: "ohmail hat diese Nachricht als vertraulich markiert.",
  forwardAskQuestion: "Trotzdem weiterleiten?",
  forwardTo: "An",
  forwardToPlaceholder: "name@beispiel.de, …",
  forwardNotePlaceholder: "Notiz hinzufügen (optional)",
  forwarded: "Weitergeleitet.",
  forwardedTo: (name: string) => `Weitergeleitet an ${name}`,
  forwardEarlierWent: "Diese Weiterleitung wurde bereits gesendet. Dein neuerer Text wurde nicht als zweite Kopie gesendet.",
  /* NEUE NACHRICHT — derselbe Editor ohne Vorlage. */
  composeNew: "Neue Nachricht",
  rowSentTo: (name: string) => `Ich → ${name}`,
  rowSentToMore: (name: string, more: number) => `Ich → ${name} +${more}`,
  composeNewHead: "Neue Nachricht",
  composeSubject: "Betreff",
  composeSubjectPlaceholder: "Worum es geht (optional)",
  composeBodyPlaceholder: "Schreib deine Nachricht…",
  composeToPlaceholder: "name@beispiel.de, …",
  composeFrom: (address: string) => `Von ${address}`,
  composeSent: "Gesendet.",
  composeEarlierWent: "Diese Nachricht wurde bereits gesendet. Dein neuerer Text wurde nicht als zweite Kopie gesendet.",
  composeKept: "In den Entwürfen behalten.",
  composeKeptWithoutFiles: "In den Entwürfen behalten. Die Anhänge wurden nicht behalten.",
  composeKeptQueued: "Als Entwurf behalten. Er erscheint in den Entwürfen, sobald dieses Telefon wieder online ist.",
  composeKeptQueuedWithoutFiles:
    "Als Entwurf behalten, ohne die Anhänge. Er erscheint in den Entwürfen, sobald dieses Telefon wieder online ist.",
  composeKeepFailed: "Das konnte nicht als Entwurf behalten werden. Schließe noch einmal, um es zu verwerfen.",
  composeKeepFiles: "Entwürfe behalten keine Anhänge. Schließe noch einmal, um sie zu verwerfen.",
  composeNeedRecipient: "Trag jemanden ein, an den sie gehen soll.",
  composeNoMailbox: "Noch kann kein Postfach auf diesem Telefon senden.",
  composeNoMailboxHint: "Sobald dieses Telefon Post hat, kannst du von diesem Postfach aus schreiben.",

  sendLater: "Später senden",
  sendLaterWhat: "Wann soll diese Nachricht gesendet werden?",
  sendLaterTonight: (when: string) => `Heute Abend (${when})`,
  sendLaterTomorrow: (when: string) => `Morgen früh (${when})`,
  sendLaterMonday: (when: string) => `Montagmorgen (${when})`,
  sendLaterPick: "Datum und Uhrzeit wählen",
  sendLaterClose: "Zurück",
  sendLaterPast: "Diese Zeit ist vorbei. Wähle eine Zeit in der Zukunft.",
  sendLaterZone: (zone: string) => `Zeiten in deiner Zeitzone (${zone}).`,
  sendLaterUnavailable: "Später senden ist für Nachrichten mit Anhängen oder Weiterleitungen noch nicht verfügbar.",
  scheduledFor: (when: string) => `Geplant für ${when}.`,

  scheduled: "Geplant",
  scheduledWhen: (when: string) => `Wird gesendet: ${when}`,
  scheduledCancel: "Versand abbrechen",
  scheduledNoSubject: "(kein Betreff)",
  scheduledNoRecipient: "Noch kein Empfänger",
  scheduleFailedNote: (reason: string) =>
    `Diese Nachricht wurde zur geplanten Zeit nicht gesendet: ${reason}`,
  scheduleCancelled: "Geplanter Versand abgebrochen. Die Nachricht liegt in den Entwürfen.",
  scheduleCancelTooLate: "Zu spät zum Abbrechen — diese Nachricht wird gerade gesendet.",
  scheduleCancelQueued:
    "Keine Verbindung — das Abbrechen hat den Server noch nicht erreicht. Die Nachricht ist bis dahin weiterhin geplant.",
  scheduledEmpty: "Nichts geplant. Nachrichten, die du später sendest, warten hier bis zu ihrer Zeit.",
  scheduledEditNote:
    "Abbrechen legt die Nachricht zurück in die Entwürfe, wo du sie in ohmail im Web oder auf dem Desktop bearbeiten und senden kannst.",
  scheduledWhenUnknown: "Wird zur geplanten Zeit gesendet",
  scheduledNotSent: "Nicht gesendet",
  scheduledNotOnThisPhone:
    "Dieses Telefon organisiert dein Postfach nur, solange ohmail darauf läuft, und kann eine Nachricht deshalb nicht für einen späteren Zeitpunkt aufbewahren. Sende jetzt, oder plane den Versand auf einem Computer oder in ohmail Cloud.",
  scheduledReaderHere: (name: string) =>
    `Dieses Telefon liest dein Postfach und ${name} organisiert es, deshalb kann dieses Telefon keine Nachricht für einen späteren Zeitpunkt aufbewahren. Sende jetzt, oder plane den Versand auf ${name}.`,
  scheduledReaderHereStopped: (name: string) =>
    `Dieses Telefon liest dein Postfach und ${name} organisiert es nicht mehr, deshalb kann dieses Telefon keine Nachricht für einen späteren Zeitpunkt aufbewahren. Sende jetzt, oder plane den Versand auf ${name}, sobald es wieder läuft.`,

  awayTitle: "Abwesenheitsantwort",
  awayOn: "An. Antwortet auf neue Mail, aus dem Postfach, in dem sie ankam.",
  awayOff: "Aus. Es wird nichts gesendet.",
  awayBodyLabel: "Nachricht",
  awaySwitchOn: "An",
  awaySwitchOff: "Aus",
  awayAudienceLabel: "Wer eine Antwort bekommt",
  awayScreenedIn: "Leute, die ich reingelassen habe",
  awayEveryone: "Alle, die schreiben",
  awayThrottleLabel: "Wie oft pro Person",
  awayAlways: "Jede Nachricht",
  awayPerMessage: "Einmal, bis du den Text änderst",
  awayPerDay: "Höchstens einmal am Tag",
  awayPerWeek: "Höchstens einmal pro Woche",
  awayPilesLabel: "Welche Mail eine Antwort bekommt",
  awayPileOhbox: "Ohbox",
  awayPileReads: "News",
  awayPileReceipts: "Belege",
  awayPileScreener: "Screener",
  awayNever:
    "Wird nie an Mailinglisten gesendet, an No-Reply-Adressen, an das Benachrichtigungspostfach "
    + "einer Website oder eines Servers, an Sicherheitsmail, an Spam, an Absender, die du "
    + "abgewiesen hast, an deine eigenen Adressen oder an eine Adresse, die zurückkam.",
  awayUntilLabel: "Automatisch ausschalten am",
  awayUntilNone: "Kein Enddatum",
  awayUntilPick: "Datum wählen",
  awayUntilClear: "Enddatum entfernen",
  awayUntilOn: (date: string) => `An bis ${date}.`,
  awayUntilPast: (date: string) => `Das Enddatum war am ${date}. Es wird nichts gesendet.`,
  awayUntilExpired: "Wähle ein Datum in der Zukunft, oder schalte die Antwort aus.",
  awaySave: "Speichern",
  awaySaving: "Wird gespeichert …",
  awaySaved: "Gespeichert.",
  awayAsked: "Nicht hier gespeichert — die Maschine, die dieses Postfach organisiert, wendet es bei ihrem nächsten Durchlauf an.",
  awayRefused: (name: string, unreadable: boolean) =>
    `Nicht übernommen — ${name} ${unreadable ? "konnte diese Änderung nicht lesen. Aktualisiere ohmail dort und speichere sie dann noch einmal." : "hat diese Änderung nicht angenommen. Speichere sie noch einmal."}`,
  awayRefusedUnknown: (unreadable: boolean) =>
    `Nicht übernommen — die Installation, die dieses Postfach organisiert, ${unreadable ? "konnte diese Änderung nicht lesen. Aktualisiere ohmail dort und speichere sie dann noch einmal." : "hat diese Änderung nicht angenommen. Speichere sie noch einmal."}`,
  awayFailed: "Das wurde nicht gespeichert. Es hat sich nichts geändert.",
  awayFailedStillOn: "Konnte nicht gespeichert werden — die Antwort ist weiterhin an.",
  awayFailedStillOff: "Konnte nicht gespeichert werden — die Antwort ist weiterhin aus.",
  awayIncomplete: "Schreib eine Nachricht, bevor du das einschaltest.",
  awayUnreachable: "Deine Abwesenheitseinstellungen konnten gerade nicht gelesen werden. Hier hat sich nichts geändert.",
  awayRow: "Abwesenheitsantwort",
  awayRowSub: "Eine automatische Antwort, solange du weg bist.",
  awayScopeElsewhere: "Diese stellst du auf einem Computer oder in ohmail Cloud ein. Dieses Telefon schickt sie unverändert zurück.",
  awayPileOther: (folder: string) => `Auch ${folder}`,
  awayPilesNone: "Keine Ablage bekommt eine Antwort, es wird also nichts gesendet.",
  awayWhereThisPhone: "Antworten werden gesendet, solange ohmail auf diesem Telefon läuft.",
  awayWhereHost: (host: string) => `Antworten werden gesendet, solange ohmail auf ${host} läuft.`,
  awayChangedElsewhere: "Auf einem anderen Gerät geändert. Das sind die Abwesenheitseinstellungen, die jetzt gelten.",

  draftsTitle: "Entwürfe",
  draftsExplainer: "Nachrichten, die du begonnen und nicht gesendet hast.",
  draftsMeta: (total: number, held: number): string => {
    const drafts = total === 1 ? "1 Entwurf" : `${total} Entwürfe`;
    return held === 0 ? drafts : `${drafts} · ${held} nicht bestätigt`;
  },
  draftsEmptyTitle: "Nichts Halbfertiges",
  draftsEmptyHint: "Sie liegen in deinem Konto und sind deshalb auf jedem Gerät da, auf dem du deine Mail liest.",
  draftsIsReply: "Antwort",
  draftsHeldChecking: "Wir sind nicht sicher, ob diese Nachricht gesendet wurde. Wir schauen in deinem Gesendet-Ordner nach.",
  draftsHeldNotInSent: "Wir sind nicht sicher, ob diese Nachricht gesendet wurde. In deinem Gesendet-Ordner ist sie nicht.",
  draftsHeldInterrupted: "Wir sind nicht sicher, ob diese Nachricht gesendet wurde — der Versand wurde unterbrochen.",
  draftsSendAgain: "Noch einmal senden",
  draftsItWasSent: "Sie wurde gesendet — ausblenden",
  draftsSendAgainWhat: "Sendet diese Nachricht so, wie sie ist.",
  draftsResolveFailed: "Das hat den Server nicht erreicht. Die Nachricht wird hier weiterhin festgehalten.",
  draftsResolveStillRunning: "Dieser Versand läuft möglicherweise noch. Du kannst ihn beantworten, sobald er beendet ist.",
  draftsBodyUnavailable: "Der Text dieses Entwurfs hat dieses Gerät noch nicht erreicht. Versuch es gleich noch einmal.",
  draftsDiscard: "Verwerfen",
  draftsDiscardWhat: "Das löscht die einzige Kopie.",
  draftsDiscardConfirm: "Verwerfen",
  draftsDiscardCancel: "Behalten",
  draftsDiscardStillSending:
    "Nicht verworfen — diese Nachricht wird gerade gesendet, oder ihr Versand wird noch bestätigt. Versuch es in ein paar Minuten noch einmal.",
  draftsDiscardRefused: (reason: string) => `Nicht verworfen: ${reason}`,
  draftsDiscardRefusedUnnamed:
    "Das ist nicht durchgegangen, und der Server hat nicht gesagt, warum. Der Entwurf ist noch da.",
  draftsDiscardQueued:
    "Noch nicht verworfen — dieses Telefon konnte dein Konto nicht erreichen. Wir versuchen es weiter.",
  draftsDiscardAwaitingOrganizer:
    "Angefragt. Die Installation, die dieses Postfach organisiert, verwirft ihn bei ihrem nächsten Durchlauf.",
  draftsOpenConversation: "Unterhaltung öffnen",
  draftsEditNote:
    "Dieser Entwurf lässt sich hier nicht bearbeiten. Bearbeiten und senden kannst du ihn in ohmail im Web oder auf dem Desktop.",
  draftsForwardOriginalAbsent:
    "Die Nachricht, die dieser Entwurf weiterleitet, ist nicht auf diesem Telefon. Bearbeiten und senden kannst du ihn in ohmail im Web oder auf dem Desktop.",
  draftsEdit: "Bearbeiten",
  draftsRowGone: "Dieser Entwurf ist nicht mehr in den Entwürfen.",
  draftsTextHeading: "Nachricht",
  draftsTextEmpty: "Noch nichts geschrieben.",

  sigLabel: "Signatur",
  sigRemove: "Signatur für diese Nachricht entfernen",
  sigAria: "Signatur — Teil dieser Nachricht; hier bearbeiten oder entfernen",

  tagPlaceholder: "Diese Nachricht taggen …",
  tagNone: "Noch keine Tags. Tipp einen Namen, um den ersten anzulegen.",
  tagCreate: (name: string) => `„${name}“ anlegen`,
  tagTagged: (name: string) => `Mit „${name}“ getaggt.`,
  tagUntagged: (name: string) => `Tag „${name}“ entfernt.`,
  tagNotOnServer:
    "Tags speichert ohmail, nicht dein Postfach. Deine Ordner sind echte IMAP-Ordner und bleiben, wenn du gehst; Tags nicht — wenn du dein Konto löschst, sind sie weg.",
  tagsTitle: "Tags",
  tagMeta: (n: number) => `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`}`,
  tagEmptyTitle: "Noch nichts trägt diesen Tag.",
  tagEmptyHint: "Öffne eine Nachricht und wähle Tag, um ihn zu setzen.",
  tagGone: "Diesen Tag gibt es hier nicht mehr.",


  screenerNothingDeleted: "Es wurde nichts gelöscht. Jede zurückgehaltene Nachricht ist einen Tipp entfernt, vollständig.",
  folderGone: "Diesen Ordner gibt es hier nicht mehr.",
  messageGone: "Diese Nachricht gibt es hier nicht mehr.",
  senderGone: "Dieser Absender steht nicht mehr im Screener.",
  senderFirstContact:
    "Erster Kontakt. Von diesem Absender hat es noch nichts in die Ohbox geschafft — es hat hier gewartet.",
  senderAiSuggestion: (dest: string, confidence: string, reason: string): string =>
    `Die KI schlägt ${dest} vor, mit ${confidence}: „${reason}“`,
  senderAiSuggestionNoReason: (dest: string, confidence: string): string =>
    `Die KI schlägt ${dest} vor, mit ${confidence}.`,

  bootBadOrigin: (origin: string) => `keine Server-Adresse: „${origin}“`,
  bootBadApiBase: (base: string) => `keine API-Adresse des Servers: „${base}“`,
  bootApiBaseOffOrigin: (base: string, origin: string) =>
    `die API-Adresse dieses Servers, „${base}“, liegt nicht auf der gekoppelten Adresse „${origin}“ — `
    + "koppele diesen Server erneut, damit sie erfasst wird",
  bootLocalEngineOffOrigin: (expected: string, origin: string) =>
    `die Engine einer eigenständigen Installation ist unter „${expected}“ erreichbar, nicht unter `
    + `„${origin}“ — wer sowohl eine lokale Engine als auch eine entfernte Adresse übergibt, hat `
    + "sich nicht entschieden, mit welcher der beiden gesprochen wird",
  bootNeedsCredential: "eine Anmeldung und eine Konto-Kennung werden beide gebraucht",
  bootAccountMismatch: (serverSays: string, expected: string) =>
    `diese Anmeldung gehört zum Konto „${serverSays}“, nicht zu „${expected}“ — prüfe die eingegebene Konto-Kennung`,
  bootMirrorFailed: (detail: string) => `der Spiegel auf dem Gerät ließ sich nicht öffnen: ${detail}`,
  installMarkerUnopenable: (detail: string) =>
    `die Installationsmarke ließ sich nicht öffnen: ${detail}`,
  installPurgeFailed: (detail: string) =>
    `die Kopplungen der alten Installation ließen sich nicht entfernen: ${detail}`,
  installMarkerUnreadable: (detail: string) => `die Installationsmarke ließ sich nicht lesen: ${detail}`,
  /* Drei Absagen ohne Argument — der Wert im Schlüsselspeicher ist geheim; siehe `copy.en.ts`. */
  kekUnreadable:
    "Der Schlüsselspeicher dieses Telefons hält etwas, das kein Schlüssel ist, deshalb lässt sich "
    + "das damit versiegelte Postfach-Passwort nicht öffnen. ohmail ersetzt ihn nicht: ein neuer "
    + "Schlüssel würde dieses Passwort endgültig aussperren. Deine Post auf dem Server bleibt "
    + "unberührt — richte dieses Telefon für das Postfach neu ein, um von vorn zu beginnen.",
  kekNotGenerated:
    "Dieses Telefon konnte den Schlüssel für das Postfach-Passwort nicht erzeugen, deshalb wurde "
    + "nichts gespeichert und nichts versiegelt. Auf dem Server hat sich nichts geändert. Schließe "
    + "ohmail und öffne es erneut.",
  kekNotKept:
    "Der Schlüsselspeicher dieses Telefons hat den Schlüssel für das Postfach-Passwort angenommen "
    + "und nicht zurückgegeben, deshalb wurde nichts damit versiegelt. Auf dem Server hat sich "
    + "nichts geändert. Schließe ohmail und öffne es erneut.",
  connectSuperseded: "ein neuerer Verbindungsversuch hat übernommen.",

  /* "geht nach" + a place name has the same case problem; the web client's own heading for this
     pane asks the question instead (`screening.sectionWhere`: "Wohin ihre Post geht"). */
  screeningFor: (sender: string) => `Wohin die Post von ${sender} geht`,
  /* Carried with the English above; see `copy.en.ts` for why these live in the deck. */
  unsavedCount: (n: number): string =>
    (n === 1 ? "1 Änderung konnte nicht gespeichert werden" : `${n} Änderungen konnten nicht gespeichert werden`),
  unsavedPendingCount: (n: number): string =>
    (n === 1 ? "1 Änderung ist noch nicht durch" : `${n} Änderungen sind noch nicht durch`),
  unsavedQueuedWhy: "Dieses Telefon konnte dein Konto nicht erreichen. Es versucht es weiter.",
  unsavedShow: "Anzeigen",
  unsavedHide: "Ausblenden",
  unsavedRetry: "Erneut versuchen",
  unsavedDiscard: "Verwerfen",
  unsavedDismiss: "Schließen",
  unsavedNoReason: "Der Server hat es abgelehnt und nicht gesagt, warum.",
  unsavedSendAlreadyWent: "Diese Nachricht wurde bereits gesendet. Sie wurde nicht nochmal gesendet.",
  unsavedSuperseded: "Am selben Objekt wurde inzwischen eine neuere Änderung gespeichert, deshalb lässt sich diese nicht wiederholen.",
  unsavedKindOther: "Eine Änderung an deinem Postfach",
  unsavedKindMove: "Eine Nachricht einsortieren",
  unsavedKindDelete: "Eine Nachricht löschen",
  unsavedKindTriage: "Eine Nachricht zurückstellen",
  unsavedKindScreener: "Eine Screener-Entscheidung",
  unsavedKindRead: "Post als gelesen markieren",
  unsavedKindSend: "Eine Nachricht senden",
  unsavedKindDraft: "Einen Entwurf speichern",
  unsavedKindDraftDiscard: "Einen Entwurf verwerfen",
  unsavedKindSchedule: "Einen geplanten Versand abbrechen",
  unsavedKindTag: "Eine Tag-Änderung",
  unsavedKindFolder: "Eine Ordner-Änderung",
  unsavedKindRule: "Eine Regel-Änderung",

  screeningNote: (target: string) =>
    `Wird zur Regel — künftige Post von ${target} wird automatisch dorthin einsortiert. Post, die schon hier ist, bleibt, wo sie ist.`,
  screeningNoteRetro: (target: string) =>
    `Wird zur Regel — künftige Post von ${target} wird automatisch dorthin einsortiert. Außerdem wendet ohmail die Regel auf die Post an, die es schon für dich einsortiert hat. Nachrichten, die du beantwortet, in einem anderen Mailprogramm einsortiert oder geparkt hast, bleiben unberührt.`,
  screeningRetroToggle: "Auch die Post verschieben, die schon im Postfach liegt",
  stayedReplied: (count: number, place: string) =>
    count === 1 ? `1 bleibt in ${place}: Du hast darauf geantwortet.` : `${count} bleiben in ${place}: Du hast darauf geantwortet.`,
  stayedSetAside: (count: number, place: string) =>
    count === 1 ? `1 bleibt in ${place}: Du hast sie zurückgelegt.` : `${count} bleiben in ${place}: Du hast sie zurückgelegt.`,
  folderInMailbox: (folder: string, mailbox: string) => `${folder} (${mailbox})`,
  stayedFiledElsewhere: (count: number, place: string) =>
    count === 1
      ? `1 bleibt in ${place}: in einem anderen Mailprogramm einsortiert.`
      : `${count} bleiben in ${place}: in einem anderen Mailprogramm einsortiert.`,
  stayedFailedChecks: (count: number, place: string) =>
    count === 1
      ? `1 bleibt in ${place}: Die Anmeldeprüfung des Absenders ist fehlgeschlagen.`
      : `${count} bleiben in ${place}: Die Anmeldeprüfung des Absenders ist fehlgeschlagen.`,
  // Inflected where the web's one "Auch verschieben" is not: the phone's decks inflect for number.
  stayedMoveToo: (count: number) => (count === 1 ? "Die Nachricht auch verschieben" : "Die Nachrichten auch verschieben"),
  // Dative after "in" (the web's "den Screener" is the accusative of a move, not a place).
  placeScreener: "dem Screener",
  verdictMoved: (place: string, count: number) =>
    `${place} — ${count === 1 ? "1 Nachricht" : `${count} Nachrichten`} verschoben.`,
  pressPartlyRefused: (count: number) =>
    count === 1 ? "1 Nachricht hat sich nicht geändert." : `${count} Nachrichten haben sich nicht geändert.`,
  pressPartlyQueued: (count: number) =>
    count === 1 ? "1 Nachricht ist für den Organizer vorgemerkt." : `${count} Nachrichten sind für den Organizer vorgemerkt.`,
  /* ── THE SHEET'S RESOLVE STEP — the web sheet's words, one function per key ── */
  screeningRulesHead: "Ihre Regeln",
  screeningRuleAll: "Ihre ganze Post",
  screeningRuleSubject: (term: string) => `Betreff enthält »${term}«`,
  screeningRuleBody: (term: string) => `Text enthält »${term}«`,
  screeningRuleEveryone: (domain: string) => `Alle bei ${domain}`,
  screeningRuleOnlyThis: "Nur diese Adresse",
  screeningRuleLine: (condition: string, place: string) => `${condition} → ${place}`,
  screeningRuleUncounted: "hier nicht gezählt",
  screeningRuleInside: (senders: number) =>
    senders === 1 ? "1 Absender hier hat eine eigene Regel" : `${senders} Absender hier haben eigene Regeln`,
  screeningCount: (n: number) => (n === 1 ? "1 Nachricht" : `${n} Nachrichten`),
  screeningResolveTitle: (place: string, rules: number) =>
    `${place} — ${rules === 1 ? "eine deiner Regeln sagt etwas anderes" : `${rules} deiner Regeln sagen etwas anderes`}`,
  screeningResolveAllNote: (rules: number) => (rules === 1 ? "Entfernt diese Regel" : `Entfernt diese ${rules} Regeln`),
  screeningResolveKeepTitle: "Aufteilung behalten",
  screeningResolveKeepNote: (count: number, rules: number) =>
    `${count === 1 ? "1 Nachricht bleibt" : `${count} Nachrichten bleiben`}, wo ${rules === 1 ? "deine Regel sie einsortiert" : "deine Regeln sie einsortieren"}`,
  screeningResolveKeepNoteUncounted: "Was deine Regel erfasst, bleibt, wo sie es einsortiert.",
  screeningResolveDomainTitle: (place: string, domain: string, domainPlace: string) =>
    `${place} — deine Regel für alle bei ${domain} sortiert sie in ${domainPlace}`,
  screeningResolveExceptNote: (domain: string, domainPlace: string) => `Alle anderen bei ${domain} bleiben in ${domainPlace}`,
  screeningResolveWholeNote: (senders: number) => `Ändert diese Regel · ${senders === 1 ? "für 1 Absender" : `für alle ${senders} Absender`}`,
  screeningResolveInsideTitle: (place: string, senders: number) =>
    `${place} — ${senders === 1 ? "1 Absender hier hat eine eigene Regel" : `${senders} Absender hier haben eigene Regeln`}`,
  screeningResolveInsideKeepTitle: "Eigene Regeln behalten",
  screeningResolveInsideAllNote: (rules: number) => (rules === 1 ? "Ändert diese Regel mit" : `Ändert diese ${rules} Regeln mit`),
  screeningResolveGo: (place: string) => `Einsortieren: ${place}`,
  screeningResolveChoiceAria: "Was mit den Regeln passiert, die etwas anderes sagen",
  screeningResolveCancel: "Abbrechen",
  screeningRuleInsideCount: (senders: number, count: number) =>
    `${senders === 1 ? "1 Absender hier hat eine eigene Regel" : `${senders} Absender hier haben eigene Regeln`} · ${count}`,
  screeningNoteWithCount: (note: string, n: number) => `${note} · ${n === 1 ? "1 Nachricht" : `${n} Nachrichten`}`,
  screeningPressRuled: (place: string, sender: string) => `${place} — Post von ${sender} geht dorthin, künftige auch.`,
  screeningPressRemoved: (place: string, sender: string, rules: number, term: string) =>
    `${place} — Post von ${sender} geht dorthin, künftige auch. ${rules === 1 ? `Deine Regel »${term}« wird entfernt.` : `${rules} deiner Regeln werden entfernt.`}`,
  screeningPressKeptOne: (place: string, sender: string, term: string, keptPlace: string) =>
    `${place} — Post von ${sender} geht dorthin, außer »${term}«, das bleibt in ${keptPlace}.`,
  screeningPressKeptMany: (place: string, sender: string, rules: number) =>
    `${place} — Post von ${sender} geht dorthin, außer dem, was ${rules === 1 ? "deine Regel woanders hält" : `${rules} deiner Regeln woanders halten`}.`,
  screeningPressException: (place: string, sender: string, domain: string, domainPlace: string) =>
    `${place} — Post von ${sender} geht dorthin, künftige auch. Alle anderen bei ${domain} bleiben in ${domainPlace}.`,
  screeningRoutingUndoneRules: "Die Post ist wieder da, wo sie war, und deine Regeln sind unverändert.",
  screeningVerdictAll: (count: number, sender: string, place: string) =>
    count === 1 ? `Die 1 Nachricht von ${sender} liegt in ${place}.` : `Alle ${count} von ${sender} liegen in ${place}.`,
  screeningVerdictQueued: (name: string, sender: string, place: string) =>
    `Für ${name} vorgemerkt — beim nächsten Durchlauf: Post von ${sender} → ${place}, und die Regel wird angelegt.`,
  screeningVerdictQueuedUnnamed: (sender: string, place: string) =>
    `Für den Organizer vorgemerkt — beim nächsten Durchlauf: Post von ${sender} → ${place}, und die Regel wird angelegt.`,
  screeningVerdictChanged: (term: string) => `Deine Regel »${term}« wurde inzwischen geändert und bleibt deshalb, wie sie ist.`,

  connectionSignInRefused: "Der Mailserver hat die Anmeldung abgelehnt.",
  connectionCertificateRefused:
    "Dieses Telefon hat das Zertifikat des Mailservers nicht akzeptiert und deshalb abgebrochen, bevor das Passwort rausging.",
  signInAgain: "Erneut anmelden",
  signInAgainLead:
    "Hast du das Passwort dieses Postfachs bei deinem Anbieter geändert? Gib ohmail das neue. Die Post, die schon auf diesem Telefon ist, bleibt, wo sie ist.",
  signInAgainField: "Neues Passwort",
  signInAgainHint: "Wird auf diesem Telefon versiegelt und nur an den eigenen Server dieses Postfachs gesendet.",
  signInAgainSave: "Speichern und anmelden",
  signInAgainSaving: "Anmeldung läuft…",
  signInAgainCancel: "Abbrechen",
  signInAgainDone: "Angemeldet. Dieses Postfach synchronisiert wieder.",
  signInAgainFailed: (detail: string) =>
    `Dieses Passwort wurde nicht akzeptiert: ${detail}. Auf diesem Telefon hat sich nichts geändert.`,

  /* DIE SERVER DES POSTFACHS, AN ORT UND STELLE BEARBEITET. Mit dem Passwort geprüft, bevor etwas bleibt. */
  serverSettings: "Servereinstellungen",
  serverSettingsLead:
    "ohmail prüft diese Einstellungen mit deinem Passwort, bevor es sie behält. Bis sie funktionieren, ändert sich auf diesem Telefon nichts.",
  serverSettingsPassword: "Passwort",
  serverSettingsPasswordHint: "Wird zum Prüfen der neuen Einstellungen verwendet und nur an die eigenen Server dieses Postfachs gesendet.",
  serverSettingsSave: "Prüfen und speichern",
  serverSettingsSaving: "Wird geprüft…",
  serverSettingsCancel: "Abbrechen",
  serverSettingsSaved: "Gespeichert. Dieses Postfach verwendet jetzt diese Einstellungen.",
  serverSettingsNoPassword: "Gib das Passwort dieses Postfachs an, um die neuen Einstellungen zu prüfen.",
  serverSettingsUnreadable: "Dieses Telefon konnte die Servereinstellungen dieses Postfachs nicht lesen. Versuche es noch einmal.",
  serverSettingsImapUnreachable:
    "ohmail hat deinen Posteingangsserver (IMAP) unter dieser Adresse und diesem Port nicht erreicht. Prüfe beides — auf diesem Telefon hat sich nichts geändert.",
  serverSettingsHostWhileOrganizing:
    "Solange dieses Telefon dieses Postfach organisiert, bleibt sein Posteingangsserver, wie er ist. Beende das Organisieren hier, ändere den Server und organisiere dann wieder hier.",
  serverSettingsHostHeld: (name: string) =>
    `${name} organisiert dieses Postfach auf diesem Server. Auf diesem Telefon hat sich nichts geändert.`,
  serverSettingsHostHeldUnnamed:
    "Eine andere Installation organisiert dieses Postfach auf diesem Server. Auf diesem Telefon hat sich nichts geändert.",
  serverSettingsRefused: (detail: string) =>
    `Diese Einstellungen wurden nicht behalten: ${detail}. Auf diesem Telefon hat sich nichts geändert.`,

  selfCheckAction: "Dieses Postfach prüfen",
  selfCheckChecking: "Wird geprüft…",
  selfCheckInStep: "Stimmt mit deinem Mailserver überein.",
  selfCheckEmpty: "Noch nichts zu vergleichen: Von diesem Postfach wurde noch kein Ordner gelesen.",
  selfCheckUnreachedTimeout: "Das Postfach konnte nicht geprüft werden: Dein Mailserver hat nicht rechtzeitig geantwortet.",
  selfCheckUnreachedAuth: "Das Postfach konnte nicht geprüft werden: Dein Mailserver hat die Anmeldung abgelehnt.",
  selfCheckUnreachedConnect: "Das Postfach konnte nicht geprüft werden: Dein Mailserver war nicht erreichbar.",
  selfCheckUnreachedTls:
    "Das Postfach konnte nicht geprüft werden: Die sichere Verbindung zu deinem Mailserver ist fehlgeschlagen.",
  selfCheckUnreachedBusy:
    "Das Postfach konnte nicht geprüft werden: Es sind bereits so viele Verbindungen offen, wie ohmail nutzt. Versuch es gleich nochmal.",
  selfCheckUnreachedNoLogin: "Das Postfach konnte nicht geprüft werden: Für dieses Postfach ist keine Anmeldung gespeichert.",
  selfCheckUnreachedOther: "Das Postfach konnte nicht geprüft werden: Dein Mailserver konnte nicht gelesen werden.",
  selfCheckDiffers: (n: number, list: string) =>
    `${n} ${n === 1 ? "Ordner weicht" : "Ordner weichen"} von deinem Mailserver ab: ${list}.`,
  selfCheckDiffersAndUnread: (n: number, list: string, unread: number, unreadList: string) =>
    `${n} ${n === 1 ? "Ordner weicht" : "Ordner weichen"} von deinem Mailserver ab: ${list}; `
    + `${unread} ${unread === 1 ? "Ordner konnte" : "Ordner konnten"} nicht gelesen werden: ${unreadList}.`,
  selfCheckOnlyUnread: (unread: number, unreadList: string) =>
    `${unread} ${unread === 1 ? "Ordner konnte" : "Ordner konnten"} nicht von deinem Mailserver gelesen werden: ${unreadList}. Die übrigen stimmen überein.`,
  selfCheckServerMore: (folder: string, n: number) =>
    `${folder} (${n} ${n === 1 ? "Nachricht" : "Nachrichten"} mehr auf dem Server)`,
  selfCheckMirrorMore: (folder: string, n: number) =>
    `${folder} (${n} ${n === 1 ? "Nachricht" : "Nachrichten"} mehr hier)`,
  selfCheckRenumbered: (folder: string) => `${folder} (vom Server neu nummeriert)`,
  selfCheckAndMore: (list: string, n: number) => `${list} und ${n} weitere`,
  selfCheckFailed: "Die Prüfung konnte nicht laufen. Es wurde nichts verändert.",

  mailRowThreadAria: (n: number) =>
    `${n} ${n === 1 ? "Nachricht" : "Nachrichten"} in diesem Gespräch`,
  mailRowNewSinceAria: (n: number) =>
    `${n} ${n === 1 ? "Nachricht" : "Nachrichten"}, seit das wieder aufgetaucht ist`,

  /* Der Wall des verwalteten Kontos und seine Streifen — dieselben Sätze wie im Browser. */

  wallTitle: "Dieses Konto ist nicht aktiv.",
  wallSuspendedTitle: "Dieses Konto ist gesperrt.",
  wallTrialEnded: (date: string) => `Deine Testphase ist am ${date} abgelaufen.`,
  wallCanceled: (date: string) => `Dein Abo ist am ${date} ausgelaufen.`,
  wallUnpaid: (date: string) =>
    `Eine Zahlung ist fehlgeschlagen, und die Frist dafür ist am ${date} abgelaufen.`,
  wallStopped: "ohmail organisiert dieses Konto nicht mehr.",
  wallMailboxUntouched: "Dein Postfach ist unberührt.",
  wallKept:
    "Deine Post und deine Einstellungen bleiben. Es wurde nichts gelöscht, und deine Post liegt ohnehin auf deinem eigenen Server.",
  wallErasure: (date: string) =>
    `Die Regeln, Screener-Entscheidungen und Einstellungen, die ohmail für dich behält, werden am ${date} gelöscht. Deine Post liegt in deinem Postfach und gehört nicht dazu.`,
  wallErasureHeld:
    "Ein Betreiber hält dieses Konto; solange das gilt, wird nichts gelöscht. Schreib an support@ohmail.app, falls das unerwartet ist.",
  wallErasureUnknown:
    "Es wurde nichts gelöscht. Deine Post liegt in deinem Postfach, und sie zu löschen steht uns nicht zu.",
  wallSubscribe: "Abo abschliessen",
  wallOpenAccount: "Dein ohmail-Konto öffnen",
  wallManage: "Abo verwalten",
  wallSubscribeHint: "Öffnet deine Kontoseite: Tarif wählen, bezahlen, zurück hierher.",
  wallMintFailed: "Die Kontoseite konnte gerade nicht geöffnet werden. Versuch es gleich noch einmal.",
  wallMintUnverified:
    "Die Kontoseite braucht eine bestätigte Adresse. Öffne den Link in der Mail, die wir bei der Registrierung geschickt haben.",
  wallChecking: "Stand deines Kontos wird geprüft …",
  wallPending:
    "Die Zahlung ist noch nicht bestätigt. Sobald das passiert, geht es hier weiter — du musst nichts tun.",
  wallCheckAgain: "Erneut prüfen",
  wallMoveOut: "Auf Selbsthosting umziehen",
  wallMoveOutHint:
    "Gibt deine Regeln, Screener-Entscheidungen und Einstellungen als eine Datei weiter, die deine eigene Installation liest, wenn sie dieses Postfach übernimmt.",
  wallMoveOutGuide: "Zur Anleitung fürs Selbsthosten",
  wallMoveOutFailed: "Die Datei konnte gerade nicht erstellt werden. Versuch es gleich noch einmal.",
  wallMoveOutBusy: "Die Datei wird vorbereitet…",
  wallDeleteNow: "Konto jetzt löschen",
  wallDeleteElsewhere:
    "Zum Löschen deines Kontos brauchst du deinen zweiten Faktor — das passiert auf deiner Kontoseite im Browser. Dein Postfach bleibt unberührt.",
  wallOpenInBrowser:
    "Öffne ohmail.app im Browser, um dieses Konto zu verwalten oder zu löschen.",

  stripGraceEnds: (date: string) =>
    `Deine Testphase ist abgelaufen. ohmail organisiert noch bis zum ${date}.`,
  stripPaymentFailed: (date: string) =>
    `Deine letzte Zahlung ist fehlgeschlagen. Bring sie bis zum ${date} in Ordnung, damit ohmail weiter organisiert.`,
  stripTrialEnds: (date: string) => `Deine Testphase endet am ${date}.`,
  stripSubscribe: "Abo abschliessen",
  stripFixPayment: "Zahlung in Ordnung bringen",
  stripLater: "Später",
  stripCaughtUp: (date: string) => `ohmail holt die Nachrichten nach, die seit dem ${date} angekommen sind.`,
  stripDismiss: "Verstanden",

  renderErrorTitle: "Auf diesem Bildschirm ist etwas schiefgegangen.",
  renderErrorWhere: (surface: string) => `${surface} konnte nicht gezeichnet werden.`,
  renderErrorRetry: "Erneut versuchen",
  renderErrorSurfaceShell: "Die ganze App",
  renderErrorSurfaceReader: "Die Nachricht",
  renderErrorSurfaceComposer: "Das Schreibfenster",
  renderErrorSurfaceScreen: "Dieser Bildschirm",

  pfiTitle: "Wir haben deine ohmail-Einstellungen in diesem Postfach gefunden",
  pfiLede: (address: string) =>
    `${address} trägt Einstellungen, die ein früheres ohmail dort gespeichert hat. Sie reisen mit dem Postfach — in dieses importieren?`,
  pfiHolds: (details: string) => `Sie enthalten ${details}.`,
  pfiScreenerPart: (n: number) => (n === 1 ? "1 Screener-Entscheidung" : `${n} Screener-Entscheidungen`),
  pfiRulesPart: (n: number) => (n === 1 ? "1 Regel" : `${n} Regeln`),
  pfiNotifyPart: (n: number) => (n === 1 ? "1 Benachrichtigungswahl" : `${n} Benachrichtigungswahlen`),
  pfiTagsPart: (n: number) => (n === 1 ? "1 Tag" : `${n} Tags`),
  pfiAwayPart: "deine Abwesenheitsantwort",
  pfiListPair: (first: string, second: string) => `${first} und ${second}`,
  pfiListMany: (head: string, last: string) => `${head} und ${last}`,
  pfiSavedByLocal: (when: string) => `Gespeichert ${when} von ohmail auf einem anderen Computer.`,
  pfiSavedByCloud: (when: string) => `Gespeichert ${when} von ohmail Cloud.`,
  pfiSavedByPhone: (when: string) => `Gespeichert ${when} von ohmail auf einem Telefon.`,
  pfiSavedBy: (when: string) => `Gespeichert ${when}.`,
  pfiWillDo:
    "Der Import fügt sie den Einstellungen dieses Kontos hinzu. Post, die dieses ohmail im Screener zurückgehalten hat, wird für Absender, die sie aussortieren, dort abgelegt, wo sie es sagen, und als gelesen markiert; sonst ändert sich an deiner Mail nichts. Bis du dich entscheidest, bleiben beide im Postfach: diese Einstellungen neben denen, die du hier festlegst.",
  pfiHeldRouting:
    "Bis du antwortest, bleibt Mail von Absendern, die diese Einstellungen durchlassen, dort, wo sie angekommen ist; andere neue Absender werden wie gewohnt gescreent.",
  pfiImport: "Einstellungen importieren",
  pfiImporting: "Importiere …",
  pfiImportingSlow:
    "Dieses Postfach antwortet langsam, deshalb schließt ohmail den Import im Hintergrund ab. Das Ergebnis erscheint hier.",
  pfiImportingUnreachable:
    "ohmail hat dieses Postfach gerade nicht erreicht. Es versucht es im Hintergrund weiter und zeigt das Ergebnis hier.",
  pfiLater: "Nicht jetzt",
  pfiDoneTitle: "Deine Einstellungen sind zurück.",
  pfiDoneDetails: (details: string) => `Importiert: ${details}.`,
  pfiDoneSkipped: (n: number) =>
    (n === 1 ? "1 Regel konnte nicht importiert werden." : `${n} Regeln konnten nicht importiert werden.`),
  pfiDoneAction: "Fertig",
  pfiErrorTitle: "Das hat nicht geklappt.",
  pfiErrorGeneric: "Etwas ist schiefgelaufen.",
  pfiErrorRetry: "Versuch es noch mal.",
  pfiNewerTitle: "Einstellungen aus einem neueren ohmail",
  pfiNewerBody: (address: string) =>
    `${address} trägt Einstellungen aus einer neueren ohmail-Version, die dieses ohmail nicht lesen kann — aktualisiere ohmail, um sie zu importieren.`,
  pfiSavedTitle: (address: string) => `In ${address} gespeicherte Einstellungen`,
  pfiSavedBody:
    "Du hast sie nicht importiert. Sie bleiben im Postfach neben den Einstellungen, die du hier festlegst, bis du dich entscheidest.",
  pfiReplace: "Einstellungen dieses ohmail im Postfach speichern",
  pfiReplacing: "Speichere …",
  pfiReplaceNote: (details: string) =>
    `Das Speichern ersetzt ${details} im Postfach innerhalb weniger Minuten durch die Einstellungen dieses ohmail. Solange dieses ohmail keine eigenen hat, behält das Postfach sie.`,
  pfiReplaceNoteBare:
    "Das Speichern ersetzt die Einstellungen im Postfach innerhalb weniger Minuten durch die dieses ohmail. Solange dieses ohmail keine eigenen hat, behält das Postfach sie.",
  pfiReplacedTitle: "Die Einstellungen dieses ohmail gehen innerhalb weniger Minuten ins Postfach.",
  toastMoveQueuedWithRule: (place: string, holder: string) =>
    `Für ${holder} vorgemerkt: Die Nachricht und die Regel für den Absender gehen beim nächsten Durchgang nach ${place}.`,
  toastMoveQueuedWithRuleUnknown: (place: string) =>
    `Für den Organizer vorgemerkt: Die Nachricht und die Regel für den Absender gehen beim nächsten Durchgang nach ${place}.`,
  toastQueuedRuleUndone: (holder: string) => `Keine Regel angelegt. Die Nachricht wartet weiter auf ${holder}.`,
  toastQueuedRuleUndoneUnknown: "Keine Regel angelegt. Die Nachricht wartet weiter auf den Organizer.",
  waitingStrip: (count: number, holder: string) =>
    `${count === 1 ? "1 Änderung wartet" : `${count} Änderungen warten`} auf ${holder}.`,
  waitingStripUnknown: (count: number) =>
    `${count === 1 ? "1 Änderung wartet" : `${count} Änderungen warten`} auf den Organizer.`,
  waitingStripOpen: "Anzeigen, was wartet",
  waitingSheetTitle: "Wartet auf den Organizer",
  waitingMove: (place: string) => `Eine Nachricht nach ${place}`,
  waitingMoveSomewhere: "Eine verschobene Nachricht",
  waitingRuleRemove: (match: string) => `Die Regel für ${match} aufheben`,
  waitingRuleChange: (match: string, place: string) => `Die Regel für ${match}: sortiert in ${place}`,
  waitingRuleChangeSomewhere: (match: string) => `Eine Änderung der Regel für ${match}`,
  waitingDecision: (match: string) => `Deine Screener-Entscheidung zu ${match}`,
  waitingSettings: "Eine Änderung der Einstellungen",
  waitingOther: "Eine Änderung",
  waitingTheOrganizer: "Der Organizer",
  waitingRefused: (holder: string) => `${holder} hat das nicht ausgeführt.`,
};
