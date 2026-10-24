### A slow send keeps its Sent copy, and a dropped upload says it was not sent

A send whose mail server took a long time to accept it was delivered but could lose its copy in Sent: the copy went over the mail connection opened before the send, which had timed out by then. The copy is now filed after the server accepts the message, on a fresh connection when the first one has died, and every retry looks in Sent first, so there is exactly one copy. Cloud files it before it answers; the desktop app, the phone and your own server answer at once and keep trying in the background.

When the connection drops while the message is still uploading, ohmail now knows the message was not sent and says so ("the connection dropped before the whole message reached your mail server"), and the draft is a draft again. Before, this read as "We couldn't confirm this send". Only a drop in the last moment, once every byte has left your device and before the server answers, still asks you to check Sent. A recipient the server refuses is named the same way.

A slow upload is no longer checked while it is still running: its draft stays "sending" until the server answers, instead of turning "We couldn't confirm" after ten minutes and being sent a second time by Send again. On Cloud, several letters scheduled for the same minute no longer run past the time a scheduled pass is given; the ones it cannot finish go out on the next pass.

On the phone and the desktop app, a large attachment on a slow link no longer times out while it is still uploading: the phone hands the network at most 16 KiB at a time, and the local send waits up to two minutes for the server instead of 25 seconds.
