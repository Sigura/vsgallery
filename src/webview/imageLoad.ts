import { backoffDelay, withRetry } from '../shared/retry';

const RETRIES = 5;

interface Load {
  url: string;
  attempt: number;
  timer: number | undefined;
  fallback: ((failed: string) => string | undefined) | undefined;
}

const loads = new WeakMap<HTMLImageElement, Load>();

/**
 * Shows `url` in `img` and retries failed loads with backoff (webview resource requests fail now
 * and then, e.g. while the file is being written). On a failure `fallback` is asked first for
 * another URL to switch to, such as the full image when a cached thumbnail has vanished.
 */
export function loadImage(img: HTMLImageElement, url: string, fallback?: (failed: string) => string | undefined): void {
  let l = loads.get(img);
  if (!l) {
    l = { url, attempt: 0, timer: undefined, fallback };
    loads.set(img, l);
    img.addEventListener('error', () => retry(img));
  }
  clearTimeout(l.timer);
  l.url = url;
  l.attempt = 0;
  l.fallback = fallback;
  if (img.getAttribute('src') === url && img.complete && img.naturalWidth > 0) return;
  img.removeAttribute('src');
  img.src = url;
}

function retry(img: HTMLImageElement): void {
  const l = loads.get(img);
  if (!l || img.getAttribute('src') !== l.url) return;
  const next = l.fallback?.(l.url);
  if (next && next !== l.url) {
    l.url = next;
    l.attempt = 0;
    img.src = next;
    return;
  }
  if (l.attempt >= RETRIES) return;
  l.attempt++;
  const url = l.url;
  l.timer = window.setTimeout(() => {
    if (l.url !== url) return;
    img.removeAttribute('src');
    img.src = url;
  }, backoffDelay(l.attempt, 250, 4000));
}

class TransientFetchError extends Error {}

/** Fetches a webview resource as a blob, retrying network failures and 408/429/5xx with backoff. */
export function fetchBlob(url: string): Promise<Blob> {
  return withRetry(
    async () => {
      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        throw new TransientFetchError(`fetch failed: ${e instanceof Error ? e.message : e}`);
      }
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw new TransientFetchError(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'file not found' : `HTTP ${res.status}`);
      return res.blob();
    },
    { retries: RETRIES, baseDelayMs: 250, maxDelayMs: 4000, isRetryable: (e) => e instanceof TransientFetchError },
  );
}
