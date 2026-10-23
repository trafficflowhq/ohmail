# Connect a Gmail mailbox

Gmail does not accept your Google password from mail apps. ohmail connects to
Gmail over IMAP with an **App Password**, a separate 16-letter password you
create for ohmail and can revoke at any time.

1. **Turn on 2-Step Verification.** Google only offers App Passwords once it is
   on: Google Account → Security → 2-Step Verification
   ([myaccount.google.com/signinoptions/twosv](https://myaccount.google.com/signinoptions/twosv)).
2. **Create an App Password** at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
   Give it any name, for example `ohmail`. Google shows 16 letters.
3. **In ohmail**, choose Gmail, enter your Gmail address, and paste the 16
   letters as the password (without the spaces), not your Google password.

The same works for Google Workspace on your own domain: choose Gmail and use
your full work address.

## If it does not connect

- **"App Passwords" says it is not available for your account.** 2-Step
  Verification is off, or your account does not allow App Passwords: a work or
  school account whose administrator turned them off, Advanced Protection, or an
  account that signs in with security keys only. Ask your administrator, or
  connect another mailbox: ohmail cannot connect those accounts yet.
- **It worked before and now the password is refused.** Changing your Google
  password revokes every App Password. Create a new one and use Sign in again.
- **Google asks you to sign in on the web.** Sign in to Gmail in a browser once,
  then try again.
- **Workspace: IMAP is turned off.** Your administrator can turn IMAP on in the
  Google Admin console.

## Server settings

ohmail fills these in when you choose Gmail. For a manual setup:

| | Server | Port | Security |
|---|---|---|---|
| Incoming (IMAP) | `imap.gmail.com` | 993 | SSL/TLS |
| Outgoing (SMTP) | `smtp.gmail.com` | 465 | SSL/TLS |

The username is your full Gmail address.
