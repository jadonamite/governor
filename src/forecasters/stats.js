/**
 * Small statistics helpers shared by the forecasters. Pure, no I/O.
 */

'use strict';

/** Normal CDF (Abramowitz & Stegun 26.2.17). */
export function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014337 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function stdev(xs) {
  if (xs.length < 2) return NaN;
  const mu = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1));
}

/**
 * Fetch with retries. A dropped connection must never be allowed to look like
 * "no forecaster covers this market" — that hides a broken feed as deliberate
 * abstention, and the caller sizes nothing while believing it chose to.
 */
export async function fetchRetry(url, { attempts = 3, timeoutMs = 45_000, headers } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Probability that a normal(projected, sigma) draw lands above `threshold`.
 * `strict` is cosmetic for continuous quantities but documents the criteria.
 */
export function pAbove(threshold, projected, sigma) {
  return 1 - phi((threshold - projected) / sigma);
}

/**
 * Clamp a probability away from 0 and 1.
 *
 * No forecaster should ever report certainty. Even when the underlying process
 * is effectively decided, settlement is not: oracles misread, provisional data
 * is revised, feeds break. That residual risk is irreducible, and a model that
 * reports 0.999 will size as though it does not exist.
 */
export function clamp01(p, floor = 0.02) {
  return Math.min(1 - floor, Math.max(floor, p));
}

/**
 * Same retry policy as `fetchRetry`, but returns the raw body. Treasury
 * publishes the yield curve as an Atom feed, not JSON.
 */
export async function fetchRetryText(url, { attempts = 3, timeoutMs = 45_000, headers } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}
