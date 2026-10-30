### Undo takes back every letter of a conversation

On Android and iOS, Undo now takes back every letter of a conversation after Later, Park, Resurface or Done.
An Undo pressed while the conversation's letters were still being sent could leave some of them filed, so the
conversation showed up in Parked again and stayed there after the app was restarted. A press on one of its
letters made in that moment now also lands after the conversation's own, and a press on an open message no
longer waits while the phone saves that you have read it.

On every app, Mark unread on a message you had just opened, while the app was still saving that you read it,
now stays: when that save failed and was sent again, after a server error or a dropped connection, it marked
the message read again.

On the web and desktop apps, Undo after a press on a whole conversation or a selection now also takes back a
letter whose save was still being retried after a failed attempt; that letter used to stay where the press put it.
When every save of such a press failed for a moment, it said nothing had changed and offered no Undo, while the
letters stayed where it put them; it now says what it did, counts the letters still being saved and offers Undo.
