export interface SearchQuery {
  /** Lower-cased words or "quoted phrases" that must all match, in any order. */
  include: string[];
  /** The non-excluded text as one lower-cased string, for exact tag matching ('' = none). */
  text: string;
  /** Lower-cased words or phrases that must not match. */
  exclude: string[];
}

// A lone "-" fails the optional prefix plus term, backtracks, and is read as a literal word.
const TERM_RE = /(-?)(?:"([^"]*)"|(\S+))/g;

/** Words must all match; `"two words"` is one phrase; `-word` and `-"two words"` exclude. */
export function parseSearch(query: string): SearchQuery {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const m of query.toLowerCase().matchAll(TERM_RE)) {
    const term = (m[2] ?? m[3]).trim().replace(/\s+/g, ' ');
    if (term) (m[1] ? exclude : include).push(term);
  }
  return { include, text: include.join(' '), exclude };
}
