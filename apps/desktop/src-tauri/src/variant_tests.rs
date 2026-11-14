use super::*;

/// The identifier of the released app, as `tauri.conf.json` writes it.
const RELEASED_IDENTIFIER: &str = "io.ohmail.desktop";

#[test]
fn the_identifier_and_the_feature_must_name_the_same_variant() {
    // The two builds that exist.
    assert_eq!(variant_agrees(RELEASED_IDENTIFIER, false), Ok(()));
    assert_eq!(variant_agrees(PREVIEW_IDENTIFIER, true), Ok(()));
    // The released identifier under a preview's code: the store that must never be opened.
    let wrong_folder = variant_agrees(RELEASED_IDENTIFIER, true).unwrap_err();
    assert!(wrong_folder.contains(RELEASED_IDENTIFIER), "{wrong_folder}");
    // The preview's identifier without the feature: the released app's keystore item.
    assert!(variant_agrees(PREVIEW_IDENTIFIER, false).is_err());
    // Every other released identifier (the store's, the Flatpak's) is refused under the feature too.
    assert!(variant_agrees("app.ohmail", true).is_err());
    assert!(variant_agrees("app.ohmail.Desktop", true).is_err());
    assert_eq!(variant_agrees("app.ohmail.Desktop", false), Ok(()));
}

#[test]
fn the_preview_identifier_shares_no_folder_with_the_released_one() {
    // A folder is named by the identifier. Neither may be the other, nor begin with it: a prefix
    // match over one would then reach the other.
    assert_ne!(PREVIEW_IDENTIFIER, RELEASED_IDENTIFIER);
    assert!(!PREVIEW_IDENTIFIER.starts_with(RELEASED_IDENTIFIER));
    assert!(!RELEASED_IDENTIFIER.starts_with(PREVIEW_IDENTIFIER));
}
