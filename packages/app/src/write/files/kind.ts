/** A file's kind as a few letters for its tile: its name's ending, or the type's, or nothing to say. */
export function kindOf(filename: string, contentType = ""): string {
  const dot = filename.lastIndexOf(".");
  const ending = dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1) : "";
  if (ending !== "" && ending.length <= 5) return ending.toUpperCase();
  const sub = contentType.split("/")[1]?.split(/[+;.]/)[0] ?? "";
  return sub !== "" && sub.length <= 5 ? sub.toUpperCase() : "";
}
