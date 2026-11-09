### Phone: background organizing stops cleanly at Android's time limit

On Android 15 and later the system lets a data-sync service run for six hours a day while the app is in the background. When that limit is reached, ohmail now ends background organizing, takes its notification down and hands the mailbox back right away, so your other devices can organize it, instead of Android stopping the app. Opening ohmail resumes organizing. The Android app also no longer declares the "display over other apps", microphone and storage permissions, which it never used.
