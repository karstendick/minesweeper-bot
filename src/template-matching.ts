/**
 * Shared digit template matching infrastructure.
 *
 * Used by both Classic and Clean One skins for shape-based digit recognition.
 * Extracts digit glyphs as binary bitmaps normalized to TMPL_W x TMPL_H,
 * then matches via Normalized Cross-Correlation (NCC).
 */

import { getPixel } from "./image-utils.js";
import type { CellState, ImageData } from "./types.js";

export const TMPL_W = 16;
export const TMPL_H = 20;

export interface DigitTemplate {
  state: CellState;
  bitmap: string;
}

/**
 * Match a bitmap against a set of digit templates using NCC.
 * Returns "unknown" if best score < minScore.
 */
export function matchDigit(
  bitmap: number[],
  templates: DigitTemplate[],
  minScore: number = 0.25,
): CellState {
  let bestState: CellState = "unknown";
  let bestScore = -Infinity;

  for (const tmpl of templates) {
    let sumAB = 0, sumAA = 0, sumBB = 0;
    const n = TMPL_W * TMPL_H;
    let meanA = 0, meanB = 0;
    for (let i = 0; i < n; i++) {
      meanA += bitmap[i]!;
      meanB += (tmpl.bitmap[i] === "1" ? 1 : 0);
    }
    meanA /= n;
    meanB /= n;

    for (let i = 0; i < n; i++) {
      const a = bitmap[i]! - meanA;
      const b = (tmpl.bitmap[i] === "1" ? 1 : 0) - meanB;
      sumAB += a * b;
      sumAA += a * a;
      sumBB += b * b;
    }

    const denom = Math.sqrt(sumAA * sumBB);
    const score = denom > 0 ? sumAB / denom : 0;

    if (score > bestScore) {
      bestScore = score;
      bestState = tmpl.state;
    }
  }

  if (bestScore < minScore) return "unknown";
  return bestState;
}

/**
 * Extract a TMPL_W x TMPL_H binary bitmap of a digit from a cell region.
 * Uses cluster-based bbox finding + aspect-ratio padding + area-averaging.
 *
 * @param glyphThreshold - brightness threshold for glyph detection
 * @param invertGlyph - if true, glyph pixels are DARKER than threshold (classic skin);
 *                      if false, glyph pixels are BRIGHTER (Clean One skin)
 * @param marginFraction - fraction of cell size to skip at edges (default 0.08)
 * @returns normalized binary bitmap, or null if no digit found
 */
export function extractDigitBitmap(
  img: ImageData,
  cellX: number, cellY: number,
  cellW: number, cellH: number,
  glyphThreshold: number,
  invertGlyph: boolean = false,
  marginFraction: number = 0.08,
): number[] | null {
  const margin = Math.floor(Math.min(cellW, cellH) * marginFraction);

  const isGlyph = (r: number, g: number, b: number): boolean => {
    const brightness = (r + g + b) / 3;
    return invertGlyph ? brightness < glyphThreshold : brightness > glyphThreshold;
  };

  // Collect all glyph pixel positions.
  // Use step 1 for small cells to avoid aliasing with JPEG 8x8 blocks.
  const step = Math.min(cellW, cellH) < 40 ? 1 : 2;
  const glyphPts: { x: number; y: number }[] = [];
  for (let dy = margin; dy < cellH - margin; dy += step) {
    for (let dx = margin; dx < cellW - margin; dx += step) {
      const x = cellX + dx, y = cellY + dy;
      if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
      const [r, g, b] = getPixel(img, x, y);
      if (isGlyph(r, g, b)) {
        glyphPts.push({ x: dx, y: dy });
      }
    }
  }

  if (glyphPts.length < 3) return null;

  // Find the densest cluster via iterative centroid
  const maxRadius = Math.floor(Math.min(cellW, cellH) * 0.25);
  let cx = glyphPts.map(p => p.x).sort((a, b) => a - b)[Math.floor(glyphPts.length / 2)]!;
  let cy = glyphPts.map(p => p.y).sort((a, b) => a - b)[Math.floor(glyphPts.length / 2)]!;

  for (let iter = 0; iter < 3; iter++) {
    const nearby = glyphPts.filter(p =>
      Math.abs(p.x - cx) < maxRadius && Math.abs(p.y - cy) < maxRadius
    );
    if (nearby.length === 0) break;
    cx = Math.round(nearby.reduce((s, p) => s + p.x, 0) / nearby.length);
    cy = Math.round(nearby.reduce((s, p) => s + p.y, 0) / nearby.length);
  }

  const cluster = glyphPts.filter(p =>
    Math.abs(p.x - cx) < maxRadius && Math.abs(p.y - cy) < maxRadius
  );
  if (cluster.length < 3) return null;

  // Compute tight bbox around the cluster
  let gMinX = cellW, gMaxX = 0, gMinY = cellH, gMaxY = 0;
  for (const p of cluster) {
    if (p.x < gMinX) gMinX = p.x;
    if (p.x > gMaxX) gMaxX = p.x;
    if (p.y < gMinY) gMinY = p.y;
    if (p.y > gMaxY) gMaxY = p.y;
  }

  const pad = Math.max(2, Math.floor(Math.min(cellW, cellH) * 0.02));
  gMinX = Math.max(margin, gMinX - pad);
  gMaxX = Math.min(cellW - margin - 1, gMaxX + pad);
  gMinY = Math.max(margin, gMinY - pad);
  gMaxY = Math.min(cellH - margin - 1, gMaxY + pad);

  let gW = gMaxX - gMinX + 1;
  let gH = gMaxY - gMinY + 1;
  if (gW < 3 || gH < 3) return null;

  // Pad bbox to match template aspect ratio (TMPL_W:TMPL_H)
  const targetRatio = TMPL_W / TMPL_H;
  const bboxRatio = gW / gH;
  if (bboxRatio < targetRatio) {
    const newW = Math.round(gH * targetRatio);
    const expand = newW - gW;
    gMinX = Math.max(margin, gMinX - Math.floor(expand / 2));
    gMaxX = Math.min(cellW - margin - 1, gMinX + newW - 1);
    gW = gMaxX - gMinX + 1;
  } else if (bboxRatio > targetRatio) {
    const newH = Math.round(gW / targetRatio);
    const expand = newH - gH;
    gMinY = Math.max(margin, gMinY - Math.floor(expand / 2));
    gMaxY = Math.min(cellH - margin - 1, gMinY + newH - 1);
    gH = gMaxY - gMinY + 1;
  }

  // Normalize to TMPL_W x TMPL_H using area-averaging
  const bitmap: number[] = new Array(TMPL_W * TMPL_H).fill(0);
  for (let ty = 0; ty < TMPL_H; ty++) {
    for (let tx = 0; tx < TMPL_W; tx++) {
      const x0 = cellX + gMinX + Math.floor(tx * gW / TMPL_W);
      const x1 = cellX + gMinX + Math.floor((tx + 1) * gW / TMPL_W);
      const y0 = cellY + gMinY + Math.floor(ty * gH / TMPL_H);
      const y1 = cellY + gMinY + Math.floor((ty + 1) * gH / TMPL_H);
      let sum = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
          const [r, g, b] = getPixel(img, x, y);
          sum += (r + g + b) / 3;
          count++;
        }
      }
      if (invertGlyph) {
        // Dark = glyph → invert so glyph=1
        bitmap[ty * TMPL_W + tx] = (count > 0 && sum / count < glyphThreshold) ? 1 : 0;
      } else {
        bitmap[ty * TMPL_W + tx] = (count > 0 && sum / count > glyphThreshold) ? 1 : 0;
      }
    }
  }

  return bitmap;
}
