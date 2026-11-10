### Cloud keeps a closed account closed while the billing service does not answer

On ohmail Cloud, a worker that started while the billing service was not answering read every account as
open. For an account whose subscription had ended, it cleared the closure, asked to organize its mailboxes
again and signed in to them. The closure the worker stored now stands until the billing service answers
again, and it is stored as well for a mailbox whose last sync had stopped because its mail server asked
ohmail to wait or sent more than one pass can take. A paying account keeps syncing through such an outage
as before. The app still opens during one, and reopens a closed account only once the billing service has
answered.
