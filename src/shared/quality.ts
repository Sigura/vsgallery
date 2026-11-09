import { isCaptionEmpty } from './captions';

export type QualityFlag = 'small' | 'blur' | 'not8' | 'not64' | 'aspect' | 'noCaption' | 'emptyCaption' | 'shortCaption' | 'longCaption';

export interface QualityOptions {
  /** Short side below this is "small". */
  minResolution: number;
  /** Sharpness (see imageHash.sharpness) below this is "blurry". */
  blurThreshold: number;
  /** Long side / short side above this is "extreme aspect". */
  maxAspect: number;
  /** Fewer words than this is a "short caption". */
  minWords: number;
  /** More (approximate CLIP) tokens than this is a "long caption". */
  maxTokens: number;
}

export interface QualityInput {
  w: number;
  h: number;
  caption?: string | null;
  /** Undefined until the image has been analysed. */
  sharpness?: number;
}

export const QUALITY_LABELS: Record<QualityFlag, string> = {
  small: 'Small resolution',
  blur: 'Blurry',
  not8: 'Not ÷8',
  not64: 'Not ÷64',
  aspect: 'Extreme aspect',
  noCaption: 'No caption file',
  emptyCaption: 'Empty caption',
  shortCaption: 'Short caption',
  longCaption: 'Long caption',
};

/**
 * Rough CLIP token count: words, numbers and punctuation marks count as one token each.
 * CLIP's BPE splits rare words further, so real counts are somewhat higher.
 */
export function approxTokens(text: string): number {
  return text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;
}

export function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

/** Flags that apply; size-based flags need known dimensions, blur needs an analysis result. */
export function qualityFlags(e: QualityInput, o: QualityOptions): QualityFlag[] {
  const out: QualityFlag[] = [];
  if (e.w > 0 && e.h > 0) {
    if (Math.min(e.w, e.h) < o.minResolution) out.push('small');
    if (e.w % 8 || e.h % 8) out.push('not8');
    if (e.w % 64 || e.h % 64) out.push('not64');
    if (Math.max(e.w, e.h) / Math.min(e.w, e.h) > o.maxAspect) out.push('aspect');
  }
  if (e.sharpness !== undefined && e.sharpness < o.blurThreshold) out.push('blur');
  if (e.caption === null) out.push('noCaption');
  else if (typeof e.caption === 'string') {
    if (isCaptionEmpty(e.caption)) out.push('emptyCaption');
    else {
      if (wordCount(e.caption) < o.minWords) out.push('shortCaption');
      if (approxTokens(e.caption) > o.maxTokens) out.push('longCaption');
    }
  }
  return out;
}
