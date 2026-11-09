import { nearestBucket, type Size } from './buckets';
import { isCaptionEmpty, parseTags, tagFrequency } from './captions';
import { parseKohyaFolder } from './kohya';
import { naturalCompare } from './naturalSort';

export interface StatsInput {
  dir: string;
  w: number;
  h: number;
  caption?: string | null;
}

export interface FolderStats {
  dir: string;
  label: string;
  /** kohya repeats from the folder name ("10_name"); 1 when the name has none. */
  repeats: number;
  hasRepeats: boolean;
  images: number;
  /** images × repeats: how many samples the folder contributes to one epoch. */
  samples: number;
}

export interface CountRow {
  label: string;
  n: number;
}

export interface DatasetStats {
  images: number;
  samplesPerEpoch: number;
  folders: FolderStats[];
  /** Short-side ranges. */
  resolution: CountRow[];
  orientation: CountRow[];
  /** Nearest bucket by aspect ratio (kohya's rule, ignoring bucket_no_upscale), most used first. */
  buckets: CountRow[];
  unknownSize: number;
  captions: { withText: number; missing: number; empty: number; notLoaded: number };
  tags: { unique: number; total: number; perCaption: number; top: CountRow[] };
}

const RES_EDGES = [512, 768, 1024, 1536];

function resolutionLabel(short: number): string {
  const i = RES_EDGES.findIndex((e) => short < e);
  if (i === 0) return `< ${RES_EDGES[0]}`;
  if (i === -1) return `≥ ${RES_EDGES.at(-1)}`;
  return `${RES_EDGES[i - 1]}–${RES_EDGES[i] - 1}`;
}

/** Folder key used for repeats: the image's own directory (kohya reads repeats from the immediate subfolder name). */
export function datasetStats(entries: Iterable<StatsInput>, buckets: readonly Size[], topTags = 50): DatasetStats {
  const folders = new Map<string, FolderStats>();
  const res = new Map<string, number>(RES_EDGES.map((_, i) => [resolutionLabel(i === 0 ? 0 : RES_EDGES[i - 1]), 0]));
  res.set(resolutionLabel(Infinity), 0);
  const orient = new Map<string, number>([
    ['Landscape', 0],
    ['Portrait', 0],
    ['Square', 0],
  ]);
  const bucketCounts = new Map<string, number>();
  const captions = { withText: 0, missing: 0, empty: 0, notLoaded: 0 };
  const texts: string[] = [];
  let images = 0;
  let unknownSize = 0;
  let tagTotal = 0;

  for (const e of entries) {
    images++;
    let f = folders.get(e.dir);
    if (!f) {
      const name = e.dir.slice(e.dir.lastIndexOf('/') + 1);
      const { label, repeats } = parseKohyaFolder(name);
      f = { dir: e.dir, label: e.dir ? label : '(root)', repeats: repeats ?? 1, hasRepeats: repeats !== undefined, images: 0, samples: 0 };
      folders.set(e.dir, f);
    }
    f.images++;
    f.samples += f.repeats;

    if (e.w > 0 && e.h > 0) {
      const short = Math.min(e.w, e.h);
      const rl = resolutionLabel(short);
      res.set(rl, (res.get(rl) ?? 0) + 1);
      const o = e.w === e.h ? 'Square' : e.w > e.h ? 'Landscape' : 'Portrait';
      orient.set(o, orient.get(o)! + 1);
      if (buckets.length) {
        const b = nearestBucket(e.w, e.h, buckets);
        const k = `${b.w}×${b.h}`;
        bucketCounts.set(k, (bucketCounts.get(k) ?? 0) + 1);
      }
    } else unknownSize++;

    if (e.caption === undefined) captions.notLoaded++;
    else if (e.caption === null) captions.missing++;
    else if (isCaptionEmpty(e.caption)) captions.empty++;
    else {
      captions.withText++;
      texts.push(e.caption);
      tagTotal += parseTags(e.caption).length;
    }
  }

  const freq = tagFrequency(texts);
  const toRows = (m: Map<string, number>) => [...m].map(([label, n]) => ({ label, n }));
  const folderList = [...folders.values()].sort((a, b) => (a.dir === '' ? -1 : b.dir === '' ? 1 : naturalCompare(a.dir, b.dir)));
  return {
    images,
    samplesPerEpoch: folderList.reduce((s, f) => s + f.samples, 0),
    folders: folderList,
    resolution: toRows(res),
    orientation: toRows(orient),
    buckets: toRows(bucketCounts).sort((a, b) => b.n - a.n || naturalCompare(a.label, b.label)),
    unknownSize,
    captions,
    tags: {
      unique: freq.size,
      total: tagTotal,
      perCaption: captions.withText ? tagTotal / captions.withText : 0,
      top: toRows(freq)
        .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
        .slice(0, topTags),
    },
  };
}
