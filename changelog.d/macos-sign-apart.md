### Contributors: the Mac build no longer runs beside the signing identity

The macOS build job holds no Apple secret. Signing, notarizing and stapling the app and its disk image move to a separate job that runs no checkout, npm or cargo and takes the build by the ID its upload returned, so no other job of the run can swap what it signs. It signs only once the Apple signing secrets are set up, and they are not yet: the Mac app is still not Developer ID signed or notarized, and the Mac downloads stay the build's own ad-hoc app, byte for byte.
