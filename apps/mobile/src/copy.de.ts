/**
 * Der Kopie-Satz des Handys auf Deutsch — the phone's copy deck, in German. `Deck` is derived
 * from the English table in `copy.en.ts`, so shape is compiler-checked: a missing key, an extra
 * key or a differing parameter list is a build error; `test/copy-parity.test.ts` adds what a
 * type cannot see. The vocabulary is not invented here: `apps/webapp/messages/de.json` settled
 * it — Ohbox, News, Screener, Spam, Tag, paper and ohmarchy stay; Receipts is Belege, screened
 * out is aussortiert, Park is Parken/Geparkt, Trash is the Papierkorb. Where the phone shares a
 * whole sentence with the web client, this deck carries its German byte for byte. Register: Du,
 * never Sie; plain statements, no slogans. Plurals are a ternary on the number.
 */

import type { BackupExclusion } from "./engine/backup-exclusion";
import type { UnsubSaid, UnsubToast } from "./state/unsub-arms";
import { isPinFailure } from "./net/host-pinning";
import type { Deck } from "./copy.en";

const BOOT_MIGRATING = "Der Mail-Speicher auf diesem Handy wird aktualisiert…";

/** Hoisted for the same reason its English twin is — see `copy.en.ts`. */
const PIN_CHANGED =
  "Die Identität dieses Computers hat sich geändert, seit du dich mit ihm gekoppelt hast, deshalb "
  + "hat ohmail angehalten, statt ihm zu vertrauen. Wenn du ohmail auf diesem Computer neu "
  + "installiert oder aus einem Backup wiederhergestellt hast, öffne dort Einstellungen → Geräte "
  + "und koppele dieses Handy mit einem frischen Code erneut. Wenn nicht, antwortet etwas in "
  + "deinem Netz an seiner Stelle.";

export const DE: Deck = {
  /* --------------------------------------------------------------- welcome */

  welcomeTitle: "Welches Postfach ist das?",
  welcomeLead:
    "Was deine Mails organisiert, muss laufen: ein Computer, ein Server oder dieses Handy, solange ohmail offen ist. Deine Mails bleiben auf deinem Mailserver.",

  /* ------------------------------------------------------------------ doors */

  doorsLead: "Eine Frage, vier Antworten — welcher Rechner organisiert?",
  doorsHead: "Was deine Mails organisiert",

  doorCloud: "ohmail Cloud",
  doorCloudSay:
    "Unser gehosteter Dienst organisiert; dieses Handy hält eine Kopie. Melde dich im Web an und verbinde dort dein Postfach, dann öffne Einstellungen → Geräte und scanne den Code, den es zeigt.",

  doorOwnServer: "Dein eigener Server",
  doorOwnServerSay:
    "Ein Server, den du betreibst, organisiert; dieses Handy hält eine Kopie. Gib seine Adresse an, und diese App prüft, was dort ist.",

  doorDesktop: "Dein eigener Computer",
  doorDesktopSay:
    "Die ohmail-App auf deinem Computer organisiert; dieses Handy hält eine Kopie. Öffne dort Einstellungen → Geräte und scanne den Code.",
  doorDesktopNoPin:
    "Nimm auf diesem Handy die Tailscale-Adresse, die dieselbe Ansicht zeigt — ohmail kann einen Computer, der über dein eigenes Netz erreicht wird, hier noch nicht prüfen.",

  /* Die vierte Tür — see the English deck's note. The third line is the one platform fork on
     any of these screens; both sentences live in both decks. */
  doorPhone: "Eigenständig auf diesem Handy",
  doorPhoneSay: "Dein Postfach, auf diesem Handy organisiert.",
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
    "Dein Server braucht ein https-Zertifikat von einer Stelle, der dieses Handy schon vertraut. "
    + "Ein Server auf einem öffentlichen Namen bekommt eines automatisch. Ein Server auf einem "
    + "privaten Namen wie ohmail.test stellt sich sein eigenes aus, und ob dieses Handy das "
    + "akzeptiert, hängt vom Handy ab: Auf Android nicht — ohmail vertraut nur den Stellen, die "
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
  phoneStandaloneTitle: "Auf diesem Handy organisieren",
  phoneStandaloneL1Ios:
    "Es organisiert, solange ohmail geöffnet ist. Wenn du die App verlässt, gibt es das Postfach zurück.",
  phoneStandaloneL1Android:
    "Es organisiert, solange seine Benachrichtigung angezeigt wird. Wische sie weg, um zu stoppen.",
  phoneStandaloneL2: "Ein Postfach auf diesem Handy.",
  phoneStandaloneL3:
    "Dein Mailserver behält alles. Nichts hier ist eine Kopie, die du verlieren könntest.",
  phoneStandaloneL4:
    "Mails der letzten 60 Tage von Absendern, über die du nicht entschieden hast, kommen in den Screener. Ältere Mails und Mails, die du abgelegt hast, bleiben, wo sie sind.",
  phoneStandaloneGo: "Weiter",
  phoneStandaloneBack: "Anders wählen",

  /* Jedes Feldlabel ist das des Web-Katalogs, Byte für Byte. */
  phoneStandaloneFormTitle: "Dein eigenes Postfach",
  phoneStandaloneFormLead:
    "Dieses Handy verbindet sich direkt mit deinem Mailserver. Dein Passwort liegt auf diesem Handy, verschlüsselt mit einem Schlüssel aus seinem Schlüsselspeicher, und geht nie an uns.",
  phoneStandaloneAddress: "Postfachadresse",
  phoneStandalonePassword: "Postfachpasswort",
  phoneStandaloneShowPassword: "Passwort zeigen",
  phoneStandaloneHidePassword: "Passwort verbergen",
  phoneStandaloneAdvanced: "Servereinstellungen",
  phoneStandaloneImapHost: "Eingangsserver (IMAP)",
  phoneStandaloneImapPort: "IMAP-Port",
  phoneStandaloneImapTls: "Implizites TLS",
  phoneStandaloneImapTlsHint:
    "Ein bedeutet Port 993. Aus bedeutet Port 143, der per STARTTLS verschlüsselt wird. Wenn du den Port änderst, wandert dieser Schalter mit.",
  phoneStandaloneSmtpHost: "Ausgangsserver (SMTP)",
  phoneStandaloneSmtpPort: "SMTP-Port",
  phoneStandaloneConnect: "Verbinden",
  phoneStandaloneConnecting: "Postfach wird geöffnet…",
  phoneStandaloneUseHost: (host: string) => `${host} nehmen`,
  probeTlsHostname: (certHost: string, expectedHost: string, protocol: string) =>
    `Das Zertifikat dieses Servers gilt für ${certHost}, nicht für ${expectedHost}, wir haben also abgebrochen, bevor das Passwort rausging. Frag deinen Anbieter nach dem richtigen ${protocol}-Server.`,
  probeTlsHostnameSuggest: (certHost: string, expectedHost: string, suggestedHost: string, protocol: string) =>
    `Das Zertifikat dieses Servers gilt für ${certHost}, nicht für ${expectedHost}, wir haben also abgebrochen, bevor das Passwort rausging. Er antwortet auf ${suggestedHost} — nimm das als ${protocol}-Server.`,

  /* Die fünf Zustandslabels sind die des Desktops, Byte für Byte. */
  phoneThisPhone: "Dieses Handy",
  phoneStateOrganizing: "Organisiert",
  phoneStateStopping: "Wird beendet",
  phoneStateStopPending: "Stopp ausstehend",
  phoneStateStopPendingWhy: "Ein Stopp steht bereits aus; es wartet auf das Postfach.",
  phoneStateSettingsUnsynced: "Organisiert, aber die Einstellungen dieses Postfachs lassen sich auf dem Mailserver nicht speichern oder lesen. ohmail versucht es weiter.",
  phoneStateSettingsUnsyncedCode: (code: string) =>
    `Organisiert, aber die Einstellungen dieses Postfachs lassen sich auf dem Mailserver nicht speichern oder lesen (${code}). ohmail versucht es weiter.`,
  phoneStateStopSiblingLapse: "Eine andere Kopie dieses Handys hält den Anspruch auf das Postfach noch; der Stopp endet, wenn dieser Anspruch verfällt.",
  /* Ohne Desktop-Zwilling: nur auf dem Handy kann ein Start hinter einem Stopp warten. */
  phoneStateStarting: "Wird gestartet",
  phoneStateNotOrganized: "Dieses Postfach wird von nichts organisiert",
  phoneFreeOffer: "Dieses Postfach wird gerade von nichts organisiert. Von diesem Handy aus organisieren, solange ohmail darauf läuft?",
  /* Der Übergangszustand: zurückgegeben und noch nicht wieder übernommen. */
  phoneStateHandedBack: "Zurückgegeben",
  phoneStateHandedBackWhy: "Ein anderer Computer kann dieses Postfach jetzt übernehmen.",
  phoneStateParked: "Pausiert, während der Account geschlossen war. Das Organisieren läuft von selbst wieder an",
  phoneStateReader: (name: string) => `Organisiert von ${name}`,
  phoneStateReaderLegacy: "Organisiert von einer anderen Installation",
  /* Der normale gekoppelte Zustand. Es wird keine Maschine genannt, weil keine auf der Leitung
     steht — der antwortende Server organisiert selbst —, und der Server heißt hier nicht
     "ohmail Cloud": dieses Handy kann ebenso mit einem selbst gehosteten Server gekoppelt sein. */
  phoneStatePairedServer: "Organisiert vom gekoppelten Server",
  phoneStatePairedServerWhy:
    "Er organisiert dieses Postfach, ob ohmail auf diesem Handy offen ist oder nicht. Dieses "
    + "Handy liest es; es verschiebt nichts und sortiert nichts aus.",
  /* Der zweite Satz ist `mailboxes.readerReadsOnly` aus dem Web-Katalog, mit "dieses Handy"
     statt "dieser Computer"; die Handy-Variante folgt `blocked_organized_elsewhere_mobile`. */
  phoneStateReaderWhy: (name: string) =>
    `${name} organisiert dieses Postfach. Dieses Handy liest es; es verschiebt nichts und sortiert nichts aus.`,
  phoneStateReaderWhyPhone: (name: string) =>
    `${name} organisiert dieses Postfach, und ein Handy organisiert nur, solange ohmail darauf offen ist. Dieses Handy liest es; es verschiebt nichts und sortiert nichts aus.`,
  phoneStateReaderWhyUnnamed:
    "Eine andere Installation organisiert dieses Postfach. Dieses Handy liest es; es verschiebt nichts und sortiert nichts aus.",
  phoneStateReaderWhyUnnamedPhone:
    "Ein anderes Handy organisiert dieses Postfach, und ein Handy organisiert nur, solange ohmail darauf offen ist. Dieses Handy liest es; es verschiebt nichts und sortiert nichts aus.",
  settingsStopHere: "Hier nicht mehr organisieren",
  settingsStopHereWhat:
    "Dieses Handy sortiert dieses Postfach nicht mehr ein und liest es weiter. Deine Ordner und alles darin bleiben, wo sie sind. Danach kann jede Installation es übernehmen, auch diese.",
  settingsStopHereConfirm: "Postfach zurückgeben",
  settingsStopHereCancel: "Weiter organisieren",
  settingsStartHere: "Hier organisieren",
  settingsStartHereFailed:
    "Dieses Handy konnte dieses Postfach nicht zu organisieren beginnen. Nichts hat sich geändert. Versuche es in einem Moment noch einmal.",
  settingsStopHereFailed:
    "Dieses Handy konnte dieses Postfach nicht zurückgeben und organisiert es weiter. Versuche "
    + "es in einem Moment noch einmal.",
  settingsStopLeftOther:
    "Die Einstellungen dieses Handys sind auf diesem Handy geblieben: Das Postfach enthält Einstellungen aus einem neueren ohmail, die dieses nicht lesen kann.",
  settingsStopLeftUnsaved:
    "Die Einstellungen dieses Handys konnten nicht im Postfach gespeichert werden und sind nur auf diesem Handy.",
  /* Ein Blick, der nicht angekommen ist — eigener Satz, nicht der darüber: hier ist auf diesem
     Handy nichts schiefgegangen, das Postfach konnte nur nicht gefragt werden. */
  settingsStartHereUnreadable:
    "Dieses Handy konnte nicht lesen, ob ein anderer Computer dieses Postfach organisiert. Nichts hat sich geändert. Versuche es noch einmal.",
  settingsStartHeldConsented: (name: string) =>
    `${name} organisiert dieses Postfach. Dieses Handy liest es, und deine Zustimmung bleibt gespeichert: Sobald ${name} es freigibt, bietet dieses Handy das Postfach an, und ein Tippen übernimmt es.`,
  settingsStartHeldReturns: (name: string) =>
    `${name} organisiert dieses Postfach. Dieses Handy liest es und übernimmt es von selbst wieder, sobald ${name} es freigibt, solange ohmail darauf offen ist.`,
  settingsStartHeldReturnsUnknown:
    "Eine andere Installation organisiert dieses Postfach. Dieses Handy liest es und übernimmt es von selbst wieder, sobald sie es freigibt, solange ohmail darauf offen ist.",
  settingsStartHeldConsentedUnknown:
    "Eine andere Installation organisiert dieses Postfach. Dieses Handy liest es, und deine Zustimmung bleibt gespeichert: Sobald sie es freigibt, bietet dieses Handy das Postfach an, und ein Tippen übernimmt es.",
  /* Die Sätze der Desktop-Zeile, Wort für Wort (`sync.blocked_meta_*`). */
  phoneStateMetaFolderFull:
    "Wird nicht synchronisiert — der Ordner ohmail/_meta auf diesem Server enthält mehr Nachrichten, als ohmail lesen kann. Verschiebe dort abgelegte Mails in einen anderen Ordner und lass die Nachrichten von ohmail stehen (ihr Betreff beginnt mit „ohmail“). ohmail macht dann von selbst weiter.",
  phoneStateMetaUndeletable:
    "Wird nicht synchronisiert — der Mailserver lässt ohmail seine eigenen Nachrichten in ohmail/_meta nicht entfernen. Gib diesem Ordner die Berechtigung zum Löschen oder frag deinen Anbieter. ohmail macht dann von selbst weiter.",
  phoneStateClockOff:
    "Wird nicht synchronisiert — die Uhr dieses Handys weicht zu stark von der des Mailservers ab, als dass ohmail dieses Postfach sicher organisieren könnte. Stell die Uhr richtig; ohmail macht dann von selbst weiter.",

  /* Die Absagen der eigenständigen Tür. Keine davon trägt je das Passwort. */
  standaloneNoEngine:
    "Dieser Build kann auf diesem Handy kein Postfach organisieren. Verbinde es stattdessen mit einem Computer, einem Server oder ohmail Cloud.",
  standaloneNoHost: "ohmail braucht deinen Eingangsserver (IMAP). Gib seine Adresse an.",
  standaloneNoSmtpHost: "ohmail braucht deinen Ausgangsserver (SMTP). Gib seine Adresse an.",
  standaloneNoPort: "Der IMAP-Port ist eine ganze Zahl von 1 bis 65535.",
  standaloneNoSmtpPort: "Der SMTP-Port ist eine ganze Zahl von 1 bis 65535.",
  standaloneSignInRefused:
    "Dein Mailserver hat diese Adresse und dieses Passwort nicht akzeptiert. Prüfe beides und versuche es erneut — es wurde nichts gespeichert.",
  /* Die Absage eines Anbieters, der sagt warum; Namen aus der Anbietertabelle. Wort für Wort `mailboxes.probe_auth_<id>_*`. */
  standaloneAuthAppOnly: (provider: string, account: string) =>
    `${account} hat dein ${account}-Passwort abgelehnt: ${provider} meldet sich nur mit einem App-Passwort an. `
    + "Schalte die Bestätigung in zwei Schritten ein, erstell dann ein App-Passwort mit einem beliebigen Namen und "
    + "füg hier seine 16 Buchstaben ein, mit oder ohne Leerzeichen. "
    + "Manche Arbeits-, Schul- und Advanced-Protection-Konten sowie Konten, die sich nur mit "
    + "Sicherheitsschlüsseln anmelden, können keine App-Passwörter erstellen; die kann ohmail noch nicht verbinden. "
    + "Bitte deine Administratorin oder deinen Administrator, App-Passwörter zu erlauben, oder verbinde eine andere "
    + "Adresse.",
  standaloneAuthInvalid: (provider: string, account: string) =>
    `${account} hat dieses Passwort nicht akzeptiert. ${provider} braucht ein App-Passwort, nicht dein `
    + `${account}-Passwort: Erstell eines und füg hier seine 16 Buchstaben ein. Wenn du dein ${account}-Passwort `
    + "änderst, enden alle App-Passwörter, danach brauchst du also ein neues. Bei manchen Arbeits- und "
    + "Schuladressen, mit Advanced Protection und bei einer Anmeldung nur mit Sicherheitsschlüsseln lassen sich "
    + "keine App-Passwörter erstellen; die kann ohmail "
    + "noch nicht verbinden. Bitte deine Administratorin oder deinen Administrator, App-Passwörter zu "
    + "erlauben, oder verbinde eine andere Adresse.",
  standaloneAuthWebLogin: (provider: string, account: string) =>
    `${account} möchte diese Anmeldung zuerst in einem Webbrowser bestätigt haben. Melde dich einmal im Browser bei `
    + `${provider} an und versuch es dann hier erneut. Das Passwort kann richtig sein.`,
  standaloneAuthImapDisabled: (_provider: string, account: string) =>
    `${account} meldet, dass IMAP für dieses Konto ausgeschaltet ist. Eine Administratorin oder ein Administrator `
    + `schaltet es in der ${account} Admin-Konsole ein; versuch es danach erneut. Das Passwort kann richtig sein.`,
  standaloneProviderNote: (provider: string, account: string) =>
    `${provider} meldet sich nur mit einem App-Passwort an, nicht mit deinem ${account}-Passwort. Schalte zuerst die `
    + "Bestätigung in zwei Schritten ein, sonst sagt die Seite App-Passwörter, dass sie nicht verfügbar sind. Gib dem "
    + "App-Passwort einen beliebigen Namen und füg hier seine 16 Buchstaben ein, mit oder ohne Leerzeichen. "
    + "Manche Arbeits-, Schul- und Advanced-Protection-Konten sowie Konten, die sich nur mit "
    + "Sicherheitsschlüsseln anmelden, können keine App-Passwörter erstellen; die kann ohmail noch nicht verbinden. "
    + "Bitte deine Administratorin oder deinen Administrator, App-Passwörter zu erlauben, oder verbinde eine andere "
    + "Adresse.",
  standaloneProviderHelpLink: (account: string) => `${account} App-Passwörter`,
  standalonePrereqLink: "Bestätigung in zwei Schritten einschalten",
  standaloneNoEncryption:
    "Dein Mailserver bietet auf diesem Port keine verschlüsselte Verbindung, und ohmail sendet dein Passwort nicht im Klartext. Versuche Port 993 in den Servereinstellungen.",
  /* Ein abgelehntes Zertifikat in den Worten der Web-App (`mailboxes.probe_tls*`), nach dem Grund. */
  standaloneCertificateRefused:
    "Das Zertifikat dieses Mailservers wurde abgelehnt, wir haben also abgebrochen, bevor das Passwort rausging. Prüf den IMAP-Server und ob dieser Port TLS erwartet.",
  standaloneCertificateUntrusted:
    "Das Zertifikat dieses Servers stammt nicht von einer vertrauenswürdigen Stelle, wir haben also abgebrochen, bevor das Passwort rausging. Bitte den Betreiber, ein Zertifikat einer öffentlichen Zertifizierungsstelle einzurichten.",
  standaloneCertificateName:
    "Das Zertifikat dieses Mailservers passt nicht zum eingegebenen Server, wir haben also abgebrochen, bevor das Passwort rausging. Frag deinen Anbieter nach dem richtigen IMAP-Server.",
  standaloneCertificateExpired:
    "Das Zertifikat dieses Servers ist abgelaufen, wir haben also abgebrochen, bevor das Passwort rausging. Bitte den Betreiber des Servers, es zu erneuern.",
  standaloneCertificateNotYetValid:
    "Das Zertifikat dieses Servers gilt noch nicht, wir haben also abgebrochen, bevor das Passwort rausging. Frag den Betreiber des Servers.",
  /* Der Eingangsserver, bei dem Verbinden sich nicht anmelden konnte. */
  standaloneImapUnreachable:
    "ohmail hat deinen Eingangsserver (IMAP) unter dieser Adresse und diesem Port nicht erreicht. Prüf beides und versuch es erneut. Es wurde nichts gespeichert.",
  /* Auch der Ausgangsserver wird beim Verbinden gewählt, und jede seiner drei Antworten nennt ihn. */
  standaloneSmtpSignInRefused:
    "Dein Ausgangsserver (SMTP) hat diese Adresse und dieses Passwort nicht akzeptiert. Prüf ihn und versuch es erneut. Es wurde nichts gespeichert.",
  standaloneSmtpNoEncryption:
    "Dein Ausgangsserver (SMTP) bietet auf diesem Port keine verschlüsselte Verbindung, und ohmail sendet dein Passwort nicht im Klartext. Versuche Port 465 oder 587.",
  standaloneSmtpUnreachable:
    "ohmail hat deinen Ausgangsserver (SMTP) unter dieser Adresse und diesem Port nicht erreicht. Prüf beides und versuch es erneut. Es wurde nichts gespeichert.",
  standaloneRefused: (detail: string) =>
    `Das Öffnen des Postfachs wurde abgebrochen: ${detail}`,
  /* Die drei des Neustarts. Jede benennt ein anderes Fehlen. */
  standaloneNoSealedCredential:
    "Auf diesem Handy ist nichts gespeichert, womit sich dieses Postfach öffnen ließe. Nimm die Tür noch einmal und gib das Passwort des Postfachs an.",
  standaloneOtherMailbox:
    "Das Postfach auf diesem Handy ist nicht das, welches dieser Eintrag nennt. Entferne den Eintrag und öffne das Postfach erneut.",
  standaloneNotStored: (detail: string) =>
    `Dieses Handy konnte das gerade geöffnete Postfach nicht speichern: ${detail}. Es wurde `
    + "wieder geschlossen und nichts behalten — versuch Verbinden noch einmal.",
  standaloneAlreadyOpen:
    "Dieses Handy hat schon ein Postfach geöffnet. Entferne es unter Server, bevor du ein "
    + "anderes öffnest.",
  /* Die zwei des Entfernungsgurts. Keine nennt das entfernte Postfach — der Vermerk trägt nur eine Kennung. */
  standaloneMailboxRemoved:
    "Dieses Postfach wurde von diesem Handy entfernt, und der Rest davon wurde soeben gelöscht. Öffne wieder ein Postfach, um zu beginnen.",
  standaloneRemovalUnfinished: (detail: string) =>
    `Ein von dir entferntes Postfach ist noch teilweise auf diesem Handy (${detail}), deshalb `
    + "öffnet ohmail kein anderes darüber. Starte ohmail neu, um die Löschung abzuschließen.",
  /* Der Einwilligungs-Aufruf. Keine dieser Zeilen behauptet, das Handy organisiere gerade. */
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
    `Das Organisieren hat nicht begonnen: ${detail}. Dieses Handy hat das Postfach zurückgegeben, `
    + "ein anderer Computer kann es also übernehmen, und es versucht es beim nächsten Öffnen von "
    + "ohmail erneut.",

  /* --------------------------------------------------- servers & pairing */

  serversTitle: "Server",
  serversRow: "Mit einem Server verbinden",
  serversNote:
    "Koppele dieses Handy mit dem Computer oder Server, auf dem deine Mails liegen. Gekoppelt wird über einen QR-Code oder einen kurzlebigen Token, und dafür wird kein Passwort eingetippt.",
  serversActive: "Verbunden",
  serversProfiles: "Gekoppelte Server",
  /* Die eigene Zeile des Handys in der Liste. Sie benennt, was der Eintrag IST, und verspricht
     nichts über den Augenblick — siehe die englische Fassung. */
  serversOrganizedHere: "Das Postfach, das dieses Handy selbst geöffnet hat.",
  serversStopHere: "Beenden und entfernen",
  serversStopHereDrafts: (n: number) => n === 1
    ? "Beim Entfernen wird der nicht gesendete Entwurf auf diesem Handy gelöscht. Kein Mailserver hat ihn."
    : `Beim Entfernen werden die ${n} nicht gesendeten Entwürfe auf diesem Handy gelöscht. Kein Mailserver hat sie.`,
  serversStopHereDraftsUnknown:
    "Beim Entfernen werden alle nicht gesendeten Entwürfe auf diesem Handy gelöscht. Kein Mailserver hat sie.",
  serversStopHereKeep: "Postfach behalten",
  serversStopHereDelete: "Entfernen und Entwürfe löschen",
  serversForget: "Vergessen",
  serversForgetNote:
    "Vergessen löscht die Kopplung und die Mails, die dieses Handy kopiert hatte. Über die Geräteliste des Servers lässt sie sich auch dort widerrufen. Wer ein Postfach auf dem Server selbst entfernt, kann dort auch die Kopie seiner Mails bei ohmail löschen.",
  /* Dieselbe Notiz, wo es keinen Server gibt — siehe die englische Fassung. */
  serversForgetNoteHere:
    "Entfernen gibt das Postfach zurück, ohmail sortiert es hier nicht weiter ein, und die Mails, die dieses Handy kopiert hatte, werden gelöscht. Das Postfach auf deinem Mailserver bleibt unberührt.",
  serversForgetFailed: (reason: string) => reason,
  serversEmpty: "Noch keine Kopplungen.",
  serversInstallUnknown: (detail: string) =>
    "ohmail konnte nicht prüfen, ob dies dieselbe Installation ist, die deine Anmeldungen "
    + `gespeichert hat (${detail}), und hat sie deshalb nicht geöffnet — entfernt hat es sie aber `
    + "auch nicht. Starte die App neu, um es erneut zu versuchen.",
  serversPurgeRefused: (detail: string) =>
    "Dieses Handy hält noch Anmeldungen aus einer früheren Installation von ohmail, und es "
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
  pairConfirmTitle: "Dieses Handy koppeln?",
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
    "Diese Adresse hat ein Zertifikat, das dein Handy selbst prüft; es gibt also keinen "
    + "Schlüssel zum Vergleichen.",
  pairConfirmGo: "Koppeln",
  pairConfirmCancel: "Nicht koppeln",

  staleAsOf: (time: string) => `Stand ${time} · wird nachgeholt`,
  staleAsOfIdle: (time: string) => `Stand ${time}`,

  connectionLost: "Verbindung verloren. Verbinde neu …",
  connectionNeedsPassword: "Dieses Postfach braucht sein Passwort erneut. Gib es ein, damit wieder synchronisiert wird.",
  connectionGoneSince: (time: string) => `Seit ${time} keine Verbindung`,
  connectionMailHeld: "Neue Mails ließen sich auf diesem Handy nicht speichern. Deine Mails liegen weiter auf deinem Server.",

  networkOffline: "Dieses Handy hat kein Netz. ohmail holt nach, sobald es wieder da ist.",
  networkOfflineHeld: "Dieses Handy hat kein Netz. Angezeigt werden die neueren Mails, die es hat.",

  firstSyncNothingReadable: "Aus diesem Postfach konnte noch nichts gelesen werden.",
  connectionSetAside: (n: number) => n === 1
    ? "Eine Nachricht konnte nicht gelesen werden und wurde zurückgelegt."
    : `${n} Nachrichten konnten nicht gelesen werden und wurden zurückgelegt.`,

  firstSyncContinuesAt: (folder: string) => `Erste Synchronisierung läuft bei ${folder} weiter`,

  pairingBusy: "Wird gekoppelt…",
  pairedOk: "Gekoppelt. Deine Mails werden synchronisiert.",

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
    + "diesem Handy hat sich nichts geändert. Öffne auf dem Computer, mit dem du koppeln "
    + "wolltest, Einstellungen \u2192 Geräte und scanne den Code, der dort steht. Stammt dieser "
    + "Code von dort, antwortet etwas in deinem Netz an seiner Stelle.",
  connectSyncFailed: (detail: string, pinned: boolean) =>
    isPinFailure(detail)
      ? pinned
        ? `Synchronisierung angehalten. ${PIN_CHANGED}`
        : "Synchronisierung angehalten. Dieses Handy hat das Zertifikat unter dieser Adresse "
          + "nicht akzeptiert und deshalb nichts gesendet. Der Server braucht ein https-Zertifikat "
          + "von einer Stelle, der dieses Handy schon vertraut — siehe den Hinweis bei der Tür "
          + "„Dein eigener Server“."
      : `Synchronisierung fehlgeschlagen — der Spiegel behält, was er hat. ${detail}`,

  /* ------------------------------------------- transport & pairing refusals */

  admitCleartext:
    "Diese Adresse ist eine unverschlüsselte Verbindung, und ohmail sendet deine Mails nicht "
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
    "ohmail konnte die Identität dieses Computers auf diesem Handy nicht speichern und hat "
    + "deshalb angehalten, statt ohne sie zu verbinden.",
  admitPinUnenforceable:
    "Dieser Kopplungscode enthält einen Schlüssel, aber die Adresse darin ist ein Name, dessen "
    + "Zertifikat dieses Handy selbst prüft \u2014 der Schlüssel lässt sich also nicht prüfen, "
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
    `dieses Handy konnte die Kopplung nicht speichern (${detail}) — die Sitzung wurde geschlossen; erzeuge einen frischen Code und versuch es nochmal`,
  pairNotStoredOpen: (detail: string) =>
    `dieses Handy konnte die Kopplung nicht speichern (${detail}), und der Server war nicht `
    + "erreichbar, um die gerade geöffnete Sitzung zu schließen — widerrufe dieses Gerät in "
    + "seiner Geräteliste, erzeuge dann einen frischen Code und versuch es nochmal",
  pairEnded:
    "Dieses Handy wurde abgemeldet, weil seine Kopplung auf dem Server beendet wurde. "
    + "Koppele dieses Handy erneut.",
  pairAgain: "Erneut koppeln",
  accountErased:
    "Dieser ohmail-Account wurde gelöscht, deshalb ist seine Kopie deiner Mails von diesem Handy "
    + "entfernt. Die Mails auf deinem Mailserver sind unberührt.",
  pairRedeemUnreachable: "dieser Server war nicht erreichbar, um die Kopplung einzulösen",
  pairCodeRejected: "dieser Kopplungscode wurde nicht angenommen — erzeuge einen frischen und scanne erneut",
  pairNoAccountName:
    "gekoppelt, aber der Server konnte den Account nicht benennen, den diese Kopplung öffnet — "
    + "erzeuge einen frischen Code und koppele erneut, sobald es Mails hat",
  pairOwedDeletion: (detail: string) =>
    "Dieses Handy schuldet für die kopierten Mails dieses Postfachs noch eine Löschung und konnte "
    + `sie nicht ausführen (${detail}). Starte ohmail neu, damit es das abschließen kann, und `
    + "koppele dann mit einem frischen Code erneut.",
  notPairedHere: "dieser Server ist auf diesem Handy nicht mehr gekoppelt",
  pairingsUnreadable: (detail: string) =>
    `die gespeicherten Kopplungen dieses Handys ließen sich nicht lesen — ${detail}`,

  forgetCannotStart: (detail: string) =>
    `Dieses Handy konnte nicht beginnen, diesen Server zu vergessen (${detail}). Starte ohmail `
    + "neu, damit es die Löschungen abschließen kann, die es schon schuldet, und versuch es dann nochmal.",
  forgetKeystoreRefused: (detail: string) =>
    `Dieses Handy wollte die Kopplung nicht hergeben (${detail}). `
    + "Widerrufe dieses Gerät in der Geräteliste des Servers — das beendet die Sitzung, wo immer sie gehalten wird.",
  forgetMailRemains: (detail: string) =>
    "Die Kopplung ist entfernt, aber die Mails, die dieses Handy kopiert hatte, ließen sich nicht "
    + `löschen (${detail}). ohmail versucht es beim nächsten Start erneut.`,
  forgetEngineRemains: (detail: string) =>
    "Das Postfach auf diesem Handy ließ sich nicht entfernen: Seine Mails oder der Schlüssel zu "
    + `seinem gespeicherten Passwort ist noch hier (${detail}). Sonst wurde nichts angerührt — `
    + "starte ohmail neu, das schließt die Löschung ab, bevor es etwas öffnet.",
  forgetServerUnreachable:
    "Die Kopplung und die Mails, die dieses Handy kopiert hatte, sind weg. Der Server war nicht "
    + "erreichbar, um die Sitzung zu beenden, und zählt dieses Handy womöglich noch als "
    + "verbunden — widerrufe dieses Gerät in seiner Geräteliste, um das abzuschließen.",
  forgetClaimStands: (minutes: number) =>
    "Das Postfach und seine Mails sind von diesem Handy weg. Sein Anspruch auf das Postfach ließ "
    + `sich nicht zurückgeben, deshalb kann eine andere Maschine das Postfach in etwa ${minutes} `
    + "Minuten übernehmen.",
  forgetStillPending:
    "Dieser Server wird auf diesem Handy noch vergessen — ohmail konnte seine Anmeldung noch "
    + "nicht entfernen. Starte die App neu, damit sie das abschließen kann, oder widerrufe dieses "
    + "Gerät in der Geräteliste des Servers.",

  baseAddressMissing: "Die Adresse deines Servers fehlt.",
  baseNeedsTheCode:
    "Das ist eine numerische Adresse in einem Netz, und dafür kann keine Zertifizierungsstelle "
    + "bürgen — ohmail kann ihr deshalb nur über den Code vertrauen, den dein Computer zeigt. "
    + "Öffne dort Einstellungen → Geräte und scanne den.",
  baseCleartext:
    "Das ist eine unverschlüsselte Adresse, und ohmail sendet deine Mails nicht darüber. Gib die "
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
    + "Das kann am Netz zwischen diesem Handy und ihm liegen oder an einer Route auf dem Server, "
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
  whereChecked: (when: string) => `Geprüft ${when}`,
  whereSince: (lead: boolean) => (lead ? "Seit deinem letzten Besuch:" : "seit deinem letzten Besuch:"),
  whereTo: (count: number, pile: string) => `${count} in ${pile}`,
  whereJustNow: "gerade eben",
  whereMinutesAgo: (n: number) => (n === 1 ? "vor 1 Minute" : `vor ${n} Minuten`),
  whereHoursAgo: (n: number) => (n === 1 ? "vor 1 Stunde" : `vor ${n} Stunden`),
  whereDaysAgo: (n: number) => (n === 1 ? "vor 1 Tag" : `vor ${n} Tagen`),
  metaNew: (n: number) => `${n} neu`,
  metaWaiting: (n: number) =>
    `${n} ${n === 1 ? "neuer Absender wartet" : "neue Absender warten"}`,
  metaWaitingOnDevice: (n: number) =>
    `${n} ${n === 1 ? "neuer Absender wartet" : "neue Absender warten"}, auf diesem Handy gezählt`,
  screeningUnread: (holder: string) =>
    `Alle im Screener-Ordner werden angezeigt – die Screening-Einstellungen von ${holder} wurden noch nicht gelesen.`,
  screeningUnreadNoName:
    "Alle im Screener-Ordner werden angezeigt – die Screening-Einstellungen des organisierenden Geräts wurden noch nicht gelesen.",
  screeningUnstated: (holder: string) =>
    `Auf ${holder} läuft eine ältere ohmail-Version, die ihr Screening-Zeitfenster nicht teilt – alle im Screener-Ordner werden angezeigt.`,
  screeningUnstatedNoName:
    "Auf dem organisierenden Gerät läuft eine ältere ohmail-Version, die ihr Screening-Zeitfenster nicht teilt – alle im Screener-Ordner werden angezeigt.",
  metaWithReason: (count: string, reason: string) => `${count}. ${reason}`,
  metaItems: (n: number) => `${n} ${n === 1 ? "Eintrag" : "Einträge"}`,
  mailRowAria: (from: string, subject: string, time: string, unread: boolean) =>
    `${from}. ${subject.trim() === "" ? "" : `${subject}. `}${time}.${unread ? " Ungelesen." : ""}`,
  senderRowAria: (name: string, address: string, held: number, claim: string) =>
    `${name}, ${address}, ${held} zurückgehalten${claim ? `, ${claim}` : ""}`,
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
  ohboxEmptyHint: "Mails von Absendern, zu denen du Ja gesagt hast, landen hier, sobald sie synchronisiert sind.",
  ohboxEmptyNothingReadable:
    "Aus diesem Postfach ließ sich noch nichts lesen. Deine Mails liegen weiter auf deinem Server.",
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
    `Wird zur Regel: Künftige Mails von ${target} werden automatisch einsortiert. Die ✓-Hälfte markiert diese Mails außerdem als gelesen.`,
  decideUnsub: (claim: UnsubSaid, target: string, domain: boolean) =>
    domain
      ? claim === "sends"
        ? `Aussortieren und Spam senden den wartenden Absendern bei ${target} außerdem eine Ein-Klick-Abmeldung und melden dich bei späteren Mails der Domain mit Ein-Klick-Abmeldung erneut ab.`
        : `Bieten Absender bei ${target} Ein-Klick-Abmeldung an, melden Aussortieren und Spam dich gleich mit ab, jetzt und bei späteren Mails.`
      : claim === "sends"
        ? `Aussortieren und Spam senden ${target} außerdem eine Ein-Klick-Abmeldung und melden dich bei späteren Mails mit Ein-Klick-Abmeldung erneut ab.`
        : `Bietet ${target} Ein-Klick-Abmeldung an, melden Aussortieren und Spam dich gleich mit ab, jetzt und bei späteren Mails.`,
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
  allowLabel: "Zulassen: zurückgehaltene Mails freigeben",
  notSpamLabel: "Kein Spam: alle zurückgehaltenen Mails verschieben",
  spamNote:
    "Die Erkennung liest die Struktur — Absender, Header, Linkziele. Inhalte werden nirgendwohin gesendet.",
  waitingEmptyTitle: "Es wartet niemand.",
  waitingEmptyHint: "Neue Absender klopfen hier an, bevor irgendetwas in deine Ohbox kommt.",
  waitingNotYetTitle: "ohmail organisiert dieses Postfach noch nicht.",
  waitingNotOrganizedTitle: "Dieses Postfach wird von nichts organisiert.",
  waitingNotYetHint: "Niemand prüft neue Absender, deshalb landen sie direkt in deiner Ohbox. In den Einstellungen steht, was jedes Postfach organisiert.",
  waitingNotYetPress: "Einstellungen öffnen",
  cutlinePending:
    "Deine Screening-Einstellungen werden gelesen — bis sie da sind, steht diese Liste nicht fest.",
  screenedEmptyTitle: "Niemand aussortiert.",
  screenedEmptyHint: "Absender, zu denen du Nein sagst, warten hier — zurückgehalten, nie gelöscht.",
  spamEmptyTitle: "Kein Spam zurückgehalten.",
  spamEmptyHint:
    "Vermuteter Spam wartet hier auf deinen Blick — von sich aus löscht ohmail ihn nie. Mails, die du als Spam bestätigst, wandern in den eigenen Spam-Ordner deines Mailservers, oder bleibt hier zurückgehalten, wenn dein Postfach keinen hat.",

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
      case "origin_not_normalized": return "diese Serveradresse hatte nicht die Form, in der dieses Handy sie speichert";
      case "account_id_missing": return "der Server hat den Account nicht benannt, den diese Kopplung öffnet";
      case "pairing_not_recorded": return "dieses Handy konnte die Kopplung nicht erfassen, bevor es sie speichert";
      case "pairing_still_held": return "dieses Handy hält die Kopplung weiterhin";
      case "pairing_still_listed": return "dieses Handy führt die Kopplung weiterhin in seiner Liste";
      case "no_such_profile": return "eine solche Kopplung gibt es auf diesem Handy nicht";
      case "wipe_queue_full": return "dieses Handy hat bereits mehr unerledigte Löschungen, als es erfassen kann";
      case "wipe_not_recorded": return "dieses Handy konnte nicht erfassen, dass für die kopierten Mails eine Löschung aussteht";
      case "wipe_still_owed": return "dieses Handy führt für dieses Postfach noch eine ausstehende Löschung";
      case "wake_queue_full": return "dieses Handy hat bereits mehr unerledigte Weckruf-Abmeldungen, als es erfassen kann";
      case "wake_not_recorded": return "dieses Handy konnte nicht erfassen, dass für die Weckruf-Registrierung eine Abmeldung aussteht";
      case "wake_still_owed": return "dieses Handy führt für diese Registrierung noch eine ausstehende Abmeldung";
      case "index_unreadable": return "die Kopplungsliste dieses Handys ließ sich nicht lesen";
      case "purge_refused": return "der Schlüsselspeicher wollte die Kopplungen der früheren Installation nicht hergeben";
      case "mirror_not_deleted":
        return "dieses Handy konnte die gespeicherten Mails dieses Accounts nicht löschen";
      case "sync_held_pre_identity":
        return "ohmail prüft noch, welchen Account dieser Server öffnet";
      case "account_mismatch":
        return "dieser Server synchronisiert einen anderen Account als den, auf den diese Kopplung lautet";
      case "index_not_removed": return "der Schlüsselspeicher wollte die Kopplungsliste nicht entfernen";
      /* Das Entfernen des Postfachs auf diesem Handy. Jede benennt, welcher Speicher nicht
         losgelassen hat — der nächste Schritt hängt davon ab. */
      case "engine_removal_not_recorded":
        return "dieses Handy konnte nicht vermerken, dass das Postfach auf ihm entfernt wird";
      case "engine_removal_still_recorded":
        return "dieses Handy vermerkt noch eine unabgeschlossene Entfernung des Postfachs auf ihm";
      case "engine_store_not_deleted":
        return "dieses Handy konnte die Mails und das gespeicherte Passwort des Postfachs auf ihm nicht löschen";
      case "engine_key_not_removed":
        return "der Schlüsselspeicher wollte den Schlüssel nicht entfernen, der das gespeicherte Passwort dieses Postfachs öffnet";
      case "engine_store_not_durable":
        return "die Datenbank dieses Handys sicherte nicht zu, eine gespeicherte Änderung über einen Stromausfall zu behalten, deshalb wurde das Postfach darauf nicht geöffnet";
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
    `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`} aus diesem Ordner auf diesem Handy.`,
  folderEmptyTitle: "Aus diesem Ordner sind keine Mails auf diesem Handy.",
  folderEmptyHint:
    "Dieses Handy spiegelt die neueren Mails deines Servers, ältere Mails aus diesem Ordner erscheinen hier nicht.",

  history: "Historie",
  historyNavSub: "Alles, was dir gehört, neueste zuerst",
  historyMeta: (n: number) => `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`}`,
  historyExplainer: "Jede Nachricht, die dir gehört, die neueste zuerst — bis zur ersten zurück.",
  historyExplainerMore:
    "Verschoben wurde nichts: Jede Nachricht liegt weiter dort, wo dein Mailserver sie hat, und ihre Zeile nennt diesen Ordner. Die Monate und Jahre rechts springen an jede Stelle.",
  historyExplainerMoreLabel: "Was in der Historie liegt, und wo es liegt",
  historyEmptyTitle: "Noch nichts da.",
  historyEmptyHint: "Deine Mails erscheinen, sobald sie synchronisiert sind.",
  historyTail: (n: number) => `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`} in der Historie.`,
  historyLoading: "Deine Mails werden geladen.",
  historyStoreUnavailable: "Dein Server hat nicht geantwortet. Angezeigt werden die neueren Mails, die dieses Gerät hat.",
  historyStoreRetry: "Erneut versuchen",
  historyRowsNotLoaded: "Diese Nachrichten wurden nicht geladen. Scrolle, um es erneut zu versuchen.",
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
  folderErrGotMail: "In diesen Ordner kamen neue Mails, während er geleert wurde, deshalb wurde er nicht gelöscht. Lösch ihn noch einmal, um ihn erneut zu leeren.",
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
    "Ist ein Vorschlag zu einem wartenden Absender zu mindestens 90 % sicher, legt ohmail den Absender dort ab, wo der Vorschlag es sagt (Ohbox, News, Belege, Aussortiert oder Spam), und schreibt die Regel für dich. Jede solche Regel ist als Regel von ohmail markiert, und du kannst sie unter Einstellungen → Regeln rückgängig machen. Absender, denen du geschrieben hast, und sensible Mails werden so nie abgelegt. Gilt ein Vorschlag für Aussortiert oder Spam einer Nachricht, deren Absender nicht bestätigt wurde — weder von deinem Mailanbieter noch durch die Signatur, die die eigene Domain des Absenders auf die Nachricht gesetzt hat —, oder stützt er sich nur auf denselben Betreff von anderen neuen Absendern, legt ohmail nur diese Nachricht ab, schreibt keine Regel und führt sie unter „Automatisch einsortiert“ auf, wo du sie zurücklegen kannst. Standardmäßig aus.",
  autoActNeedsSuggest: "Braucht automatische Vorschläge",
  autoActReader: "Stell das auf der Installation ein, die deine Mails organisiert.",
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
  searchSimilarHintSynced: "In den bisher synchronisierten Mails passte nichts genau, das hier sind die ähnlichsten Wörter.",
  searchEmptyTitle: "Nichts gefunden.",
  searchPartReach: "Ein Teil innerhalb eines Wortes wird in Betreff, Absendern, Empfängern und Namen von Anhängen gesucht, nicht im Text der Nachricht.",
  searchIndexing: "Deine neueren Mails werden noch gelesen.",
  searchWholeSearching: "Dein ganzes Postfach wird durchsucht …",
  searchWhole: (n: number) => (n === 0 ? "Dein ganzes Postfach wurde durchsucht — nichts gefunden" : `Dein ganzes Postfach wurde durchsucht — ${n} gefunden`),
  searchWholeAtLeast: (n: number) => `Dein ganzes Postfach wurde durchsucht — mindestens ${n} gefunden`,
  searchWholeAbout: (n: number) => `Dein ganzes Postfach wurde durchsucht — etwa ${n} gefunden`,
  searchWholeNear: (n: number) => `Dein ganzes Postfach wurde durchsucht — ${n} mit einem ähnlichen Wort`,
  searchWholeNearAtLeast: (n: number) => `Dein ganzes Postfach wurde durchsucht — mindestens ${n} mit einem ähnlichen Wort`,
  searchSyncedNear: (n: number) => `Bisher synchronisierte Mails durchsucht: ${n} mit einem ähnlichen Wort`,
  searchSyncedNearAtLeast: (n: number) => `Bisher synchronisierte Mails durchsucht: mindestens ${n} mit einem ähnlichen Wort`,
  searchDepth: "Eine lange Nachricht wird in ihren ersten 65.536 Zeichen durchsucht.",
  searchSynced: (n: number) => (n === 0 ? "Bisher synchronisierte Mails durchsucht: nichts gefunden" : `Bisher synchronisierte Mails durchsucht: ${n} gefunden`),
  searchSyncedAtLeast: (n: number) => `Bisher synchronisierte Mails durchsucht: mindestens ${n} gefunden`,
  searchSyncedAbout: (n: number) => `Bisher synchronisierte Mails durchsucht: etwa ${n} gefunden`,
  searchSyncing: "Der Rest deiner Mails ist noch nicht synchronisiert.",
  searchServerMs: (ms: number) => `${ms} ms`,
  searchUnanswered: "Dein Server hat nicht geantwortet. Angezeigt werden die neueren Mails, die dieses Gerät hat.",
  searchWholeRetry: "Ganzes Postfach erneut durchsuchen",
  searchIndexingProgress: (percent: number) => `Ältere Mails werden noch indexiert: ${percent} % erledigt.`,
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
  themeNote: "Automatisch folgt dem System. Bleibt auf diesem Handy.",
  pictureQuality: "Bildqualität",
  pictureQualityNote:
    "JPEG- und PNG-Bilder werden auf diesem Handy verkleinert, bevor sie angehängt werden. Niedrigere Qualität bedeutet kleinere Dateien. Ein Bild, das dadurch nicht kleiner würde, wird unverändert angehängt, und „Original“ wird nie neu codiert. Bleibt auf diesem Handy.",
  pictureQualityLow: "Niedrig",
  pictureQualityMedium: "Mittel",
  pictureQualityHigh: "Hoch",
  pictureQualityOriginal: "Original",
  themeAuto: "Automatisch",
  themeLight: "Hell",
  themeDark: "Dunkel",

  language: "Sprache",
  languageNote: "Folgt diesem Handy, solange du nichts wählst. Gilt für ohmail auf diesem Gerät.",
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
    "Dieses Handy liest das Postfach. Entschieden wird dort, wo es organisiert wird.",
  phoneBannerStopped: (name: string) =>
    `${name} meldet sich nicht mehr. Bis wieder etwas dieses Postfach organisiert, warten neue Mails in der Inbox.`,

  about: "Über diesen Build",
  buildVersion: (version: string) => `Version ${version}`,
  buildVersionWithCode: (version: string, build: string) => `Version ${version} (${build})`,
  buildCommit: (commit: string) => `Build ${commit}`,
  aboutLive: (origin: string) =>
    `Gekoppelt mit ${origin}. Mails werden in einen Spiegel auf dem Gerät synchronisiert; Lesen, neue Nachrichten schreiben, Sortieren, Antworten, Weiterleiten, Tags und Suche sind live.`,
  aboutLiveHere:
    "Dieses Handy verbindet sich selbst mit deinem Mailserver und synchronisiert die Mails in einen Spiegel auf dem Gerät; Lesen, neue Nachrichten schreiben, Sortieren, Antworten, Weiterleiten, Tags und Suche sind live.",
  aboutOnDevice:
    "Einen Server zu vergessen löscht seine Kopplung und die Mails, die dieses Handy kopiert "
    + "hatte. Die App zu löschen nimmt die kopierten Mails mit; auf iPhone und iPad bleibt die "
    + "Kopplung im Schlüsselbund des Handys, bis ohmail wieder geöffnet wird — dann wird sie "
    + "verworfen, bevor irgendetwas geöffnet wird, und wenn das nicht gelingt, wird gar nichts "
    + "geöffnet. Um sie sofort zu beenden, widerrufe dieses Gerät in der Geräteliste des Servers. "
    + "Die Kopplung ist nie in einem Backup enthalten.",

  aboutOnDeviceBackup: (state: BackupExclusion): string =>
    state === "excluded"
      ? "Die kopierten Mails sind es auch nicht: Die gespeicherten Mails dieser App sind so markiert, "
        + "dass sie aus den Cloud- und Computer-Backups des Handys herausbleibt, und dieser "
        + "Build hat diese Markierung zurückgelesen."
      : state === "included"
        ? "Die kopierten Mails sind es: Sie liegen in den gespeicherten Dateien dieser App, und die "
          + "Cloud- und Computer-Backups des Handys schließen sie ein."
        : "Ob die kopierten Mails in einem Backup enthalten sind, konnte auf diesem Build nicht "
          + "gelesen werden — hier wird deshalb weder das eine noch das andere behauptet.",

  /* --------------------------------------------- the diagnostic file */

  diagnosticLabel: "Diagnosedatei",
  diagnosticWhy:
    "Schreibt eine Datei darüber, wie ohmail auf diesem Handy läuft: Versionen, Anzahlen, "
    + "Fehlercodes und die letzten Log-Ereignisse, nie Adressen, Betreffzeilen oder Ordnernamen. "
    + "Es wird nichts gesendet.",
  diagnosticAction: "Datei schreiben",
  diagnosticWriting: "Wird geschrieben…",
  diagnosticWritten: (path: string): string =>
    `Gespeichert unter ${path}, neben den kopierten Mails dieses Handys. Es wurde nichts `
    + "gesendet. Teile sie selbst mit uns, wenn wir sie ansehen sollen.",
  diagnosticShare: "Datei teilen",
  diagnosticShareFailed:
    "Dieses Handy konnte das Teilen-Menü nicht öffnen. Die Datei liegt weiter dort, wo sie "
    + "geschrieben wurde; es wurde nichts gesendet.",
  diagnosticFailed: "Die Datei konnte nicht geschrieben werden. Es wurde nichts gesendet.",

  /* --------------------------------------------- help & contact */

  helpRow: "Hilfe & Kontakt",
  helpRowSub: "support@ohmail.app · ein Mensch antwortet per Mail",
  helpSubject: "Hilfe zu ohmail",
  helpDiag: "Diagnose",
  helpDiagWhat:
    "Dieser Block enthält die App-Version und den Build, die Plattform, deine Account-ID, welche Art "
    + "Postfach verbunden ist und die Art seines letzten Sync-Fehlers. Er enthält nie Adressen, Hosts, "
    + "Betreffe, Ordnernamen oder Mailinhalte.",
  helpRemove: "Entfernen",
  helpRemoved: "Diagnose entfernt.",
  helpAddBack: "Wieder einfügen",
  helpDApp: "App",
  helpDBuild: "Build",
  helpDPlatform: "Plattform",
  helpDAccount: "Account",
  helpDMailbox: "Postfach",
  helpDLastSync: "Letzter Sync-Fehler",
  helpDNone: "keiner",

  /* --------------------------------------------- organizing in the background */

  stateOrganizing: "Organisiert",
  notifBody: (address: string): string => `Organisiert ${address}.`,
  notifStop: "Nicht mehr organisieren",
  notifStopFailed: "Stopp nicht abgeschlossen — wird erneut versucht.",
  organizerRestricted:
    "Der Energiesparmodus lässt ohmail auf diesem Handy nicht im Hintergrund organisieren. "
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
  gapLetters: (count: number, address: string) => count === 1
    ? `1 Mail ist in ${address} angekommen, und kein Gerät hat sie organisiert. Nach deinen Regeln ablegen?`
    : `${count} Mails sind in ${address} angekommen, und kein Gerät hat sie organisiert. Nach deinen Regeln ablegen?`,
  gapStrangers: (count: number, address: string) => count === 1
    ? `1 Mail von einem Absender, über den du nie entschieden hast, ist in ${address} angekommen, und kein Gerät hat sie organisiert. In den Screener legen?`
    : `${count} Mails von Absendern, über die du nie entschieden hast, sind in ${address} angekommen, und kein Gerät hat sie organisiert. In den Screener legen?`,
  gapBoth: (letters: number, strangers: number, address: string) =>
    `${letters === 1 ? "1 Mail" : `${letters} Mails`} für deine Regeln und `
    + `${strangers === 1 ? "1 von einem Absender, über den" : `${strangers} von Absendern, über die`} du nie entschieden hast, `
    + `sind in ${address} angekommen, und kein Gerät hat sie organisiert. `
    + "Nach deinen Regeln ablegen und die neuen Absender in den Screener legen?",
  gapFile: "Ablegen",
  gapScreen: "In den Screener",
  gapLeave: "Liegen lassen",
  gapChanged: "Die Mails haben sich seit dem Zählen geändert. Die neue Zahl steht oben.",
  gapFailed: "Keine Antwort möglich — versuch es nochmal.",

  /* ------------------------------------------------------------- new mail */

  wake: "Neue Mail",
  wakeNoDistributor:
    "Auf diesem Handy ist kein Push-Verteiler gewählt, es weckt diese App also nichts zwischen "
    + "deinen Besuchen. UnifiedPush-Verteiler sind eigene Apps, die du selbst wählst — ein Push-"
    + "Dienst von Google oder Apple ist so oder so nicht beteiligt. Mails kommen an, wenn du die App "
    + "öffnest oder zum Aktualisieren ziehst.",
  wakeNoPushIos:
    "Zwischen deinen Besuchen weckt nichts diese App auf diesem Handy. Mails kommen an, wenn du "
    + "die App öffnest oder zum Aktualisieren ziehst.",
  wakeDesktopHost:
    "Weckrufe brauchen einen gehosteten Server. Mit einem Desktop gekoppelt synchronisiert diese "
    + "App, wenn du sie öffnest und wenn du zum Aktualisieren ziehst.",
  wakeServerNoKey:
    "Dieser Server hat keinen Signaturschlüssel eingerichtet und kann daher keine Weckrufe senden, "
    + "die dieses Handy annehmen würde. Wer ihn betreibt, kann einen erzeugen — siehe die "
    + "Anleitung zum Self-Hosting. Mails kommen weiterhin an, wenn du die App öffnest oder zum "
    + "Aktualisieren ziehst.",
  wakeOn:
    "Solange ohmail läuft — geöffnet oder im Hintergrund — sagt dein Server diesem Handy, dass "
    + "sich etwas geändert hat, und die App holt deine Mails direkt. Wenn du die App schließt, kommt "
    + "stattdessen ein schlichter Hinweis „Neue Mail“ (sofern du Benachrichtigungen erlaubt hast); "
    + "ein Tippen darauf öffnet ohmail. So oder so trägt das Signal weder Betreff noch Absender "
    + "noch Anzahl.",
  wakeDistributor: "Push-Verteiler",
  wakeDistributorHint:
    "Die App, die das Wecksignal zu diesem Handy trägt. Du wählst sie, du kannst sie wechseln, "
    + "und außer deinem eigenen Server ist sie das Einzige auf dem Weg.",
  wakeDistributorNone: "Keiner",
  wakeDistributorNoneHint:
    "Das auszuschalten beendet die Weckrufe und entfernt die Registrierung von deinem Server.",
  wakeRowRemains:
    "Weckrufe sind auf diesem Handy aus. Dein Server wollte die Registrierung nicht entfernen "
    + "und versucht die alte Adresse womöglich noch eine Weile — versuch es nochmal, oder widerrufe "
    + "dieses Gerät in der Geräteliste des Servers.",
  wakeOff: (reason: string): string => reason === "endpoint_refused"
    ? "Der Server hat die Adresse deines Verteilers abgelehnt, Weckrufe sind deshalb aus. Mails "
      + "kommen weiterhin an, wenn du die App öffnest oder zum Aktualisieren ziehst."
    : "Weckrufe konnten nicht eingerichtet werden. Mails kommen weiterhin an, wenn du die App "
      + "öffnest oder zum Aktualisieren ziehst.",

  /* ------------------------------------------------- world (phone-specific) */

  groupResurfaced: "Wieder aufgetaucht",
  newSinceResurfaced: (n: number) => `${n} neu`,
  liveSaveFailed: "Diese Änderung ließ sich nicht speichern. Versuch es nochmal.",
  readerPressRefused: (name: string) =>
    `Nichts hat sich geändert — dieses Handy liest dieses Postfach nur. ${name} organisiert es, und Stapel und Tags werden dort gesetzt.`,
  readerPressRefusedUnknown:
    "Nichts hat sich geändert — dieses Handy liest dieses Postfach nur. Stapel und Tags werden dort gesetzt, wo es organisiert wird.",
  readerPressReadOnly: "Als gelesen markiert. Sonst hat sich nichts geändert — dieses Handy liest dieses Postfach nur.",
  readerPressRefusedNobody:
    "Nichts hat sich geändert — dieses Handy liest dieses Postfach nur. Im Moment organisiert es nichts.",
  liveDecided: (dest: string, target: string) =>
    `${dest} — künftige Mails von ${target} werden automatisch dorthin einsortiert.`,
  liveAlsoUnsubscribing: (said: string, how: UnsubToast) =>
    how === "sends"
      ? `${said} Rückgängig stoppt auch die Ein-Klick-Abmeldung. Sobald Rückgängig weg ist, wird sie gesendet und lässt sich nicht zurücknehmen, und spätere Mails des Absenders mit Ein-Klick-Abmeldung werden ebenfalls abgemeldet.`
      : how === "may"
        ? `${said} Bietet der Absender Ein-Klick-Abmeldung an, meldet ohmail dich ab, sobald Rückgängig weg ist, und bei späteren Mails erneut; Rückgängig stoppt das auch.`
        : how === "sent"
          ? `${said} ohmail sendet eine Ein-Klick-Abmeldung, die sich nicht zurücknehmen lässt, und meldet dich bei späteren Mails mit Ein-Klick-Abmeldung erneut ab.`
          : `${said} Bietet der Absender Ein-Klick-Abmeldung an, meldet ohmail dich jetzt und bei späteren Mails ab; eine gesendete Abmeldung lässt sich nicht zurücknehmen.`,
  liveDecidedElsewhere: (name: string, target: string) =>
    `Entschieden — ${name} sortiert ${target} beim nächsten Durchlauf ein.`,
  liveDecidedElsewhereUnknown: (target: string) =>
    `Entschieden — die Installation, die dieses Postfach organisiert, sortiert ${target} beim nächsten Durchlauf ein.`,
  liveDecideSent: (name: string, target: string) =>
    `An ${name} geschickt — ${target} wird dort innerhalb weniger Minuten einsortiert.`,
  liveDecideSentUnknown: (target: string) =>
    `An die Installation geschickt, die dieses Postfach organisiert — ${target} wird dort innerhalb weniger Minuten einsortiert.`,
  relayWaiting: (name: string) => `An ${name} geschickt — wartet darauf, dass es ausgeführt wird.`,
  relayWaitingUnknown: "An den Organizer geschickt. Wartet darauf, dass es ausgeführt wird.",
  relayRefused: (reason: string) => `Nicht ausgeführt — ${reason}`,
  relayRefusedUnknown: "Nicht ausgeführt. Der Organizer hat keinen Grund genannt.",
  relayReasonUnauthenticated: "es konnte nicht erkennen, dass die Entscheidung von dir kam",
  relayReasonConflict: "für denselben Absender kam zuerst eine andere Entscheidung an",
  relayReasonAccountErased: "den zugehörigen Account gibt es nicht mehr",
  relayReasonStale: "sie blieb zu lange unbeantwortet",
  relayReasonUnhandledKind: "es weiß nicht, wie diese Entscheidung auszuführen ist",
  relayReasonInvalidPayload: "es konnte die Entscheidung nicht lesen",
  relayReasonOtherMailbox: "die Entscheidung nannte ein Postfach, das es nicht organisiert",
  senderSentThere: (name: string) =>
    `Was du hier entscheidest, wird an ${name} geschickt und dort innerhalb weniger Minuten ausgeführt.`,
  readingAtConnect: (name: string) =>
    `Dieses Handy liest dieses Postfach. ${name} organisiert es, und deine Screener-Entscheidungen und Verschiebungen hier werden dorthin geschickt.`,
  readingAtConnectUnknown:
    "Dieses Handy liest dieses Postfach. Eine andere Installation organisiert es, und deine Screener-Entscheidungen und Verschiebungen hier werden dorthin geschickt.",
  readingAtConnectKept: (name: string) =>
    `Dieses Handy liest dieses Postfach. ${name} organisiert es. Deine Zustimmung bleibt gespeichert: Sobald ${name} es freigibt, bietet dieses Handy das Postfach an, und ein Tippen übernimmt es.`,
  readingAtConnectKeptUnknown:
    "Dieses Handy liest dieses Postfach. Eine andere Installation organisiert es. Deine Zustimmung bleibt gespeichert: Sobald sie es freigibt, bietet dieses Handy das Postfach an, und ein Tippen übernimmt es.",
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
    `${count === 1 ? "1 liegt" : `${count} liegen`} in ${place}. Auf den Rest ihrer Mails im Postfach wendet ohmail die Regel gerade an.`,
  liveDecideFailed: (sender: string) =>
    `Diese Entscheidung ließ sich nicht speichern — ${sender} wartet weiter.`,
  liveRuleFailedMoved: (place: string, target: string) =>
    `${place} — diese Nachricht ist verschoben, aber die Regel ließ sich nicht anlegen. Für künftige Mails von ${target} ändert sich nichts.`,
  liveOwnAddress: "Das ist deine eigene Adresse. Regeln sortieren Mails von anderen.",
  liveDecideUndoLate: "Zu spät — diese Entscheidung ist schon raus.",
  undoReplaced: "Eine spätere Wahl für diesen Absender hat diese ersetzt, hier gibt es nichts rückgängig zu machen.",
  undoReplacedLetterBack: "Die Mail ist wieder da, wo sie war. Wohin die Mails dieses Absenders gehen, entscheidet eine spätere Wahl.",
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
    `Nichts geändert: Die Regel für ${domain} entscheidet über Mails von ${sender}. Ändern kannst du sie im Web unter Einstellungen → Regeln.`,
  liveReleaseFailed: (sender: string) =>
    `Diese Freigabe ließ sich nicht speichern. Mails von ${sender} liegen, wo sie lagen.`,
  livePileAdded: (title: string) => `${title} — hinzugefügt.`,
  livePileFailed: (title: string) => `${title} — ließ sich nicht speichern. Versuch es nochmal.`,
  liveBodyLoading: "Die ganze Nachricht wird geladen…",
  liveBodyFailed: "Nur die Vorschau ließ sich laden. Öffne sie erneut, um es nochmal zu versuchen.",
  liveBodyWithheld:
    "Der Text ist hier nicht gespeichert — damit der Speicherplatz deines Tarifs reicht, speichert ohmail den Text älterer Nachrichten nicht mehr, auch den dieser (oder der Speicher war beim Eintreffen voll). Das hier ist die Vorschau; die Nachricht selbst liegt vollständig in deinem Postfach auf deinem Mailserver. Sobald wieder Platz frei ist, holt ohmail diesen Text von deinem Mailserver zurück.",
  liveBodyWithheldRemoved:
    "Der Text ist hier nicht gespeichert — damit der Speicherplatz deines Tarifs reicht, speichert ohmail den Text älterer Nachrichten nicht mehr, auch den dieser (oder der Speicher war beim Eintreffen voll). Das hier ist die Vorschau; die Nachricht selbst liegt vollständig in deinem Postfach auf deinem Mailserver. ohmail liest dieses Postfach nicht mehr, darum kommt dieser Text hier nicht zurück.",
  liveBodyWithheldJunk:
    "Hier nicht gespeichert — dein Spam-Urteil hat diese Nachricht in den Spam-Ordner deines eigenen Mailservers einsortiert. Dort lebt sie weiter; das hier ist die Vorschau.",
  liveBodyWithheldExpunged:
    "Keine gespeicherte Kopie mehr — jede Kopie dieser Nachricht ist aus den Ordnern verschwunden, die ohmail auf deinem Mailserver liest: dort gelöscht oder von einem anderen Mailprogramm verschoben. Diese Vorschau ist, was bleibt.",
  liveBodyWithheldTooLarge:
    "Nicht heruntergeladen — diese Nachricht ist größer als 64 MB, mehr lädt ohmail nicht herunter. Text und Dateien werden hier deshalb nicht gezeigt. Öffne sie bei deinem Mailanbieter.",
  liveBodyJunkLoading: "Diese Nachricht wird von deinem Mailserver geladen…",
  invitationWithoutEvent: "Das ist eine Besprechungseinladung, aber der Termin selbst ist nicht angehängt.",
  invitationOwaLink: "Diese Besprechungseinladung kam als Weblink statt als Termin an.",
  invitationOwaRemedy:
    "Damit Einladungen mit angehängtem Termin ankommen, lass dir in den Web-Einstellungen deines Mailanbieters unter POP und IMAP Besprechungseinladungen im iCalendar-Format senden, oder frag deine Administration.",
  invitationOwaOpenSetting: "Einstellung im Browser öffnen",
  icsRequest: "Einladung",
  icsCounter: "Neue vorgeschlagene Zeit",
  icsCancelled: "Abgesagt",
  icsAccepted: "Zugesagt",
  icsDeclined: "Abgelehnt",
  icsTentative: "Mit Vorbehalt",
  icsReply: "Antwort",
  icsEvent: "Termin",
  icsAllDay: "Ganztägig",
  icsPreviously: "war",
  icsInvited: (count: number) => `${count} eingeladen`,
  icsDaily: "Jeden Tag",
  icsEveryNDays: (n: number) => `Alle ${n} Tage`,
  icsWeekly: "Wöchentlich",
  icsWeeklyOn: (days: string) => `Wöchentlich am ${days}`,
  icsEveryNWeeks: (n: number) => `Alle ${n} Wochen`,
  icsEveryNWeeksOn: (n: number, days: string) => `Alle ${n} Wochen am ${days}`,
  icsMonthly: "Monatlich",
  icsEveryNMonths: (n: number) => `Alle ${n} Monate`,
  icsYearly: "Jährlich",
  icsEveryNYears: (n: number) => `Alle ${n} Jahre`,

  /* ------------------------------------------------- the mail body's frame */

  mailImagesBlockedOne: "1 externes Bild blockiert.",
  mailImagesBlockedMany: (n: number) => `${n} externe Bilder blockiert.`,
  mailPixelOne: "Eines davon ist ein Tracking-Pixel.",
  mailPixelMany: (n: number) => `${n} davon sind Tracking-Pixel.`,
  mailPixelOnly: "Ein Tracking-Pixel wurde blockiert.",
  mailPixelsRefused: (n: number) => `${n} Tracking-Pixel wurden blockiert.`,
  mailSheetBlockedOne:
    "Ein externes Stylesheet wurde blockiert; diese Nachricht kann darum schlicht aussehen.",
  mailSheetBlockedMany: (n: number) =>
    `${n} externe Stylesheets wurden blockiert; diese Nachricht kann darum schlicht aussehen.`,
  mailImagesFromPhone:
    "Bilder werden von diesem Handy geladen; jeder Absender sieht darum seine Netzwerkadresse.",
  mailImagesFromComputer:
    "Bilder werden über deinen Computer geladen; jeder Absender sieht darum dessen Netzwerkadresse.",
  mailImagesRefused: "Die Bilder konnten nicht geladen werden. Versuch es noch einmal.",
  mailImagesTooLarge:
    "Mit den Bildern ist diese Nachricht zu groß, um sie sicher darzustellen; die Bilder werden darum nicht angezeigt.",
  mailShowImages: "Bilder anzeigen",
  mailShowAsText: "Als Text anzeigen",
  mailShowOriginal: "Original anzeigen",
  bodyShowMore: (percent: number) => `Mehr anzeigen (${percent} % angezeigt)`,
  bodyHistoryShow: "Verlauf anzeigen",
  bodyHistoryHide: "Verlauf ausblenden",
  mailOversize:
    "Der HTML-Teil dieser Nachricht ist zu groß, um ihn sicher darzustellen. Die Textfassung wird gezeigt.",
  mailOpenLinkTitle: "Diesen Link öffnen?",
  mailOpenLinkOpen: "Öffnen",
  mailOpenLinkCancel: "Abbrechen",
  linkOpenRefused: "Nichts auf diesem Handy kann diesen Link öffnen.",
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
  attachmentShareRefused: "Nichts auf diesem Handy kann diese Datei öffnen.",
  mailFrameLabel: "Nachrichteninhalt",

  /* -------------------------------------------------------- message actions */

  routedBy: "Warum sie hier gelandet ist",
  earlierInThread: (n: number) =>
    n === 1
      ? "Früher in diesem Verlauf — vollständig gezeigt"
      : `Früher in diesem Verlauf — alle ${n} gezeigt`,
  laterInThread: (n: number) => `Später in diesem Verlauf — alle ${n} gezeigt`,
  restOfThread: (n: number) => `Der Rest dieses Verlaufs — alle ${n} gezeigt`,
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
  actionMarkReadCount: (n: number) => (n === 1 ? "1 ungelesene Nachricht als gelesen markieren" : `${n} ungelesene Nachrichten als gelesen markieren`),
  actionMarkUnread: "Als ungelesen markieren",
  actionDone: "Erledigt",
  actionMore: "Mehr",
  tabMore: "Mehr",
  standaloneName: "ohmail auf diesem Handy",

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
    `${place} — ${n === 1 ? `1 Nachricht von ${sender} verschoben` : `${n} Nachrichten von ${sender} verschoben`}. Künftige Mails von ihm landen auch dort. Seine übrigen Mails hier bleiben, wo sie sind.`,
  toastRuledFuture: (place: string, sender: string) =>
    `${place} — künftige Mails von ${sender} landen auch dort. Mails, die schon hier sind, bleiben, wo sie sind.`,
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
  toastRoutingUndone: "Die Mails sind wieder da, wo sie waren, und es wurde keine Regel angelegt.",
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
    `${n === 1 ? "1 Regel wurde" : `${n} Regeln wurden`} nie angelegt, weil seit der Anfrage zu viel Zeit vergangen ist. Verschieb die Mails noch einmal, wenn du die Regel weiterhin willst.`,
  deleteReplayExpired: (n: number) =>
    `${n === 1 ? "1 Nachricht wurde" : `${n} Nachrichten wurden`} nicht in den Papierkorb verschoben — seit der Anfrage ist zu viel Zeit vergangen. Lösche sie noch einmal, wenn du das weiterhin willst.`,
  deleteReplayGone: (n: number) =>
    `${n === 1 ? "1 Nachricht wurde" : `${n} Nachrichten wurden`} nicht in den Papierkorb verschoben — dieses Handy hat sie beim nächsten Start nicht gefunden. Lösche sie noch einmal, wenn du das weiterhin willst.`,
  /* Das Angebot der Ohbox — die `screener.unscreened*`-Sätze des Web-Katalogs, Wort für Wort. */
  unscreenedLead: (n: number) =>
    n === 1
      ? "1 Nachricht von einem Absender, über den du nie entschieden hast, liegt noch in der Inbox auf deinem Mailserver."
      : `${n} Nachrichten von Absendern, über die du nie entschieden hast, liegen noch in der Inbox auf deinem Mailserver.`,
  unscreenedAll: (n: number) => `${n} in den Screener`,
  unscreenedMoved: (n: number) => `${n} in den Screener gelegt. Dein Organizer verschiebt sie beim nächsten Durchlauf.`,
  unscreenedMovedNone: "Nichts mehr zu screenen.",
  unscreenedFailed: "Screenen nicht möglich. Versuch es noch einmal.",
  toastRead: "Als gelesen markiert.",
  toastReadPartial: (done: number, of: number) => `${done} von ${of} als gelesen markiert.`,
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
  cancelSend: "Senden abbrechen",
  sendCancelled: "Senden abgebrochen. Es wurde nichts gesendet.",
  sendCancelledInDrafts: "Senden abgebrochen. Die Nachricht liegt in den Entwürfen.",
  sendCancelledNotKept: "Senden abgebrochen. Es wurde nichts gesendet, aber der Text konnte nicht als Entwurf behalten werden.",
  replySending: "Wird gesendet …",
  replySent: "Antwort gesendet.",
  replyEarlierWent: "Diese Antwort wurde bereits gesendet. Dein neuerer Text wurde nicht als zweite Kopie gesendet.",
  earlierGoing: "Eine frühere Fassung dieser Nachricht wird bereits gesendet. Dein neuerer Text wird nicht als zweite Kopie gesendet.",
  replyQueued: "Noch nicht gesendet. ohmail versucht es weiter.",
  replySendingLong: "Sendet noch.",
  replyQueuedOffline: "Noch nicht gesendet. Dieses Handy hat kein Netz; die Nachricht geht raus, sobald es wieder da ist.",
  replyUnverified: "Wir konnten diesen Versand nicht bestätigen. Schau in deinen Gesendet-Ordner, bevor du nochmal sendest.",
  replyAlreadySent: "Zu spät zum Abbrechen. Diese Nachricht ist schon unterwegs.",
  replyCancelUnreachable: "Der Server war zum Abbrechen nicht erreichbar. ohmail fragt weiter nach und sendet das nicht noch einmal.",
  replyCancelUnreachableKept: "Der Server war zum Abbrechen nicht erreichbar. ohmail fragt weiter nach und sendet das nicht noch einmal. Der Text bleibt als Entwurf erhalten.",
  replyCancelUnreachableNotKept: "Der Server war zum Abbrechen nicht erreichbar, und der Text konnte nicht als Entwurf behalten werden. ohmail fragt weiter nach und sendet das nicht noch einmal.",
  replyFailed: "Senden hat nicht geklappt. Versuch es nochmal.",
  replyNotSecured: "Nicht gesendet. Die Verbindung zu deinem Mailserver konnte nicht gesichert werden.",
  replyLoginRefused: "Nicht gesendet. Dein Mailserver hat die Anmeldung abgelehnt.",
  replyUnreachable: "Nicht gesendet. Dein Mailserver war nicht erreichbar.",
  replyTooLong: (size: string) => `Nicht gesendet. Zu lang zum Senden — höchstens ${size}. Kürze die Nachricht und sende sie nochmal.`,
  replyTooLarge: "Nicht gesendet. Zu groß zum Senden. Kürze die Nachricht und sende sie nochmal.",
  replyBusy: "Nicht gesendet. Dein Mailserver ist gerade ausgelastet und nimmt nichts an. Versuch es gleich nochmal.",
  replyNotSignedIn: "Nicht gesendet — dein Entwurf ist gesichert. Dieses Postfach ist hier nicht angemeldet. Melde es in den Einstellungen neu an.",
  forwardFilesHead: "Wird mitgesendet",
  forwardFilesLine: (kept: string, more: string) => `Weitergeleitete Dateien: ${kept}. Bis zu ${more} mehr von diesem Handy.`,
  forwardFilesAllGo: (size: string, more: string) =>
    `Weitergeleitete Dateien: ${size}. Alle gehen mit. Bis zu ${more} mehr von diesem Handy.`,
  forwardFilesNone: (more: string) => `Bis zu ${more} von diesem Handy.`,
  forwardFilesReading: "Die Dateien der Nachricht werden gelesen …",
  forwardFilesUnreadKept: "Die Dateien der Nachricht konnten hier nicht gelesen werden. Die behaltenen gehen mit.",
  forwardFilesUnreadAllGo: "Die Dateien der Nachricht konnten hier nicht gelesen werden. Alle gehen mit.",
  forwardFilesRemovedGo: (size: string, more: string) =>
    `Weitergeleitete Dateien: ${size}. Dein Server sendet alle mit, auch die entfernten. Bis zu ${more} mehr von diesem Handy.`,
  forwardFilesUnreadRemovedGo: "Die Dateien der Nachricht konnten hier nicht gelesen werden. Dein Server sendet alle mit, auch die entfernten.",
  forwardFilesTooLarge: (limit: string) => `Die weitergeleiteten Dateien sind über ${limit}. Entferne einige, um sie zu senden.`,
  forwardTotalTooLarge: (limit: string) => `Das ist über den ${limit}, die dein Mailserver annimmt. Entferne einige Dateien, um sie zu senden.`,
  replyForwardPartsUnsupported: "Nicht gesendet. Dein Server sendet jede Datei einer Weiterleitung mit und kann die entfernten nicht weglassen.",
  replyForwardPartsChanged: "Nichts wurde gesendet. Die Dateien der weitergeleiteten Nachricht haben sich geändert. Öffne sie noch einmal und leite sie weiter.",
  replyForwardOriginalUnavailable: "Nicht gesendet. Das Original konnte nicht geladen werden, darum wurde es nicht weitergeleitet.",
  replySentElsewhere: "Nicht gesendet: Dieser Entwurf ging bereits von einem anderen Gerät aus.",
  composeSentElsewhere: "Dieser Entwurf wurde von einem anderen Gerät gesendet. Was du jetzt schreibst, wird als neuer Entwurf gespeichert.",
  composeSendAsNew: "Als neue Nachricht senden",
  replyChangedElsewhere: "Nicht gesendet: Dieser Entwurf wurde auf einem anderen Gerät geändert. Was du geschrieben hast, ist als neuer Entwurf gesichert.",
  replyChangedElsewhereUnsaved: "Nicht gesendet: Dieser Entwurf wurde auf einem anderen Gerät geändert. Was du geschrieben hast, ist noch hier und noch nicht gespeichert.",
  replyChangedElsewhereLater: "Nicht gesendet: Dieser Entwurf wurde auf einem anderen Gerät geändert. Was du geschrieben hast, bleibt auf diesem Telefon und wird als neuer Entwurf gesichert, sobald das geht.",
  composeKeptChangedElsewhere: "Dieser Entwurf wurde auf einem anderen Gerät geändert. Was du hier geschrieben hast, ist als neuer Entwurf gesichert.",
  replyDeletedElsewhere: "Nicht gesendet: Dieser Entwurf wurde auf einem anderen Gerät gelöscht.",
  composeDeletedElsewhere: "Dieser Entwurf wurde auf einem anderen Gerät gelöscht. Was du jetzt schreibst, wird als neuer Entwurf gespeichert.",
  composeNotSentOffline: "Nicht gesendet. Dieses Handy erreicht deinen Mailserver nicht. Die Nachricht liegt in den Entwürfen — sende sie erneut, sobald du wieder online bist.",
  replyUnverifiedAgain: "Nicht nochmal gesendet. Der erste Versand ist vielleicht schon raus, schau also zuerst in deinen Gesendet-Ordner.",
  replyUnverifiedSendAgain:
    "„Noch einmal senden“ schaut zuerst in deinem Gesendet-Ordner nach und sendet nur, wenn sie dort nicht ist. Legt dein Mailserver keine gesendeten Mails ab, kann sie doppelt ankommen.",
  replyUnverifiedClose: "Schließen",
  /* Die Anhänge des Editors — `apps/webapp/messages/de.json` (`compose.attach*`) byte für Byte,
     wo der Satz dort existiert. */
  attachFile: "Dateien anhängen",
  attachPhoto: "Ein Foto anhängen",
  attachCap: (size: string) => `Bis zu ${size} insgesamt`,
  attachRefused: (size: string) =>
    `Einige Dateien wurden nicht hinzugefügt — sie hätten das Total über ${size} gebracht.`,
  attachUnreadable: "Einige Dateien konnten nicht gelesen werden und wurden nicht hinzugefügt.",
  attachDuplicate: (filenames: string) => `Bereits angehängt: ${filenames}`,
  photoNamed: (stamp: string) => `Foto ${stamp}`,
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
  composeCc: "Kopie",
  composeBcc: "Blindkopie",
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
  composeFromSubstituted: (was: string) => `${was} ist getrennt, daher geht diese Nachricht von der Adresse oben raus.`,
  composeFromSubstitutedUnknown: "Die Adresse dieses Entwurfs ist getrennt, daher geht er von der Adresse oben raus.",
  composeSent: "Gesendet.",
  composeEarlierWent: "Diese Nachricht wurde bereits gesendet. Dein neuerer Text wurde nicht als zweite Kopie gesendet.",
  sentCopyMissing: (said: string) => `${said} Die Kopie konnte nicht in deinen Gesendet-Ordner gelegt werden.`,
  composeKept: "In den Entwürfen behalten.",
  composeKeptWithoutFiles: "In den Entwürfen behalten. Die Anhänge wurden nicht behalten.",
  composeKeptQueued: "Als Entwurf behalten. Er erscheint in den Entwürfen, sobald dieses Handy wieder online ist.",
  composeKeptQueuedWithoutFiles:
    "Als Entwurf behalten, ohne die Anhänge. Er erscheint in den Entwürfen, sobald dieses Handy wieder online ist.",
  composeKeepFailed: "Das konnte nicht als Entwurf behalten werden. Schließe noch einmal, um es zu verwerfen.",
  composeTooLong: (size: string) => `Zu lang zum Speichern — höchstens ${size}. Kürze die Nachricht, dann wird sie wieder gespeichert.`,
  composeKeepTooLong: (size: string) =>
    `Das kann nicht als Entwurf behalten werden — es ist über der Grenze von ${size}. Kürze es, oder schließe noch einmal, um es zu verwerfen.`,
  composeKeepTooLongBound: (size: string) =>
    `Diese Änderungen können nicht behalten werden — sie sind über der Grenze von ${size}, darum liegt in den Entwürfen noch die frühere Fassung. Kürze sie, oder schließe noch einmal, um die Änderungen zu verwerfen.`,
  composeKeepFiles: (names: string, size: string) =>
    `Nicht beim Entwurf behalten: ${names}. Dieses Handy behält bis zu ${size} Anhänge bei Entwürfen. Schließe noch einmal, um ihn ohne sie zu behalten.`,
  composeKeptHere: "In den Entwürfen behalten. Die Anhänge bleiben nur auf diesem Handy.",
  composeKeptQueuedHere: "Als Entwurf behalten, die Anhänge nur auf diesem Handy. Er erscheint in den Entwürfen, sobald dieses Handy wieder online ist.",
  lettersKept: (n: number) => (n === 1
    ? "Eine Nachricht, die du geschrieben hast, als ohmail beendet wurde, liegt in den Entwürfen."
    : `${n} Nachrichten, die du geschrieben hast, als ohmail beendet wurde, liegen in den Entwürfen.`),
  lettersKeptChangedElsewhere: (n: number) => (n === 1
    ? "Eine Nachricht, die du geschrieben hast, als ohmail beendet wurde, liegt als neuer Entwurf in den Entwürfen, weil ihr Entwurf auf einem anderen Gerät geändert wurde. Diese Fassung bleibt ebenfalls erhalten."
    : `${n} Nachrichten, die du geschrieben hast, als ohmail beendet wurde, liegen als neue Entwürfe in den Entwürfen, weil ihre Entwürfe auf einem anderen Gerät geändert wurden. Diese Fassungen bleiben ebenfalls erhalten.`),
  lettersKeptWithout: (n: number, names: string) => (n === 1
    ? `Eine Nachricht, die du geschrieben hast, als ohmail beendet wurde, liegt in den Entwürfen, ohne ${names}: mehr, als dieses Handy bei Entwürfen behält.`
    : `${n} Nachrichten, die du geschrieben hast, als ohmail beendet wurde, liegen in den Entwürfen, ohne ${names}: mehr, als dieses Handy bei Entwürfen behält.`),
  letterSendUnclear: (n: number) => (n === 1
    ? "Eine Nachricht, die du gesendet hast, als ohmail beendet wurde, liegt in den Entwürfen. Sieh in Gesendet nach, bevor du sie noch einmal sendest."
    : `${n} Nachrichten, die du gesendet hast, als ohmail beendet wurde, liegen in den Entwürfen. Sieh in Gesendet nach, bevor du sie noch einmal sendest.`),
  letterSendUnconfirmed: (n: number) => (n === 1
    ? "Eine Nachricht, deren Senden nie bestätigt wurde, liegt in den Entwürfen. Sieh in Gesendet nach, bevor du sie noch einmal sendest."
    : `${n} Nachrichten, deren Senden nie bestätigt wurde, liegen in den Entwürfen. Sieh in Gesendet nach, bevor du sie noch einmal sendest.`),
  composeNeedRecipient: "Trag jemanden ein, an den sie gehen soll.",
  composeNoMailbox: "Noch kann kein Postfach auf diesem Handy senden.",
  composeNoMailboxHint: "Sobald dieses Handy Mails hat, kannst du von diesem Postfach aus schreiben.",

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
    "Dieses Handy organisiert dein Postfach nur, solange ohmail darauf läuft, und kann eine Nachricht deshalb nicht für einen späteren Zeitpunkt aufbewahren. Sende jetzt, oder plane den Versand auf einem Computer oder in ohmail Cloud.",
  scheduledReaderHere: (name: string) =>
    `Dieses Handy liest dein Postfach und ${name} organisiert es, deshalb kann dieses Handy keine Nachricht für einen späteren Zeitpunkt aufbewahren. Sende jetzt, oder plane den Versand auf ${name}.`,
  scheduledReaderHereStopped: (name: string) =>
    `Dieses Handy liest dein Postfach und ${name} organisiert es nicht mehr, deshalb kann dieses Handy keine Nachricht für einen späteren Zeitpunkt aufbewahren. Sende jetzt, oder plane den Versand auf ${name}, sobald es wieder läuft.`,

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
  awayUnsavedStillOff: "Noch nicht gespeichert — die Abwesenheitsantwort bleibt aus, bis du speicherst.",
  awayUnsavedStillOn: "Noch nicht gespeichert — die gespeicherte Abwesenheitsantwort bleibt an, bis du speicherst.",
  awayLeaveAsk: "Verlassen, ohne zu speichern?",
  awayLeaveDiscard: "Änderungen verwerfen",
  awayLeaveKeep: "Weiter bearbeiten",
  awayRow: "Abwesenheitsantwort",
  awayRowSub: "Eine automatische Antwort, solange du weg bist.",
  awayScopeElsewhere: "Diese stellst du auf einem Computer oder in ohmail Cloud ein. Dieses Handy schickt sie unverändert zurück.",
  awayPileOther: (folder: string) => `Auch ${folder}`,
  awayPilesNone: "Keine Ablage bekommt eine Antwort, es wird also nichts gesendet.",
  awayWhereThisPhone: "Antworten werden gesendet, solange ohmail auf diesem Handy läuft.",
  awayWhereHost: (host: string) => `Antworten werden gesendet, solange ohmail auf ${host} läuft.`,
  awayChangedElsewhere: "Auf einem anderen Gerät geändert. Das sind die Abwesenheitseinstellungen, die jetzt gelten.",

  draftsTitle: "Entwürfe",
  draftsExplainer: "Nachrichten, die du begonnen und nicht gesendet hast.",
  draftsMeta: (total: number, held: number, waiting: number): string => {
    const drafts = total === 1 ? "1 Entwurf" : `${total} Entwürfe`;
    const said = held === 0 ? drafts : `${drafts} · ${held} nicht bestätigt`;
    return waiting === 0 ? said : `${said} · ${waiting} ${waiting === 1 ? "wartet" : "warten"} auf den Versand`;
  },
  draftsEmptyTitle: "Nichts Halbfertiges",
  draftsEmptyHint: "Sie liegen in deinem Account und sind deshalb auf jedem Gerät da, auf dem du deine Mails liest.",
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
  draftsSendAgainAlreadyWent: "Sie war schon raus — sie liegt in deinem Gesendet-Ordner. Nichts wurde nochmal gesendet.",
  draftsSendAgainChanged:
    "Nicht nochmal gesendet. Sie lässt sich der festgehaltenen Nachricht nicht zuordnen, deshalb kann sie nicht als dieselbe rausgehen. Ist sie nicht angekommen, mach sie wieder zum Entwurf und sende sie als neue Nachricht.",
  draftsNotArrived: "Wieder zum Entwurf machen",
  draftsSendAgainUnchecked: "Nicht nochmal gesendet. Dein Gesendet-Ordner konnte vorher nicht geprüft werden. Versuch es gleich nochmal.",
  draftsSendAgainNotHeld: "Diese Nachricht wartet nicht mehr darauf, nochmal gesendet zu werden.",
  draftsSendAgainBusy: "Diese Nachricht wird gerade gesendet.",
  draftsDiscard: "Verwerfen",
  draftsDiscardWhat: "Das löscht die einzige Kopie.",
  draftsWaiting: "Wartet auf den Versand",
  draftsDiscardWaitingWhat: "Das bricht das Senden ab und löscht die einzige Kopie.",
  draftsDiscardedNotSent: "Verworfen. Es wurde nichts gesendet.",
  draftsDiscardConfirm: "Verwerfen",
  draftsDiscardCancel: "Behalten",
  draftsDiscardStillSending:
    "Nicht verworfen — diese Nachricht wird gerade gesendet, oder ihr Versand wird noch bestätigt. Versuch es in ein paar Minuten noch einmal.",
  draftsDiscardRefused: (reason: string) => `Nicht verworfen: ${reason}`,
  draftsDiscardRefusedUnnamed:
    "Das ist nicht durchgegangen, und der Server hat nicht gesagt, warum. Der Entwurf ist noch da.",
  draftsDiscardQueued:
    "Noch nicht verworfen: Dieses Handy konnte deinen Account nicht erreichen. Wir versuchen es weiter.",
  draftsDiscardAwaitingOrganizer:
    "Angefragt. Die Installation, die dieses Postfach organisiert, verwirft ihn bei ihrem nächsten Durchlauf.",
  draftsOpenConversation: "Unterhaltung öffnen",
  draftsEditNote:
    "Dieser Entwurf lässt sich hier nicht bearbeiten. Bearbeiten und senden kannst du ihn in ohmail im Web oder auf dem Desktop.",
  draftsForwardOriginalAbsent:
    "Die Nachricht, die dieser Entwurf weiterleitet, ist nicht auf diesem Handy. Bearbeiten und senden kannst du ihn in ohmail im Web oder auf dem Desktop.",
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
    "Tags speichert ohmail, nicht dein Postfach. Deine Ordner sind echte IMAP-Ordner und bleiben, wenn du gehst; Tags nicht: Wenn du deinen Account löschst, sind sie weg.",
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
  domainAlsoFiles: (count: number, senders: string): string =>
    `Sortiert außerdem ${count === 1 ? "1 Mail" : `${count} Mails`} von anderen bei dieser Domain ein: ${senders}.`,
  senderPastTheGate: (n: number): string =>
    n === 1
      ? "Eine Mail dieses Absenders ist schon in deinen Mails. Die Mails unten haben hier gewartet."
      : `${n} Mails dieses Absenders sind schon in deinen Mails. Die Mails unten haben hier gewartet.`,
  senderCheckImpersonation: (brand: string, domain: string): string =>
    `Diese Nachricht gibt sich als ${brand} aus, aber ${domain} ist keine Adresse von ${brand}.`,
  senderCheckImpersonationShared: (brand: string, domain: string): string =>
    `Diese Nachricht gibt sich als ${brand} aus, aber eine ${domain}-Adresse kann sich jeder anlegen.`,
  senderCheckChip: (brand: string): string => `Nicht ${brand}`,
  senderCheckList: "Über eine Mailingliste verschickt — alle auf der Liste können unter dieser Adresse schreiben.",
  senderCheckUnverified: (brand: string): string =>
    `Diese Nachricht gibt an, von ${brand} zu kommen. Dein Mailanbieter hat das nicht bestätigt.`,
  screeningScopeShared: (domain: string): string =>
    `${domain} ist ein geteilter Anbieter. Entscheide hier pro Adresse.`,
  rulesSharedProviderInert: (domain: string): string =>
    `Alle bei ${domain}: ein geteilter Anbieter, diese Regel lässt niemanden durch. Entscheide pro Adresse.`,
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
  bootNeedsCredential: "eine Anmeldung und eine Account-ID werden beide gebraucht",
  bootAccountMismatch: (serverSays: string, expected: string) =>
    `diese Anmeldung gehört zum Account „${serverSays}“, nicht zu „${expected}“ — prüfe die eingegebene Account-ID`,
  bootMirrorFailed: (detail: string) => `der Spiegel auf dem Gerät ließ sich nicht öffnen: ${detail}`,
  installMarkerUnopenable: (detail: string) =>
    `die Installationsmarke ließ sich nicht öffnen: ${detail}`,
  installPurgeFailed: (detail: string) =>
    `die Kopplungen der alten Installation ließen sich nicht entfernen: ${detail}`,
  installMarkerUnreadable: (detail: string) => `die Installationsmarke ließ sich nicht lesen: ${detail}`,
  /* Drei Absagen ohne Argument — der Wert im Schlüsselspeicher ist geheim; siehe `copy.en.ts`. */
  kekUnreadable:
    "Der Schlüsselspeicher dieses Handys hält etwas, das kein Schlüssel ist, deshalb lässt sich "
    + "das damit versiegelte Postfach-Passwort nicht öffnen. ohmail ersetzt ihn nicht: ein neuer "
    + "Schlüssel würde dieses Passwort endgültig aussperren. Deine Mails auf dem Server bleiben "
    + "unberührt — richte dieses Handy für das Postfach neu ein, um von vorn zu beginnen.",
  kekNotGenerated:
    "Dieses Handy konnte den Schlüssel für das Postfach-Passwort nicht erzeugen, deshalb wurde "
    + "nichts gespeichert und nichts versiegelt. Auf dem Server hat sich nichts geändert. Schließe "
    + "ohmail und öffne es erneut.",
  kekNotKept:
    "Der Schlüsselspeicher dieses Handys hat den Schlüssel für das Postfach-Passwort angenommen "
    + "und nicht zurückgegeben, deshalb wurde nichts damit versiegelt. Auf dem Server hat sich "
    + "nichts geändert. Schließe ohmail und öffne es erneut.",
  connectSuperseded: "ein neuerer Verbindungsversuch hat übernommen.",

  /* "geht nach" + a place name has the same case problem; the web client's own heading for this
     pane asks the question instead (`screening.sectionWhere`: "Wohin ihre Mails gehen"). */
  screeningFor: (sender: string) => `Wohin die Mails von ${sender} gehen`,
  /* Carried with the English above; see `copy.en.ts` for why these live in the deck. */
  unsavedCount: (n: number): string =>
    (n === 1 ? "1 Änderung konnte nicht gespeichert werden" : `${n} Änderungen konnten nicht gespeichert werden`),
  unsavedPendingCount: (n: number): string =>
    (n === 1 ? "1 Änderung ist noch nicht durch" : `${n} Änderungen sind noch nicht durch`),
  unsavedQueuedWhy: "Dieses Handy konnte deinen Account nicht erreichen. Es versucht es weiter.",
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
  unsavedKindRead: "Mails als gelesen markieren",
  unsavedKindSend: "Eine Nachricht senden",
  unsavedKindDraft: "Einen Entwurf speichern",
  unsavedKindDraftDiscard: "Einen Entwurf verwerfen",
  unsavedKindSchedule: "Einen geplanten Versand abbrechen",
  unsavedKindTag: "Eine Tag-Änderung",
  unsavedKindFolder: "Eine Ordner-Änderung",
  unsavedKindRule: "Eine Regel-Änderung",

  screeningNote: (target: string) =>
    `Diese Nachricht wird jetzt dorthin verschoben. Wird zur Regel: Künftige Mails von ${target} werden automatisch dorthin einsortiert. Die übrigen Mails hier bleiben, wo sie sind.`,
  screeningNoteNobody:
    "Dieses Postfach wird von nichts organisiert, deshalb sortiert eine Regel von hier nichts davon ein, bis es wieder organisiert wird. In den Einstellungen steht, was jedes Postfach organisiert.",
  screeningNoteRetro: (target: string) =>
    `Diese Nachricht wird jetzt dorthin verschoben. Wird zur Regel: Künftige Mails von ${target} werden automatisch dorthin einsortiert. Außerdem wendet ohmail die Regel auf die übrigen Mails an, die es schon für dich einsortiert hat. Nachrichten, die du beantwortet, selbst hier oder in einer anderen Mail-App einsortiert oder geparkt hast, bleiben unberührt.`,
  screeningRetroToggle: "Auch die Mails verschieben, die schon im Postfach liegen",
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
  screeningRuleAll: "Alle ihre Mails",
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
  screeningPressRuled: (place: string, sender: string) => `${place} — Mails von ${sender} landen dort, künftige auch.`,
  screeningPressRemoved: (place: string, sender: string, rules: number, term: string) =>
    `${place} — Mails von ${sender} landen dort, künftige auch. ${rules === 1 ? `Deine Regel »${term}« wird entfernt.` : `${rules} deiner Regeln werden entfernt.`}`,
  screeningPressKeptOne: (place: string, sender: string, term: string, keptPlace: string) =>
    `${place} — Mails von ${sender} landen dort, außer »${term}«, das bleibt in ${keptPlace}.`,
  screeningPressKeptMany: (place: string, sender: string, rules: number) =>
    `${place} — Mails von ${sender} landen dort, außer dem, was ${rules === 1 ? "deine Regel woanders hält" : `${rules} deiner Regeln woanders halten`}.`,
  screeningPressException: (place: string, sender: string, domain: string, domainPlace: string) =>
    `${place} — Mails von ${sender} landen dort, künftige auch. Alle anderen bei ${domain} bleiben in ${domainPlace}.`,
  screeningRoutingUndoneRules: "Die Mails sind wieder da, wo sie waren, und deine Regeln sind unverändert.",
  screeningVerdictAll: (count: number, sender: string, place: string) =>
    count === 1 ? `Die 1 Nachricht von ${sender} liegt in ${place}.` : `Alle ${count} von ${sender} liegen in ${place}.`,
  screeningVerdictQueued: (name: string, sender: string, place: string) =>
    `Für ${name} vorgemerkt. Beim nächsten Durchlauf: Mails von ${sender} → ${place}, und die Regel wird angelegt.`,
  screeningVerdictQueuedUnnamed: (sender: string, place: string) =>
    `Für den Organizer vorgemerkt. Beim nächsten Durchlauf: Mails von ${sender} → ${place}, und die Regel wird angelegt.`,
  screeningVerdictChanged: (term: string) => `Deine Regel »${term}« wurde inzwischen geändert und bleibt deshalb, wie sie ist.`,

  connectionSignInRefused: "Der Mailserver hat die Anmeldung abgelehnt.",
  connectionCertificateRefused:
    "Dieses Handy hat das Zertifikat des Mailservers nicht akzeptiert und deshalb abgebrochen, bevor das Passwort rausging.",
  signInAgain: "Erneut anmelden",
  signInAgainLead:
    "Hast du das Passwort dieses Postfachs bei deinem Anbieter geändert? Gib ohmail das neue. Die Mails, die schon auf diesem Handy sind, bleiben, wo sie sind.",
  signInAgainField: "Neues Passwort",
  signInAgainLeadProvider: (_provider: string, account: string) =>
    `Hast du dein ${account}-Passwort geändert? Das beendet alle App-Passwörter: Erstell ein neues App-Passwort `
    + "und gib es ohmail hier. Die Mails, die schon auf diesem Handy sind, bleiben, wo sie sind.",
  signInAgainFieldProvider: "Neues App-Passwort",
  connectionSignInRefusedProvider: (provider: string, account: string) =>
    `${account} hat die Anmeldung abgelehnt. ${provider} braucht ein App-Passwort, und wenn du dein `
    + `${account}-Passwort änderst, enden alle App-Passwörter: Erstell ein neues und wähl „Erneut anmelden“.`,
  signInAgainHint: "Wird auf diesem Handy versiegelt und nur an den eigenen Server dieses Postfachs gesendet.",
  signInAgainSave: "Speichern und anmelden",
  signInAgainSaving: "Anmeldung läuft…",
  signInAgainCancel: "Abbrechen",
  signInAgainDone: "Angemeldet. Dieses Postfach synchronisiert wieder.",
  signInAgainFailed: (detail: string) =>
    `Dieses Passwort wurde nicht akzeptiert: ${detail}. Auf diesem Handy hat sich nichts geändert.`,

  /* DIE SERVER DES POSTFACHS, AN ORT UND STELLE BEARBEITET. Mit dem Passwort geprüft, bevor etwas bleibt. */
  serverSettings: "Servereinstellungen",
  serverSettingsLead:
    "ohmail prüft diese Einstellungen mit deinem Passwort, bevor es sie behält. Bis sie funktionieren, ändert sich auf diesem Handy nichts.",
  serverSettingsPassword: "Passwort",
  serverSettingsPasswordHint: "Wird zum Prüfen der neuen Einstellungen verwendet und nur an die eigenen Server dieses Postfachs gesendet.",
  serverSettingsSave: "Prüfen und speichern",
  serverSettingsSaving: "Wird geprüft…",
  serverSettingsCancel: "Abbrechen",
  serverSettingsSaved: "Gespeichert. Dieses Postfach verwendet jetzt diese Einstellungen.",
  serverSettingsNoPassword: "Gib das Passwort dieses Postfachs an, um die neuen Einstellungen zu prüfen.",
  serverSettingsUnreadable: "Dieses Handy konnte die Servereinstellungen dieses Postfachs nicht lesen. Versuche es noch einmal.",
  serverSettingsImapUnreachable:
    "ohmail hat deinen Eingangsserver (IMAP) unter dieser Adresse und diesem Port nicht erreicht. Prüf beides. Auf diesem Handy hat sich nichts geändert.",
  serverSettingsHostWhileOrganizing:
    "Solange dieses Handy dieses Postfach organisiert, bleibt sein Eingangsserver, wie er ist. Beende das Organisieren hier, ändere den Server und organisiere dann wieder hier.",
  serverSettingsHostHeld: (name: string) =>
    `${name} organisiert dieses Postfach auf diesem Server. Auf diesem Handy hat sich nichts geändert.`,
  serverSettingsHostHeldUnnamed:
    "Eine andere Installation organisiert dieses Postfach auf diesem Server. Auf diesem Handy hat sich nichts geändert.",
  serverSettingsRefused: (detail: string) =>
    `Diese Einstellungen wurden nicht behalten: ${detail}. Auf diesem Handy hat sich nichts geändert.`,

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
  selfCheckPredecessor: (folder: string, n: number) =>
    `${folder}, der Ordner von News vor der Umbenennung (${n} ${n === 1 ? "Nachricht" : "Nachrichten"} noch nicht nach News verschoben)`,
  selfCheckAndMore: (list: string, n: number) => `${list} und ${n} weitere`,
  selfCheckFailed: "Die Prüfung konnte nicht laufen. Es wurde nichts verändert.",
  selfCheckWaiting: (count: number) =>
    `${count === 1 ? "1 Nachricht wartet" : `${count} Nachrichten warten`} noch darauf, auf deinem Mailserver einsortiert zu werden.`,

  /* ── WAS AUFS EINSORTIEREN WARTET — `ui/filing-lines.ts`, die Worte des Webs. */
  filingStuck: (count: number, minutes: number) =>
    `${count === 1 ? "1 Nachricht wurde" : `${count} Nachrichten wurden`} seit ${minutes === 1 ? "1 Minute" : `${minutes} Minuten`} nicht einsortiert`,
  filingStuckHours: (count: number, hours: number) =>
    `${count === 1 ? "1 Nachricht wurde" : `${count} Nachrichten wurden`} seit ${hours === 1 ? "1 Stunde" : `${hours} Stunden`} nicht einsortiert`,
  filingStuckWhy: (where: string, reason: string) => `${where} · ${reason}`,
  filingWaiting: (count: number) => `${count === 1 ? "1 Nachricht wartet" : `${count} Nachrichten warten`} auf den nächsten Versuch`,
  filingWaitingWhy: (where: string, reason: string, at: string) => `${where} · ${reason} · nächster Versuch um ${at}`,
  mailboxCountWaiting: (count: number) => (count === 1 ? "1 Postfach" : `${count} Postfächer`),
  filingReasonsDiffer: "die Gründe sind je Postfach verschieden",
  filingReasonRefused: "der letzte Versuch ging nicht durch",
  filingReasonNoSuchFolder: "der Ordner ist nicht da",
  filingReasonReadOnly: "der Ordner nimmt es nicht an",
  filingReasonOverQuota: "das Postfach ist voll",
  filingReasonStaleLocator: "ohmail findet es auf deinem Mailserver nicht wieder",
  filingReasonUnconfirmed: "ohmail konnte das Verschieben nicht bestätigen",
  filingReasonUnknown: "der letzte Versuch ging nicht durch",
  filingReasonNone: "keine Ablehnung verzeichnet",
  filingStripOpen: "In den Einstellungen zeigen",
  filingsTitle: (mailbox: string) => `Wartet aufs Einsortieren · ${mailbox}`,
  filingsGroup: (count: number, folder: string, since: string) =>
    `${count === 1 ? "1 Nachricht wartet" : `${count} Nachrichten warten`} seit ${since} aufs Einsortieren: ${folder}`,
  filingsWhy: (reasons: string) => `Grund: ${reasons}`,
  filingsReasonCounted: (reason: string, count: number) => `${reason} (${count})`,
  filingsNext: (at: string) => `Nächster Versuch um ${at}.`,
  filingsAt: (count: number, at: string) => `${count === 1 ? "Sie liegt" : "Sie liegen"} auf deinem Mailserver in ${at}.`,
  filingsDeletesAll: (count: number) => (count === 1 ? "Du hast sie gelöscht." : "Du hast sie alle gelöscht."),
  filingsDeletesSome: (count: number) => (count === 1 ? "1 davon hast du gelöscht." : `${count} davon hast du gelöscht.`),
  filingsUnread: (count: number) => `${count === 1 ? "1 Nachricht wartet" : `${count} Nachrichten warten`} aufs Einsortieren.`,
  filingsRetry: "Jetzt erneut versuchen",
  filingsLeave: "Dort lassen, wo sie sind",
  filingsRetried: (count: number) => (count === 0 ? "Hier wartete nichts auf einen neuen Versuch."
    : count === 1 ? "1 Nachricht wird beim nächsten Durchlauf erneut versucht." : `${count} Nachrichten werden beim nächsten Durchlauf erneut versucht.`),
  filingsLeft: (count: number) => (count === 0 ? "Hier war nichts mehr festzulegen."
    : count === 1 ? "1 Nachricht bleibt, wo sie ist." : `${count} Nachrichten bleiben, wo sie sind.`),
  filingsFailed: "Das ging nicht durch. Es wurde nichts geändert.",
  filingsElsewhere: "Eine andere Installation organisiert dieses Postfach jetzt. Es wurde nichts geändert.",

  mailRowThreadAria: (n: number) =>
    `${n} ${n === 1 ? "Nachricht" : "Nachrichten"} in diesem Gespräch`,
  mailRowNewSinceAria: (n: number) =>
    `${n} ${n === 1 ? "Nachricht" : "Nachrichten"}, seit das wieder aufgetaucht ist`,
  mailRowMarksAria: (count: number, unread: number) =>
    `${count} Nachrichten, älteste zuerst: ${unread === 0 ? "alle gelesen" : `${unread} ungelesen`}`,
  rowMarksMore: (n: number) => `+${n}`,
  readerMarksAria: "Nachrichten in diesem Gespräch",
  readerMarkFrom: (position: number, count: number, sender: string, unread: boolean) =>
    `Nachricht ${position} von ${count}, von ${sender}, ${unread ? "ungelesen" : "gelesen"}`,
  readerMarkMine: (position: number, count: number) => `Nachricht ${position} von ${count}, von dir gesendet`,
  readerMarkYou: "du",
  readerMarkYesterday: "gestern",
  readerMessageActions: "Nachrichtenaktionen",
  readerUnread: "Ungelesen",

  /* Der Wall des verwalteten Accounts und seine Streifen — dieselben Sätze wie im Browser. */

  wallTitle: "Dieser Account ist nicht aktiv.",
  wallSuspendedTitle: "Dieser Account ist gesperrt.",
  wallTrialEnded: (date: string) => `Deine Testphase ist am ${date} abgelaufen.`,
  wallCanceled: (date: string) => `Dein Abo ist am ${date} ausgelaufen.`,
  wallUnpaid: (date: string) =>
    `Eine Zahlung ist fehlgeschlagen, und die Frist dafür ist am ${date} abgelaufen.`,
  wallStopped: "ohmail organisiert diesen Account nicht mehr.",
  wallMailboxUntouched: "Dein Postfach ist unberührt.",
  wallKept:
    "Deine Mails und Einstellungen bleiben. Es wurde nichts gelöscht, und deine Mails liegen ohnehin auf deinem eigenen Server.",
  wallErasure: (date: string) =>
    `Die Regeln, Screener-Entscheidungen und Einstellungen, die ohmail für dich speichert, werden am ${date} gelöscht. Deine Mails liegen in deinem Postfach und gehören nicht dazu.`,
  wallErasureHeld:
    "Ein Betreiber hält diesen Account; solange das gilt, wird nichts gelöscht. Schreib an support@ohmail.app, falls das unerwartet ist.",
  wallErasureUnknown:
    "Es wurde nichts gelöscht. Deine Mails liegen in deinem Postfach, und die zu löschen steht uns nicht zu.",
  wallSubscribe: "Abo abschliessen",
  wallOpenAccount: "Dein ohmail-Account öffnen",
  wallManage: "Abo verwalten",
  wallSubscribeHint: "Öffnet deine Account-Seite: Tarif wählen, bezahlen, zurück hierher.",
  wallMintFailed: "Die Account-Seite konnte gerade nicht geöffnet werden. Versuch es gleich noch einmal.",
  wallMintUnverified:
    "Die Account-Seite braucht eine bestätigte Adresse. Öffne den Link in der Mail, die wir bei der Registrierung geschickt haben.",
  wallChecking: "Stand deines Accounts wird geprüft …",
  wallPending:
    "Die Zahlung ist noch nicht bestätigt. Sobald das passiert, geht es hier weiter — du musst nichts tun.",
  wallCheckAgain: "Erneut prüfen",
  wallMoveOut: "Auf Selbsthosting umziehen",
  wallMoveOutHint:
    "Gibt deine Regeln, Screener-Entscheidungen und Einstellungen als eine Datei weiter, die deine eigene Installation liest, wenn sie dieses Postfach übernimmt.",
  wallMoveOutGuide: "Zur Anleitung fürs Selbsthosten",
  wallMoveOutFailed: "Die Datei konnte gerade nicht erstellt werden. Versuch es gleich noch einmal.",
  wallMoveOutBusy: "Die Datei wird vorbereitet…",
  wallDeleteNow: "Account jetzt löschen",
  wallDeleteElsewhere:
    "Zum Löschen deines Accounts brauchst du deinen zweiten Faktor. Das passiert auf deiner Account-Seite im Browser. Dein Postfach bleibt unberührt.",
  wallOpenInBrowser:
    "Öffne ohmail.app im Browser, um diesen Account zu verwalten oder zu löschen.",

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
  storageNoticeEmptied: (cap: string, count: number) =>
    `Damit die ${cap} GB deines Tarifs reichen, speichert ohmail den Text ${count === 1 ? "deiner ältesten Nachricht" : `deiner ${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ältesten Nachrichten`} nicht mehr.`,
  storageNoticeEmptiedBefore: (count: number) =>
    `Damit der Speicher deines Tarifs damals reichte, hat ohmail den Text ${count === 1 ? "deiner ältesten Nachricht" : `deiner ${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ältesten Nachrichten`} nicht mehr gespeichert.`,
  storageNoticeNotStored: (count: number) =>
    `Der Text ${count === 1 ? "einer Nachricht" : `von ${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} Nachrichten`} ist hier nicht gespeichert.`,
  storageNoticeKeptFrom: (month: string) => `Für Nachrichten ab ${month} bleibt der Text gespeichert.`,
  storageNoticeKeptFromExcept: (month: string, count: number) =>
    `Für Nachrichten ab ${month} bleibt der Text gespeichert, außer bei ${count === 1 ? "einer Nachricht, die ankam" : `${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} Nachrichten, die ankamen`}, als dein Speicher voll war.`,
  storageNoticeOnArrival: (count: number) =>
    count === 1
      ? "Eine Nachricht, die ankam, als dein Speicher voll war, ist ohne ihren Text gespeichert."
      : `${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} Nachrichten, die ankamen, als dein Speicher voll war, sind ohne ihren Text gespeichert.`,
  storageNoticeSafe: "Diese Nachrichten bleiben vollständig in deinem Postfach auf deinem Mailserver und bleiben hier gelistet und auffindbar.",
  storageNoticeNear:
    "Der Speicher ist fast voll. Ist er voll, speichert ohmail den Text deiner ältesten Nachrichten nicht mehr, um Platz für neue Mails zu machen. Diese Nachrichten bleiben vollständig in deinem Postfach auf deinem Mailserver.",
  storageNoticeFull:
    "Der Speicher ist voll. ohmail speichert den Text deiner ältesten Nachrichten nicht mehr, um Platz für neue Mails zu machen. Diese Nachrichten bleiben vollständig in deinem Postfach auf deinem Mailserver.",
  storageNoticeCarry: (date: string, limit: string, cap: string) =>
    `Bis zum ${date} speichert ohmail bis zu ${limit} GB Nachrichtentext. Danach umfasst dein Tarif ${cap} GB, und ohmail speichert den Text deiner ältesten Nachrichten darüber hinaus nicht mehr. Diese Nachrichten bleiben vollständig in deinem Postfach auf deinem Mailserver.`,
  storageNoticeCarryUnpaid: (limit: string, cap: string) =>
    `Bis 14 Tage nach deiner ersten Zahlung speichert ohmail bis zu ${limit} GB Nachrichtentext. Danach umfasst dein Tarif ${cap} GB, und ohmail speichert den Text deiner ältesten Nachrichten darüber hinaus nicht mehr. Diese Nachrichten bleiben vollständig in deinem Postfach auf deinem Mailserver.`,
  storageOfferTrial: "Ein größerer Tarif speichert ab jetzt mehr Text.",
  storageOfferTrialTop: "Sobald dein Abo bezahlt ist, speichert das Speicher-Add-on ab jetzt mehr Text.",
  storageOfferActive: "Ein größerer Tarif oder das Speicher-Add-on speichert ab jetzt mehr Text.",
  storageOfferActiveTop: "Das Speicher-Add-on speichert ab jetzt mehr Text.",
  storageNoticeNoRestore: "Bereits entfernten Text bringt das nicht zurück.",
  storageNoticeRefill:
    "Mit mehr Platz holt ohmail den Text entfernter Nachrichten von deinem Mailserver zurück, die neuesten zuerst, für die Postfächer, die es noch liest.",
  storageNoticeRefilling:
    "Es ist wieder Platz frei: Für die Postfächer, die ohmail noch liest, holt es den Text entfernter Nachrichten von deinem Mailserver zurück, die neuesten zuerst, soweit der Platz reicht.",
  storageNoticeManage: "Abo verwalten",
  storageNoticeDismiss: "Schließen",

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
  pfiSavedByPhone: (when: string) => `Gespeichert ${when} von ohmail auf einem Handy.`,
  pfiSavedBy: (when: string) => `Gespeichert ${when}.`,
  pfiWillDo:
    "Der Import fügt sie den Einstellungen dieses Accounts hinzu. Mails, die dieses ohmail im Screener zurückgehalten hat, werden für Absender, die sie aussortieren, dort abgelegt, wo sie es sagen; sonst ändert sich an deinen Mails nichts. Bis du dich entscheidest, bleiben beide im Postfach: diese Einstellungen neben denen, die du hier festlegst.",
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
  seedTitle: (n: number) => `Du hast ${n === 1 ? "1 Person" : `${n} Leuten`} geschrieben.`,
  seedLede:
    "Jemandem zu schreiben ist das deutlichste Zeichen, dass du eine Antwort willst. Alle unten angehakten kommen von jetzt an in deine Ohbox. Nimm den Haken weg bei allen, die du lieber screenen willst.",
  seedTruncated: (scanned: number) =>
    `Gelesen aus deinen ${scanned} neuesten gesendeten Nachrichten. Wem du davor geschrieben hast, landet weiter im Screener, wenn er sich wieder meldet.`,
  seedFilterPlaceholder: "Jemanden finden …",
  seedSelectShown: (n: number) => (n === 1 ? "Alle 1 angezeigte anhaken" : `Alle ${n} angezeigten anhaken`),
  seedDeselectShown: (n: number) => (n === 1 ? "Haken weg bei 1 angezeigten" : `Haken weg bei allen ${n} angezeigten`),
  seedWrote: (n: number) => (n === 1 ? "1 Nachricht" : `${n} Nachrichten`),
  seedAlreadyDecided: "schon entschieden",
  seedExcludedSummary: (n: number) => (n === 1 ? "1 Adresse wurde ausgelassen" : `${n} Adressen wurden ausgelassen`),
  seedExcludedRobot: "sieht nach einer Maschinenadresse aus",
  seedExcludedMachineSent: "in einer automatischen Antwort von dir gefunden",
  seedExcludedOwn: "eine deiner eigenen Adressen",
  seedWillDo: (n: number) =>
    `Das legt eine Regel für ${n === 1 ? "die 1 angehakte Person" : `die ${n} angehakten Personen`} an. Was von ihnen im Screener wartet, kommt in deine Ohbox; der Rest deiner Mails bleibt, wo dein Mailserver ihn hat.`,
  seedConfirm: (n: number) => `${n === 1 ? "1 Person" : `${n} Leute`} durchlassen`,
  seedConfirming: "Wird gespeichert …",
  seedLater: "Nicht jetzt",
  seedNothingToDecide: "In deinen gesendeten Mails wartet niemand auf eine Entscheidung.",
  seedClose: "Schließen",
  seedLoading: "Deine gesendeten Mails werden gelesen …",
  seedErrorTitle: "Das hat nicht funktioniert.",
  seedErrorGeneric: "Beim Lesen deiner gesendeten Mails ist etwas schiefgegangen.",
  seedErrorRetry: "Deine Haken sind noch da. Drück einfach nochmal auf den Button.",
  seedSettingsLabel: "Leute, denen du schreibst",
  seedReopenBody:
    "Schau nochmal auf die Leute, denen du geschrieben hast, und entscheide, wer durchkommt. Wen du schon entschieden hast, bleibt wie er ist; das hier nimmt nur Leute dazu, für die du noch nicht geantwortet hast — und genau die bringt ein neu verbundenes Postfach mit.",
  seedReopenAction: "Ansehen",
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
