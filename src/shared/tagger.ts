import { joinTags, parseTags, tagKey } from './captions';

export type TaggerModelId = 'wd-vit-tagger-v3' | 'wd-eva02-large-tagger-v3';
export type ExistingCaptionMode = 'skip' | 'overwrite' | 'append';
export type TaggerBackend = 'auto' | 'webgpu' | 'wasm';

export interface TaggerModelInfo {
  id: TaggerModelId;
  repo: string;
  /** Square input side; the models take 1×size×size×3 NHWC float32. */
  inputSize: number;
  approxDownload: string;
}

export const TAGGER_MODELS: Record<TaggerModelId, TaggerModelInfo> = {
  'wd-vit-tagger-v3': { id: 'wd-vit-tagger-v3', repo: 'SmilingWolf/wd-vit-tagger-v3', inputSize: 448, approxDownload: '~380 MB' },
  'wd-eva02-large-tagger-v3': {
    id: 'wd-eva02-large-tagger-v3',
    repo: 'SmilingWolf/wd-eva02-large-tagger-v3',
    inputSize: 448,
    approxDownload: '~1.3 GB',
  },
};

export const TAGGER_FILES = ['model.onnx', 'selected_tags.csv'] as const;

export interface TaggerSettings {
  model: TaggerModelId;
  /** Folder with model.onnx and selected_tags.csv used instead of the downloaded model ('' = download). */
  modelFolder: string;
  generalThreshold: number;
  characterThreshold: number;
  excludeTags: string[];
  replaceUnderscores: boolean;
  triggerWord: string;
  existingCaptions: ExistingCaptionMode;
  backend: TaggerBackend;
}

export const enum TagCategory {
  General = 0,
  Character = 4,
  Rating = 9,
}

export interface TagLabels {
  names: string[];
  categories: number[];
}

/** Kept verbatim: replacing their underscores would destroy them (list from the official WD tagger demo). */
const KAOMOJIS = new Set([
  '0_0', '(o)_(o)', '+_+', '+_-', '._.', '<o>_<o>', '<|>_<|>', '=_=', '>_<', '3_3', '6_9', '>_o', '@_@', '^_^', 'o_o', 'u_u', 'x_x', '|_|', '||_||',
]);

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parses selected_tags.csv (tag_id,name,category,count); row order matches the model's output order. */
export function parseSelectedTags(csv: string): TagLabels {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = splitCsvLine(lines[0] ?? '').map((h) => h.trim());
  const nameCol = header.indexOf('name');
  const catCol = header.indexOf('category');
  if (nameCol < 0 || catCol < 0) throw new Error('selected_tags.csv has no "name"/"category" columns');
  const names: string[] = [];
  const categories: number[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const cat = Number(cols[catCol]);
    if (cols[nameCol] === undefined || !Number.isFinite(cat)) throw new Error(`Malformed selected_tags.csv row: ${line}`);
    names.push(cols[nameCol]);
    categories.push(cat);
  }
  return { names, categories };
}

export function displayTag(name: string, replaceUnderscores: boolean): string {
  return replaceUnderscores && !KAOMOJIS.has(name) ? name.replace(/_/g, ' ') : name;
}

/** Identity of a tag for exclusion: case-insensitive, underscores and spaces are the same. */
function excludeKey(tag: string): string {
  return KAOMOJIS.has(tag) ? tag : tagKey(tag.replace(/_/g, ' ').replace(/\s+/g, ' ').trim());
}

export interface ScoredTag {
  tag: string;
  p: number;
}

export interface TagResult {
  character: ScoredTag[];
  general: ScoredTag[];
  /** Highest-scoring rating label (general, sensitive, questionable, explicit). */
  rating?: ScoredTag;
}

export type PostprocessOptions = Pick<TaggerSettings, 'generalThreshold' | 'characterThreshold' | 'excludeTags' | 'replaceUnderscores'>;

export function postprocess(probs: ArrayLike<number>, labels: TagLabels, opts: PostprocessOptions): TagResult {
  if (probs.length !== labels.names.length) {
    throw new Error(`Model returned ${probs.length} scores but selected_tags.csv has ${labels.names.length} tags`);
  }
  const excluded = new Set(opts.excludeTags.map(excludeKey));
  const result: TagResult = { character: [], general: [] };
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    const name = labels.names[i];
    const cat = labels.categories[i];
    if (cat === TagCategory.Rating) {
      if (!result.rating || p > result.rating.p) result.rating = { tag: name, p };
      continue;
    }
    const list =
      cat === TagCategory.Character && p > opts.characterThreshold
        ? result.character
        : cat === TagCategory.General && p > opts.generalThreshold
          ? result.general
          : undefined;
    if (!list || excluded.has(excludeKey(name))) continue;
    list.push({ tag: displayTag(name, opts.replaceUnderscores), p });
  }
  const byP = (a: ScoredTag, b: ScoredTag) => b.p - a.p;
  result.character.sort(byP);
  result.general.sort(byP);
  return result;
}

/** Caption tags: character tags first, then general tags, each by descending confidence. */
export function resultTags(r: TagResult): string[] {
  return [...r.character, ...r.general].map((t) => t.tag);
}

function dedupe(tags: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = tagKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * New caption text from generated tags and the existing caption (null = none), or undefined
 * when the existing caption is kept ('skip' with a non-empty caption). The trigger word goes first.
 */
export function combineCaption(
  existing: string | null,
  generated: readonly string[],
  mode: ExistingCaptionMode,
  triggerWord: string,
): string | undefined {
  const old = existing === null ? [] : parseTags(existing);
  if (mode === 'skip' && old.length) return undefined;
  const trigger = parseTags(triggerWord);
  const body = mode === 'append' ? [...old, ...generated] : [...generated];
  const triggerKeys = new Set(trigger.map(tagKey));
  return joinTags(dedupe([...trigger, ...body.filter((t) => !triggerKeys.has(tagKey(t)))]));
}

/**
 * WD tagger input from RGBA pixels of the padded, resized square image: alpha composited on
 * white, channels reordered to BGR, values 0–255, layout NHWC.
 */
export function toModelInput(rgba: Uint8ClampedArray | Uint8Array, size: number): Float32Array {
  if (rgba.length !== size * size * 4) throw new Error(`Expected ${size}×${size} RGBA pixels, got ${rgba.length / 4}`);
  const out = new Float32Array(size * size * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    const white = 255 * (1 - a);
    out[j] = rgba[i + 2] * a + white;
    out[j + 1] = rgba[i + 1] * a + white;
    out[j + 2] = rgba[i] * a + white;
  }
  return out;
}

/** Placement of a w×h image centred on a white square canvas of side `size` (pad to square, then resize). */
export function squarePlacement(w: number, h: number, size: number): { x: number; y: number; w: number; h: number } {
  const side = Math.max(w, h);
  const s = (v: number) => (v * size) / side;
  // Integer padding like the reference implementation, then scaled.
  return { x: s(Math.floor((side - w) / 2)), y: s(Math.floor((side - h) / 2)), w: s(w), h: s(h) };
}
