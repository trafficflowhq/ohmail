/**
 * The pickers' NATIVE half — expo-document-picker + expo-image-picker in a `*-native.ts` twin
 * the suite never imports (the standing rule: Expo packages ship Flow-typed JS the node
 * toolchain cannot parse). Every rule lives in `attach.ts`; this file turns platform assets
 * into `PhoneComposeAttachment`s and has no decision of its own beyond "could the bytes be
 * read". Bytes come from the picker where it hands them (`base64: true`) and from
 * expo-file-system's `File` otherwise; a file whose bytes cannot be read is COUNTED and said
 * (`attachUnreadable`), never silently dropped.
 */
import { Buffer } from "buffer";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import {
  base64SizeBytes,
  shrinkBox,
  type AttachPicker,
  type AttachPickOutcome,
  type ImageShrink,
  type PhoneComposeAttachment,
} from "./attach";

/** The route's own fallbacks, mirrored — a nameless pick is still a file somebody chose. */
const FALLBACK_NAME = "attachment";
const FALLBACK_TYPE = "application/octet-stream";

async function fileBase64(uri: string): Promise<string | null> {
  try {
    // `File.arrayBuffer()` is the read this SDK offers (no `base64()`); Buffer is already the
    // app's encoder (`mail/blob-base64.ts`, the polyfill's reason).
    const bytes = await new File(uri).arrayBuffer();
    return Buffer.from(new Uint8Array(bytes)).toString("base64");
  } catch {
    return null;
  }
}

function toAttachment(
  base64: string,
  name: string | null | undefined,
  mime: string | null | undefined,
  uri: string,
): PhoneComposeAttachment {
  return {
    filename: typeof name === "string" && name !== "" ? name : FALLBACK_NAME,
    contentType: typeof mime === "string" && mime !== "" ? mime : FALLBACK_TYPE,
    contentBase64: base64,
    sizeBytes: base64SizeBytes(base64),
    uri,
  };
}

/**
 * THE SHRINK, over expo-image-manipulator — `attach.ts#shrinkPicked` decides whether to use it.
 * Rendered once to read the picture's own dimensions (after its orientation), fitted by the
 * web's rule (`shrinkBox`), re-encoded in the picture's own format. Any failure is `null`: the picked
 * bytes attach as they were.
 */
export const nativeImageShrink: ImageShrink = async (uri, type, rule) => {
  try {
    const source = await ImageManipulator.manipulate(uri).renderAsync();
    const box = shrinkBox(source.width, source.height, rule);
    const context = ImageManipulator.manipulate(source);
    if (box.width !== source.width || box.height !== source.height) context.resize(box);
    const fitted = await context.renderAsync();
    const saved = await fitted.saveAsync({
      base64: true,
      format: type === "image/png" ? SaveFormat.PNG : SaveFormat.JPEG,
      compress: rule.quality,
    });
    return typeof saved.base64 === "string" && saved.base64.length > 0 ? saved.base64 : null;
  } catch {
    return null;
  }
};

export function nativeAttachPicker(): AttachPicker {
  return {
    async pickFiles(): Promise<AttachPickOutcome> {
      let result: DocumentPicker.DocumentPickerResult;
      try {
        result = await DocumentPicker.getDocumentAsync({
          multiple: true,
          // The bytes are read right here and the copy is system-evictable cache; without it an
          // Android provider URI can expire before the send leaves.
          copyToCacheDirectory: true,
        });
      } catch {
        return { kind: "unavailable" };
      }
      if (result.canceled) return { kind: "cancelled" };
      const files: PhoneComposeAttachment[] = [];
      let unreadable = 0;
      for (const asset of result.assets ?? []) {
        const base64 = await fileBase64(asset.uri);
        if (base64 === null || base64.length === 0) {
          unreadable += 1;
          continue;
        }
        files.push(toAttachment(base64, asset.name, asset.mimeType, asset.uri));
      }
      return { kind: "picked", files, unreadable };
    },

    async pickPhotos(): Promise<AttachPickOutcome> {
      let result: ImagePicker.ImagePickerResult;
      try {
        // The system photo picker on both platforms — no roll-wide permission is requested, so
        // there is no permission arm to refuse; `base64: true` puts the bytes in hand.
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          allowsMultipleSelection: true,
          base64: true,
          quality: 1,
        });
      } catch {
        return { kind: "unavailable" };
      }
      if (result.canceled) return { kind: "cancelled" };
      const files: PhoneComposeAttachment[] = [];
      let unreadable = 0;
      for (const asset of result.assets ?? []) {
        const base64 =
          typeof asset.base64 === "string" && asset.base64.length > 0
            ? asset.base64
            : await fileBase64(asset.uri);
        if (base64 === null || base64.length === 0) {
          unreadable += 1;
          continue;
        }
        files.push(toAttachment(base64, asset.fileName, asset.mimeType, asset.uri));
      }
      return { kind: "picked", files, unreadable };
    },
  };
}
