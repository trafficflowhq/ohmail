/**
 * Der Kopie-Satz des Telefons auf Deutsch — the phone's copy deck, in German.
 *
 * ── WHAT THIS FILE IS HELD TO ─────────────────────────────────────────────────────────────────
 *
 * `Deck` is derived from the English table in `copy.en.ts`, so this file is checked on shape by the
 * compiler: a key that is missing, a key that does not exist over there, and a function whose
 * parameter list differs are all build errors rather than blank text on a phone.
 * `test/copy-parity.test.ts` adds what a type cannot see — a sentence left in English, an
 * interpolation dropped from a template, a plural that ignores the number it was handed.
 *
 * ── THE VOCABULARY IS NOT INVENTED HERE ───────────────────────────────────────────────────────
 *
 * The web client has spoken German for several releases and `apps/webapp/messages/de.json` is where
 * that vocabulary was settled. Every term this deck shares with it is taken from there rather than
 * translated again: **Ohbox**, **Reads**, **Screener**, **Spam**, **Tag**, **paper** and
 * **ohmarchy** stay as they are; Receipts is **Belege**, screened out is **aussortiert**, Answer
 * Later is **„Später antworten“**, Park is **Parken** / **Geparkt**, Resurface is **wieder
 * auftauchen**, a first-time sender is an **Erstabsender**, Trash is the **Papierkorb**, and a mail
 * server is a **Mailserver**. A person who reads ohmail on a laptop and then opens it on their
 * phone must not meet a second set of words for the same six places.
 *
 * Where the phone shares a whole SENTENCE with the web client — the folder verbs, the Look block,
 * the message actions, the send-later presets, the tag note — this deck carries the web client's
 * German byte for byte, and `test/copy-parity.test.ts` holds the equality the same way
 * `folders-parity.test.ts` and `ohmarchy-face.test.ts` hold the English one.
 *
 * ── REGISTER ──────────────────────────────────────────────────────────────────────────────────
 *
 * **Du**, never Sie — the catalogue's own choice throughout. Plain statements of what the app did
 * or refused, no reassurance and no slogans: Blanc's rule from the English deck applies unchanged,
 * and a translation is the easiest place in a product to smuggle in a promise the code does not
 * keep. Where German is longer than English it is shortened rather than allowed to wrap a button —
 * the phone's smallest supported width is 360 px, which is roughly 26 characters on a control.
 *
 * ── PLURALS ───────────────────────────────────────────────────────────────────────────────────
 *
 * German has the same two plural categories as English, so every count sentence keeps the shape it
 * has over there — a ternary on the number, not an ICU message. What changes is that German
 * inflects the noun rather than adding a letter to it (`1 Nachricht` / `2 Nachrichten`), so the
 * branch carries the whole noun phrase instead of a suffix.
 */

import { isPinFailure } from "./net/host-pinning";
import type { Deck } from "./copy.en";

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
    "Diese App ist der Telefon-Client für einen ohmail-Server — unseren, einen den du selbst betreibst, oder die ohmail-App auf deinem eigenen Computer. Sie zeigt nichts, bis sie verbunden ist: Deine Post bleibt auf deinem Server, und dieses Telefon spiegelt sie.",
  welcomeHow:
    "Was du auch wählst — das Telefon koppelt sich, indem es einen Code scannt, den dieser Server dir zeigt. Hier wird nie ein Passwort eingetippt.",

  /* ------------------------------------------------------------------ doors */

  doorsLead: "Eine Frage, drei Antworten — welcher Rechner organisiert?",

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

  doorsTravel:
    "Du kannst jederzeit wechseln. Deine aussortierten Absender, deine Regeln und deine Benachrichtigungs­einstellungen liegen in deinem eigenen Postfach und sind hinter jeder Tür dieselben — das Postfach ist immer das Original. Dieses Telefon hält davon immer nur eine Kopie.",

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

  /* --------------------------------------------------- servers & pairing */

  serversTitle: "Server",
  serversRow: "Mit einem Server verbinden",
  serversNote:
    "Koppele dieses Telefon mit dem Computer oder Server, auf dem deine Post liegt. Gekoppelt wird über einen QR-Code oder einen kurzlebigen Token — nie über ein hier eingetipptes Passwort.",
  serversActive: "Verbunden",
  serversProfiles: "Gekoppelte Server",
  serversAdd: "Server hinzufügen",
  serversNeedsPair: "Die Kopplung ist beendet — scanne einen frischen QR-Code, um erneut zu koppeln.",
  serversForget: "Vergessen",
  serversForgetNote:
    "Vergessen löscht die Kopplung und die Post, die dieses Telefon kopiert hatte. Über die Geräteliste des Servers lässt sie sich auch dort widerrufen.",
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
  unreachable: (detail: string) => `Diese Adresse war nicht erreichbar. ${detail}`,

  scanTitle: "Kopplungs-QR scannen",
  scanHint: "Richte die Kamera auf den QR-Code, den dein Computer oder Server zeigt.",
  scanBadCode: "Kein ohmail-Kopplungscode. Der QR-Code steht auf dem Bildschirm „Geräte“.",
  scanCameraOff: "Der Kamerazugriff ist aus, es gibt also nichts zum Scannen.",
  scanAllow: "Kamera erlauben",
  scanManual: "Stattdessen von Hand eingeben",
  scanAgain: "Erneut scannen",

  staleAsOf: (time: string) => `Stand ${time} · wird nachgeholt`,
  staleAsOfIdle: (time: string) => `Stand ${time}`,

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
  connectRefusedTitle: "Abgelehnt",
  connectSyncing: "Wird synchronisiert…",
  connectSyncNow: "Jetzt synchronisieren",
  connectDisconnect: "Trennen",
  connectMirrored: (n: number, cursor: string) =>
    `${n === 1 ? "1 Nachricht" : `${n} Nachrichten`} auf diesem Gerät · Cursor ${cursor}`,
  pinChanged: PIN_CHANGED,
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

  pairBadAddress: (origin: string) => `keine Serveradresse: „${origin}“`,
  pairEmptyToken: "der Kopplungscode ist leer",
  helloStatus: (status: number) => `der Server hat mit ${status} geantwortet`,
  pairUnreachable: (detail: string) => `dieser Server war nicht erreichbar — ${detail}`,
  pairNotOhmail: "diese Adresse antwortet, aber nicht als ohmail-Server",
  pairManagedDeferred: "ohmail.app bietet gerade keine Gerätekopplung an — das sagt seine eigene Beschreibung",
  pairNoPairing: "dieser Server bietet keine Gerätekopplung an",
  pairNotStoredClosed: (detail: string) =>
    `dieses Telefon konnte die Kopplung nicht speichern (${detail}) — die Sitzung wurde geschlossen; erzeuge einen frischen Code und versuch es nochmal`,
  pairNotStoredOpen: (detail: string) =>
    `dieses Telefon konnte die Kopplung nicht speichern (${detail}), und der Server war nicht `
    + "erreichbar, um die gerade geöffnete Sitzung zu schließen — widerrufe dieses Gerät in "
    + "seiner Geräteliste, erzeuge dann einen frischen Code und versuch es nochmal",
  pairEndedRefused: "diese Kopplung ist beendet — der Server hat ihren Token abgelehnt. Scanne einen frischen QR-Code, um erneut zu koppeln",
  pairRedeemUnreachable: "dieser Server war nicht erreichbar, um die Kopplung einzulösen",
  pairCodeRejected: "dieser Kopplungscode wurde nicht angenommen — erzeuge einen frischen und scanne erneut",
  pairNoAccountName:
    "gekoppelt, aber der Server konnte das Konto nicht benennen, das diese Kopplung öffnet — "
    + "erzeuge einen frischen Code und koppele erneut, sobald es Post hält",
  pairOwedDeletion: (detail: string) =>
    "Dieses Telefon schuldet für die kopierte Post dieses Postfachs noch eine Löschung und konnte "
    + `sie nicht ausführen (${detail}). Starte ohmail neu, damit es das abschließen kann, und `
    + "koppele dann mit einem frischen Code erneut.",
  pairEndedOnServer: "diese Kopplung wurde auf dem Server beendet — scanne einen frischen QR-Code, um erneut zu koppeln",
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
  forgetServerUnreachable:
    "Die Kopplung und die Post, die dieses Telefon kopiert hatte, sind weg. Der Server war nicht "
    + "erreichbar, um die Sitzung zu beenden, und zählt dieses Telefon womöglich noch als "
    + "verbunden — widerrufe dieses Gerät in seiner Geräteliste, um das abzuschließen.",
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
  groupSeen: "Älter",
  metaUnreadOf: (unread: number, total: number) => `${unread} ungelesen von ${total}`,
  metaNew: (n: number) => `${n} neu`,
  metaWaiting: (n: number) =>
    `${n} ${n === 1 ? "Erstabsender wartet" : "Erstabsender warten"}`,
  metaItems: (n: number) => `${n} ${n === 1 ? "Eintrag" : "Einträge"}`,
  mailRowAria: (from: string, subject: string, time: string, unread: boolean) =>
    `${from}. ${subject}. ${time}.${unread ? " Ungelesen." : ""}`,
  senderRowAria: (name: string, address: string, held: number) =>
    `${name}, ${address}, ${held} zurückgehalten`,
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
  /*
   * THE VERB LIVES ON THIS SIDE IN GERMAN, AND IT HAS TO.
   *
   * The doorbell is drawn as two pieces — the count, then a quieter tail — and `chrome.tsx`
   * renders them from two separate keys, so the tail cannot see the number. English gets away
   * with that because "waiting" does not inflect. German does not: "357 neue Absender wartet" is
   * what an invariant tail produces, and it was on screen.
   *
   * So the verb moves into the half that HAS the count, and the tail becomes a phrase with no
   * verb in it to disagree — the same information, split where German can carry it. The web
   * client makes the same choice inside one ICU message (`ohbox.doorbell`: "1 wartet" / "# warten").
   * `test/copy-parity.test.ts` holds the agreement.
   */
  doorbell: (n: number) => `${n} ${n === 1 ? "neuer Absender wartet" : "neue Absender warten"}`,
  doorbellRest: "im Screener",
  doorbellGo: "Screener",

  /* --------------------------------------------------------- reads/receipts */

  reads: "Reads",
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
  screenedEmptyTitle: "Niemand aussortiert.",
  screenedEmptyHint: "Absender, zu denen du Nein sagst, warten hier — zurückgehalten, nie gelöscht.",
  spamEmptyTitle: "Kein Spam zurückgehalten.",
  spamEmptyHint:
    "Vermuteter Spam wartet hier auf deinen Blick — von sich aus löscht ohmail ihn nie. Post, die du als Spam bestätigst, wandert in den eigenen Junk-Ordner deines Mailservers, oder bleibt hier zurückgehalten, wenn dein Postfach keinen hat.",

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
      case "index_not_removed": return "der Schlüsselspeicher wollte die Kopplungsliste nicht entfernen";
      default: return code;
    }
  },

  verbatimDetail: (detail: string) => detail,

  /* --------------------------------------------------------------- folders */

  folders: "Ordner",
  folderEmpty: "Noch keine Ordner auf deinem Mailserver.",
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

  folderNew: "Neuer Ordner",
  folderNewSub: "Neuer Unterordner",
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
  switchOff: "Aus",
  switchOn: "An",

  /* ---------------------------------------------------------------- search */

  search: "Suche",
  searchLater: "Kommt mit einem späteren Update",

  /* -------------------------------------------------------------- settings */

  settings: "Einstellungen",
  theme: "Erscheinungsbild",
  themeNote: "Folgt dem System, solange du nichts wählst.",
  themeSystem: "System",
  themeLight: "Hell",
  themeDark: "Dunkel",

  language: "Sprache",
  languageNote: "Folgt diesem Telefon, solange du nichts wählst. Gilt für ohmail auf diesem Gerät.",
  /* Identisch zum englischen Deck, mit Absicht — siehe dort. */
  languageSystem: "System",
  languageEnglish: "English",
  languageGerman: "Deutsch",
  languageFailed: "Das ließ sich nicht speichern — versuch es nochmal.",

  face: "Look",
  faceHint: "ohmarchy — ein Tiling-Look, tastaturzentriert, inspiriert von Omarchy.",
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
  aboutLive: (origin: string) =>
    `Gekoppelt mit ${origin}. Post wird in einen Spiegel auf dem Gerät synchronisiert; Lesen, Sortieren, Antworten, Weiterleiten und Tags sind live. Neue Nachrichten schreiben und die Suche kommen mit späteren Updates.`,
  aboutOnDevice:
    "Einen Server zu vergessen löscht seine Kopplung und die Post, die dieses Telefon kopiert "
    + "hatte. Die App zu löschen nimmt die kopierte Post mit; auf iPhone und iPad bleibt die "
    + "Kopplung im Schlüsselbund des Telefons, bis ohmail wieder geöffnet wird — dann wird sie "
    + "verworfen, bevor irgendetwas geöffnet wird, und wenn das nicht gelingt, wird gar nichts "
    + "geöffnet. Um sie sofort zu beenden, widerrufe dieses Gerät in der Geräteliste des Servers. "
    + "Die Kopplung ist nie in einem Backup enthalten. Auf iPhone und iPad ist die kopierte Post "
    + "es: Sie liegt in den Dokumenten dieser App, und die Cloud- und Computer-Backups des "
    + "Telefons schließen sie ein. Auf Android ist sie aus beiden ausgenommen.",

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
  liveSaveFailed: "Diese Änderung ließ sich nicht speichern. Versuch es nochmal.",
  liveDecided: (dest: string, target: string) =>
    `${dest} — künftige Post von ${target} wird automatisch dorthin einsortiert.`,
  liveDecidedElsewhere: (name: string, target: string) =>
    `Entschieden — ${name} sortiert ${target} beim nächsten Durchlauf ein.`,
  liveDecidedElsewhereUnknown: (target: string) =>
    `Entschieden — die Installation, die dieses Postfach organisiert, sortiert ${target} beim nächsten Durchlauf ein.`,
  liveDecideFailed: (sender: string) =>
    `Diese Entscheidung ließ sich nicht speichern — ${sender} wartet weiter.`,
  /*
   * ── THE DESTINATION LEADS, BECAUSE GERMAN CANNOT TAKE IT AFTER A PREPOSITION ────────────────
   *
   * The English is "Released 3 held messages to Reads". Translated literally that is "… nach
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
  liveReleaseFailed: (sender: string) =>
    `Diese Freigabe ließ sich nicht speichern — Post von ${sender} liegt, wo sie lag.`,
  livePileAdded: (title: string) => `${title} — hinzugefügt.`,
  livePileFailed: (title: string) => `${title} — ließ sich nicht speichern. Versuch es nochmal.`,
  liveBodyLoading: "Die ganze Nachricht wird geladen…",
  liveBodyFailed: "Nur die Vorschau ließ sich laden. Öffne sie erneut, um es nochmal zu versuchen.",
  liveBodyWithheld:
    "Nicht gespeichert — dein Speicherplatz war voll, als sie ankam. Das hier ist die Vorschau; die Nachricht selbst liegt sicher in deinem Postfach auf deinem Mailserver.",

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
  actionScreening: "Screening",
  actionMove: "Verschieben",
  actionMarkRead: "Als gelesen markieren",
  actionMarkUnread: "Als ungelesen markieren",
  actionDone: "Erledigt",
  actionMore: "Mehr",
  tabMore: "Mehr",

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
  placeReads: "Reads",
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
  toastResurfaceDone: "Erledigt — unter „Älter“ abgelegt",
  /*
   * CASE-NEUTRAL, and this one diverges from the web client's German ON PURPOSE.
   *
   * "Nach Belege verschoben." is wrong — "nach" wants a case the place name cannot carry, and the
   * places have gender and number ("die Belege", "die Ohbox"). The web catalogue says the same
   * thing (`ohbox.toastMoved`), and matching it was the argument for leaving this alone. That
   * argument does not survive review: a matching translation on another surface is evidence of a
   * SHARED DEFECT, not evidence that the sentence is correct. The colon takes no case, so this
   * reads for every destination. The web client's twin is filed to be fixed the same way.
   */
  toastMoved: (place: string) => `Verschoben: ${place}.`,

  replyTo: (name: string) => `Antwort an ${name}`,
  replyToAll: (names: string) => `Antwort an ${names}`,
  replyCcLine: (names: string) => `Kopie an ${names}`,
  replyPlaceholder: "Schreib deine Antwort …",
  replySend: "Senden",
  replyCancel: "Abbrechen",
  replySending: "Wird gesendet …",
  replySent: "Antwort gesendet.",
  replyQueued: "Noch nicht gesendet. ohmail versucht es weiter.",
  replyUnverified: "Wir konnten diesen Versand nicht bestätigen. Schau in deinen Gesendet-Ordner, bevor du nochmal sendest.",
  replyFailed: "Senden hat nicht geklappt. Versuch es nochmal.",
  forwardHead: "Weiterleiten — du wählst, wer sie bekommt",
  forwardTo: "An",
  forwardToPlaceholder: "name@beispiel.de, …",
  forwardNotePlaceholder: "Notiz hinzufügen (optional)",
  forwarded: "Weitergeleitet.",

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


  screenerNothingDeleted: "Es wurde nichts gelöscht. Jede zurückgehaltene Nachricht ist einen Tipp entfernt, vollständig.",
  folderGone: "Diesen Ordner gibt es hier nicht mehr.",
  messageGone: "Diese Nachricht gibt es hier nicht mehr.",
  senderGone: "Dieser Absender steht nicht mehr im Screener.",
  senderFirstContact:
    "Erster Kontakt. Von diesem Absender hat es noch nichts in die Ohbox geschafft — es hat hier gewartet.",
  senderAiSuggestion: (dest: string, confidence: string, reason: string): string =>
    `Die KI schlägt ${dest} vor, mit ${confidence}: „${reason}“`,

  bootBadOrigin: (origin: string) => `keine Server-Adresse: „${origin}“`,
  bootBadApiBase: (base: string) => `keine API-Adresse des Servers: „${base}“`,
  bootApiBaseOffOrigin: (base: string, origin: string) =>
    `die API-Adresse dieses Servers, „${base}“, liegt nicht auf der gekoppelten Adresse „${origin}“ — `
    + "koppele diesen Server erneut, damit sie erfasst wird",
  bootNeedsCredential: "eine Anmeldung und eine Konto-Kennung werden beide gebraucht",
  bootAccountMismatch: (serverSays: string, expected: string) =>
    `diese Anmeldung gehört zum Konto „${serverSays}“, nicht zu „${expected}“ — prüfe die eingegebene Konto-Kennung`,
  bootMirrorFailed: (detail: string) => `der Spiegel auf dem Gerät ließ sich nicht öffnen: ${detail}`,
  installMarkerUnopenable: (detail: string) =>
    `die Installationsmarke ließ sich nicht öffnen: ${detail}`,
  installPurgeFailed: (detail: string) =>
    `die Kopplungen der alten Installation ließen sich nicht entfernen: ${detail}`,
  installMarkerUnreadable: (detail: string) => `die Installationsmarke ließ sich nicht lesen: ${detail}`,
  connectSuperseded: "ein neuerer Verbindungsversuch hat übernommen.",

  /* "geht nach" + a place name has the same case problem; the web client's own heading for this
     pane asks the question instead (`screening.sectionWhere`: "Wohin ihre Post geht"). */
  screeningFor: (sender: string) => `Wohin die Post von ${sender} geht`,
  screeningNote: (target: string) =>
    `Wird zur Regel — künftige Post von ${target} wird automatisch dorthin einsortiert, und was schon hier ist, wird verschoben.`,
};
