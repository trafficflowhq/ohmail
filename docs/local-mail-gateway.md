# Local mail gateway

A local mail gateway is a program on your own computer that speaks IMAP to
ohmail and something else to your mail provider. DavMail is one: it presents a
Microsoft 365 or Exchange mailbox as IMAP, which helps where an organization
allows neither IMAP nor app passwords. The ohmail desktop app can add a
mailbox through one. This page says what the app does with such a server, what
to set up, and what has and has not been measured.

## What the desktop app does

- **A server on this computer** means an IMAP host of `127.0.0.1` (any address
  in `127.0.0.0/8`), `::1`, or `localhost` — and `localhost` is always dialled
  at `127.0.0.1`, whatever a name server says about it. The app connects to
  such a server without TLS, and gives it up to two minutes to answer the
  sign-in on Test connection, Connect and Sign in again. A gateway that holds
  the sign-in while you complete its own sign-in somewhere else gets that time.
  A name such as `davmail.localhost` is an ordinary name: it gets the
  encryption check and the 20-second check like any remote server, as does an
  address on your own network (`192.168.x.x`, `10.x.x.x`).
- **While it waits**, the form says it is asking the server on this computer.
  Test connection and Sign in again stay disabled until that request answers,
  even if you edit a field or leave setup and open it again meanwhile, so a
  second press never sends the gateway a second sign-in while the first is
  held.
- **A refusal of the incoming (IMAP) sign-in** from a server on this computer
  is reported as that server's refusal, with its own window or log as the
  place to look, not as a wrong password; a refusal from the outgoing (SMTP)
  server keeps its ordinary sentence. When the server does not answer in time,
  the app says that instead.
- **After the mailbox is added**, a refused sign-in stops syncing until you
  choose Sign in again: retrying on its own would run the gateway's sign-in
  over and over. A server on this computer that does not answer in time is
  retried on its own, and each try can make the gateway ask you to sign in
  again — use its newest request.
- **Folders.** On a server that greets as DavMail, ohmail creates `ohmail`
  before the folders under it (`ohmail/Screener`, `ohmail/_meta` and the rest),
  because DavMail does not create a missing parent. Other servers are asked for
  the folders alone, as before.
- **Removing messages.** DavMail 7.0.0 announces UIDPLUS but never answers
  `UID EXPUNGE`. On a server that greets as DavMail, ohmail removes its own
  records in `ohmail/_meta` with a plain `EXPUNGE`; in every other folder,
  `ohmail/Screener` and the rest of `ohmail/` included, it only marks the
  message deleted. With DavMail's `davmail.imapAutoExpunge` on (its default),
  DavMail removes the marked message at once — together with any other message
  in that folder already marked deleted, which is how DavMail's auto-expunge
  works for every client. With it off, the message stays in its folder, marked
  deleted.

## Setting it up

1. Use the gateway account's own username in ohmail. DavMail refuses a sign-in
   whose username is not the Microsoft account's.
2. Use the same username and password for incoming (IMAP) and outgoing (SMTP)
   mail. DavMail answers the outgoing server from the session the incoming
   sign-in opened; a different pair makes it ask for a second sign-in, which
   the outgoing check does not wait for.
3. Type `127.0.0.1` or `localhost` as the server, not a `.localhost` name.
4. When the gateway asks you to sign in — DavMail prints a link and waits for
   the code, or opens a window — finish that within two minutes of pressing
   Test connection.
5. DavMail: keep `davmail.oauth.persistToken` on (the default), so it keeps the
   session across restarts and does not ask again. Keep
   `davmail.imapAutoExpunge` on as well.

DavMail's default ports: IMAP host `localhost`, port `1143`; SMTP host
`localhost`, port `1025`.

## Self-hosted ohmail

A self-hosted server does not wait for a gateway: its check keeps the
20-second limit and its ordinary sentences. A gateway works with it as a
service on the same Docker network, not on the server's own loopback: the api
and the organizer are separate containers, so a gateway one of them reaches as
`127.0.0.1` the other cannot, and the mailbox would add and never sync. For
DavMail:

- run it with `davmail.server=true` and `davmail.mode=O365DeviceCode`, its
  properties file on a volume so the session survives a restart;
- set `TF_PROBE_ALLOW_PRIVATE=1` on both the api and the organizer, and accept
  the no-encryption line for its private address;
- complete DavMail's device-code sign-in in its log before pressing Test
  connection — the server's check waits 20 seconds, and DavMail answers from
  the session it then keeps.

With TLS instead: give DavMail a keystore (`davmail.ssl.keystoreFile`) and put
that certificate's authority in `NODE_EXTRA_CA_CERTS` on both services.

## What has been measured

- The desktop engine's Test against DavMail 7.0.0 in its manual sign-in mode
  (`davmail.mode=O365Manual`), with no Microsoft account: with nobody completing
  the sign-in, the check ends after two minutes with the local-server sentence;
  a code entered 40 seconds in still reaches the check, and a wrong one gets the
  local refusal, never the app-password advice. Its outgoing server holds an
  AUTH that no incoming sign-in has opened a session for.
- Through a front that holds the sign-in reply: 30, 60 and 90 seconds pass on
  this computer, for Test connection and for Sign in again; a longer hold ends
  at the two-minute bound; an address on a private network keeps the 20-second
  check, and a gateway that answers the second sign-in at once passes on the
  second Test.
- A name under `.localhost` pointed at another address is refused before any
  sign-in is sent, and `localhost` reaches `127.0.0.1` when a name server
  answers otherwise.
- The organizer against a server answering as DavMail 7.0.0 does (UIDVALIDITY
  1, no COPYUID, a folder refused without its parent, `UID EXPUNGE` never
  answered, with and without INTERNALDATE): it takes the mailbox, creates its
  folders, files mail, renews its claim and starts again where it left off.
  When it removes a duplicate in `ohmail/Screener`, it does not expunge a
  message another client marked deleted there. With no INTERNALDATE at all,
  two desktop installs never organized the same mailbox at once, across
  several renewals and a takeover.

## What has not been measured

ohmail's organizer against a real Microsoft 365 mailbox through DavMail —
EWS CreateFolder/MoveItem semantics, whether Exchange assigns `imapUid` and an
INTERNALDATE to an EWS-created claim (without one, ohmail cannot check this
computer's clock against the server's; it organizes and logs that), DavMail's
folder-tree LIST time on a large mailbox inside the remaining budget, and the
tenant's EWS/Graph policy (Microsoft is retiring EWS for Exchange Online;
DavMail 7's Graph mode was not run).
