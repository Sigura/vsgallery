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

export interface RepeatPlanRow {
  dir: string;
  label: string;
  images: number;
  /** Current repeats; undefined for a folder without an "N_" prefix (kohya does not train it). */
  repeats: number | undefined;
  newRepeats: number;
  /** Equal to `dir` when the repeats do not change. */
  newDir: string;
  /** Why this folder cannot be renamed as planned. */
  conflict?: string;
}

/**
 * Repeats that make every kohya folder ("N_name", not the dataset root) contribute about `target`
 * samples per epoch: round(target / images), at least 1. A zero-padded count keeps its width.
 * With `includePlain`, folders without the prefix get one ("dress" -> "8_dress").
 * A rename is a conflict when its new name is already taken by another known folder or planned twice.
 */
export function planRepeats(
  folders: readonly { dir: string; images: number }[],
  target: number,
  includePlain = false,
): RepeatPlanRow[] {
  const rows: RepeatPlanRow[] = [];
  for (const { dir, images } of folders) {
    if (!dir || images <= 0) continue;
    const slash = dir.lastIndexOf('/');
    const name = dir.slice(slash + 1);
    const m = KOHYA_RE.exec(name);
    if (!m && !includePlain) continue;
    const newRepeats = Math.max(1, Math.round(target / images));
    const digits = m?.[1].startsWith('0') ? m[1].length : 1;
    const label = m ? m[2] : name;
    const newDir = `${dir.slice(0, slash + 1)}${String(newRepeats).padStart(digits, '0')}_${label}`;
    rows.push({ dir, label, images, repeats: m ? Number(m[1]) : undefined, newRepeats, newDir });
  }
  const known = new Set(folders.map((f) => f.dir));
  const planned = new Map<string, number>();
  for (const r of rows) if (r.newDir !== r.dir) planned.set(r.newDir, (planned.get(r.newDir) ?? 0) + 1);
  for (const r of rows) {
    if (r.newDir === r.dir) continue;
    if (known.has(r.newDir)) r.conflict = `"${r.newDir}" already exists`;
    else if (planned.get(r.newDir)! > 1) r.conflict = `another folder would also become "${r.newDir}"`;
  }
  return rows;
}

/** Target that keeps the largest planned folder at one repeat. */
export function defaultRepeatTarget(folders: readonly { dir: string; images: number }[], includePlain = false): number {
  const counted = folders.filter((f) => f.dir && (includePlain || KOHYA_RE.test(f.dir.slice(f.dir.lastIndexOf('/') + 1))));
  return Math.max(1, ...counted.map((f) => f.images));
}

export function isKohyaFolder(dir: string): boolean {
  return KOHYA_RE.test(dir.slice(dir.lastIndexOf('/') + 1));
}
