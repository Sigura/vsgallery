/** Splits a comma-separated caption into trimmed, non-empty tags (whitespace inside a tag is collapsed). */
export function parseTags(text: string): string[] {
  const tags: string[] = [];
  for (const raw of text.split(',')) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t) tags.push(t);
  }
  return tags;
}

/** Strips a UTF-8 BOM, which some caption tools write. */
export function decodeCaption(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function isCaptionEmpty(text: string): boolean {
  return text.trim().length === 0 || parseTags(text).length === 0;
}

export function joinTags(tags: readonly string[]): string {
  return tags.join(', ');
}

/** Case-insensitive identity of a tag, used for de-duplication and merging. */
export function tagKey(tag: string): string {
  return tag.toLowerCase();
}

/**
 * Three-way merge of tag lists: starts from `theirs` (the file on disk), drops tags I removed
 * since `base`, and appends tags I added that are not there yet.
 */
export function mergeTags(base: readonly string[], mine: readonly string[], theirs: readonly string[]): string[] {
  const baseKeys = new Set(base.map(tagKey));
  const mineKeys = new Set(mine.map(tagKey));
  const removedByMe = new Set([...baseKeys].filter((k) => !mineKeys.has(k)));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const t of theirs) {
    const k = tagKey(t);
    if (removedByMe.has(k) || seen.has(k)) continue;
    seen.add(k);
    result.push(t);
  }
  for (const t of mine) {
    const k = tagKey(t);
    if (baseKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    result.push(t);
  }
  return result;
}

/** Tag -> number of captions containing it (counted once per caption), keyed by the most common spelling. */
export function tagFrequency(captions: Iterable<string>): Map<string, number> {
  const counts = new Map<string, { tag: string; n: number }>();
  for (const c of captions) {
    const seen = new Set<string>();
    for (const t of parseTags(c)) {
      const k = tagKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = counts.get(k);
      if (cur) cur.n++;
      else counts.set(k, { tag: t, n: 1 });
    }
  }
  return new Map([...counts.values()].map((v) => [v.tag, v.n]));
}

/** Autocomplete: prefix matches first, then substring matches; each by frequency, then name. */
export function suggestTags(
  freq: ReadonlyMap<string, number>,
  query: string,
  exclude: ReadonlySet<string>,
  limit = 10,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix: [string, number][] = [];
  const inner: [string, number][] = [];
  for (const [tag, n] of freq) {
    const k = tagKey(tag);
    if (exclude.has(k) || k === q) continue;
    if (k.startsWith(q)) prefix.push([tag, n]);
    else if (k.includes(q)) inner.push([tag, n]);
  }
  const byFreq = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);
  return [...prefix.sort(byFreq), ...inner.sort(byFreq)].slice(0, limit).map(([t]) => t);
}
