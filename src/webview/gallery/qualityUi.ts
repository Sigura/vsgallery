import { qualityFlags, QUALITY_LABELS, type QualityFlag } from '../../shared/quality';
import type { GallerySettings, ImageEntry } from '../../shared/protocol';

export type QualityFilter = '' | 'issues' | QualityFlag;

/** Flags shown as tile badges, with their badge text; ÷64 is only a filter (most photos are not ÷64). */
const BADGES: Partial<Record<QualityFlag, [text: string, cls: 'warn' | 'info']>> = {
  noCaption: ['no caption', 'warn'],
  emptyCaption: ['empty caption', 'warn'],
  blur: ['blurry', 'warn'],
  small: ['small', 'warn'],
  not8: ['÷8', 'info'],
  aspect: ['aspect', 'info'],
  shortCaption: ['short caption', 'info'],
  longCaption: ['long caption', 'info'],
};

export function flagsOf(e: ImageEntry, s: GallerySettings): QualityFlag[] {
  return qualityFlags({ w: e.w, h: e.h, caption: e.caption, blur: e.metrics?.blur }, s.quality);
}

function flagTitle(f: QualityFlag, e: ImageEntry, s: GallerySettings): string {
  const q = s.quality;
  switch (f) {
    case 'small':
      return `Short side ${Math.min(e.w, e.h)} px is below ${q.minResolution}`;
    case 'blur':
      return `Sharpness ${e.metrics?.blur} is below ${q.blurThreshold} (loraDataset.quality.blurThreshold)`;
    case 'not8':
      return `${e.w}×${e.h} is not divisible by 8`;
    case 'aspect':
      return `Aspect ${(Math.max(e.w, e.h) / Math.min(e.w, e.h)).toFixed(2)}:1 exceeds ${q.maxAspect}:1`;
    case 'noCaption':
      return 'No caption file';
    case 'emptyCaption':
      return 'Caption file is empty';
    case 'shortCaption':
      return `Fewer than ${q.minWords} words`;
    case 'longCaption':
      return `More than about ${q.maxTokens} CLIP tokens`;
    default:
      return QUALITY_LABELS[f];
  }
}

export function qualityBadges(e: ImageEntry, s: GallerySettings): { text: string; cls: string; title: string }[] {
  const out: { text: string; cls: string; title: string }[] = [];
  for (const f of flagsOf(e, s)) {
    const b = BADGES[f];
    if (b) out.push({ text: b[0], cls: b[1], title: flagTitle(f, e, s) });
  }
  return out;
}

export function matchesQuality(e: ImageEntry, s: GallerySettings, filter: QualityFilter): boolean {
  if (!filter) return true;
  const flags = flagsOf(e, s);
  return filter === 'issues' ? flags.some((f) => f !== 'not64') : flags.includes(filter);
}

/** Options for the quality filter select. */
export function qualityFilterOptions(): string {
  const flags = Object.keys(QUALITY_LABELS) as QualityFlag[];
  return (
    '<option value="">Any quality</option><option value="issues">Any issue (except ÷64)</option>' +
    flags.map((f) => `<option value="${f}">${QUALITY_LABELS[f]}</option>`).join('')
  );
}
