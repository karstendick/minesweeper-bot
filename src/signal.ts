import type { ImageData } from "./types.js";
import { getPixel } from "./image-utils.js";

/** Return the top N autocorrelation peaks of a signal, sorted by strength. */
export function topAutocorrelationPeaks(signal: number[], minPeriod: number, maxPeriod: number, n: number): number[] {
  const len = signal.length;
  const mean = signal.reduce((a, b) => a + b, 0) / len;
  const norm = signal.map((v) => v - mean);

  let ac0 = 0;
  for (const v of norm) ac0 += v * v;
  if (ac0 === 0) return [];

  const scores: number[] = [];
  for (let lag = minPeriod; lag <= Math.min(maxPeriod, Math.floor(len / 2)); lag++) {
    let ac = 0;
    for (let i = 0; i < len - lag; i++) ac += norm[i]! * norm[i + lag]!;
    scores.push(ac / ac0);
  }

  const peaks: { lag: number; score: number }[] = [];
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i]! > scores[i - 1]! && scores[i]! > scores[i + 1]! && scores[i]! > 0.05) {
      peaks.push({ lag: minPeriod + i, score: scores[i]! });
    }
  }

  peaks.sort((a, b) => b.score - a.score);
  return peaks.slice(0, n).map((p) => p.lag);
}

/** Compute average R-channel value per column (horizontal) or row (vertical). */
export function computeProjection(
  img: ImageData,
  axis: "horizontal" | "vertical",
  rangeStart: number,
  rangeEnd: number,
): number[] {
  const proj: number[] = [];
  const len = axis === "horizontal" ? img.width : img.height;

  for (let i = 0; i < len; i++) {
    let sum = 0, count = 0;
    for (let j = rangeStart; j < rangeEnd; j += 3) {
      const x = axis === "horizontal" ? i : j;
      const y = axis === "horizontal" ? j : i;
      const [r] = getPixel(img, x, y);
      sum += r;
      count++;
    }
    proj.push(count > 0 ? sum / count : 0);
  }

  return proj;
}

/** Compute the absolute first-difference (derivative) of a signal. */
export function computeDerivative(signal: number[]): number[] {
  const deriv: number[] = [];
  for (let i = 1; i < signal.length; i++) {
    deriv.push(Math.abs(signal[i]! - signal[i - 1]!));
  }
  return deriv;
}

/** Find the offset where a pitch best aligns with edges in a derivative signal. */
export function findBestOffset(deriv: number[], pitch: number, start = 0, end = deriv.length): { offset: number; score: number } {
  let bestOffset = 0, bestScore = 0;
  for (let off = 0; off < pitch; off++) {
    let score = 0;
    for (let i = off; i < deriv.length; i += pitch) {
      if (i < start || i > end) continue;
      for (let d = -3; d <= 3; d++) {
        const idx = i + d;
        if (idx >= 0 && idx < deriv.length) score += deriv[idx]!;
      }
    }
    if (score > bestScore) { bestScore = score; bestOffset = off; }
  }
  return { offset: bestOffset, score: bestScore };
}

/** Score how well a pitch aligns with edges (best offset's score). */
export function derivAlignScore(deriv: number[], pitch: number, start = 0, end = deriv.length): number {
  return findBestOffset(deriv, pitch, start, end).score;
}
