export interface FolderLabel {
  label: string;
  repeats?: number;
}

const KOHYA_RE = /^(\d+)_(.+)$/;

/** "3_door" -> { label: "door", repeats: 3 }; other names are returned unchanged. */
export function parseKohyaFolder(name: string): FolderLabel {
  const m = KOHYA_RE.exec(name);
  if (!m) return { label: name };
  return { label: m[2], repeats: Number(m[1]) };
}

/** Display text for a relative posix dir: last segment, kohya-formatted ("a/3_door" -> "door (3)"). */
export function folderTag(dir: string): string {
  if (!dir) return '';
  const { label, repeats } = parseKohyaFolder(dir.slice(dir.lastIndexOf('/') + 1));
  return repeats === undefined ? label : `${label} (${repeats})`;
}
