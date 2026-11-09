import type { ImageEntry, SortDir, SortKey } from './protocol';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
  const c = collator.compare(a, b);
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
}

type Metric = (e: ImageEntry) => number | undefined;

const metrics: Record<Exclude<SortKey, 'name'>, Metric> = {
  mtime: (e) => e.mtime,
  size: (e) => e.size,
  resolution: (e) => (e.w > 0 && e.h > 0 ? e.w * e.h : undefined),
  aspect: (e) => (e.w > 0 && e.h > 0 ? e.w / e.h : undefined),
};

/** Entries whose metric is unknown (dimensions not read yet / unreadable) always sort last. */
export function entryComparator(key: SortKey, dir: SortDir): (a: ImageEntry, b: ImageEntry) => number {
  const sign = dir === 'asc' ? 1 : -1;
  const byPath = (a: ImageEntry, b: ImageEntry) => naturalCompare(a.name, b.name) || naturalCompare(a.id, b.id);
  if (key === 'name') return (a, b) => sign * byPath(a, b);
  const metric = metrics[key];
  return (a, b) => {
    const ma = metric(a);
    const mb = metric(b);
    if (ma === undefined || mb === undefined) {
      if (ma !== mb) return ma === undefined ? 1 : -1;
      return byPath(a, b);
    }
    return ma !== mb ? sign * (ma - mb) : byPath(a, b);
  };
}
