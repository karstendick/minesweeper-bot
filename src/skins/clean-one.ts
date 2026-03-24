/**
 * "Minesweeper - The Clean One" skin detection and grid parsing.
 *
 * Characteristics:
 *   - Orange hidden cells ~(215,127,55)
 *   - Dark revealed cells ~(51,51,51)
 *   - Thin (~5px) grid lines between cells
 *   - Board extends edge-to-edge (may be clipped by screen)
 */

import { getPixel } from "../image-utils.js";
import { topAutocorrelationPeaks, computeProjection, computeDerivative, derivAlignScore, findBestOffset } from "../signal.js";
import type { CellState, ImageData } from "../types.js";

// --- Color predicates (also used by skin detection) ---

/** "Minesweeper - The Clean One" hidden cells: orange ~(220,130,60) */
export function isCleanOneOrange(r: number, g: number, b: number): boolean {
  return r >= 200 && r <= 240 && g >= 110 && g <= 150 && b >= 40 && b <= 80 && r - g > 70;
}

/** "The Clean One" dark background: neutral gray ~(50,50,50) */
export function isCleanOneDark(r: number, g: number, b: number): boolean {
  return r >= 35 && r <= 65 && g >= 35 && g <= 65 && b >= 35 && b <= 65 &&
    Math.max(r, g, b) - Math.min(r, g, b) < 15;
}


export function detectCleanOneGrid(img: ImageData): {
  colBorders: number[]; rowBorders: number[]; cellWidth: number; cellHeight: number; rows: number; cols: number;
} | null {
  const { width, height } = img;

  // Step 1: Find cell size via autocorrelation on the R-channel derivative
  // across the full image. Grid lines create periodic patterns regardless
  // of whether cells are hidden or revealed.
  const cellSize = findCleanOneCellSize(img);
  if (!cellSize) return null;

  // Refine the pitch by finding the value that best aligns actual
  // orange↔dark cell boundary transitions.
  const refinedSize = refineCellSize(img, cellSize.w, cellSize.h);
  const cellW = refinedSize.w;
  const cellH = refinedSize.h;

  // Step 2: Slide a cell-sized window across the image and classify each
  // position. A cell is "board" if it looks like hidden (orange) or
  // revealed (dark). This finds the board without needing to pre-compute bounds.
  // We scan at cell-pitch intervals starting from every possible offset.

  // Find the grid offset by maximizing the derivative signal at grid line
  // positions. The R-channel projection has edges at cell boundaries —
  // the offset where these edges align with the pitch gives the true grid.

  // Find the grid offset using derivative alignment.
  // Restrict projections to the middle 60% of the image to avoid UI ribbons
  // at the top/bottom which can shift the offset.
  const yStart = Math.floor(height * 0.2);
  const yEnd = Math.floor(height * 0.8);
  const xStart = Math.floor(width * 0.1);
  const xEnd = Math.floor(width * 0.9);

  // Horizontal offset: find where column-edges align with the pitch
  const hDerivOff = computeDerivative(computeProjection(img, "horizontal", yStart, yEnd));
  let bestOffX = findBestOffset(hDerivOff, cellW).offset;

  // Vertical offset: use per-column orange↔dark transitions (more precise
  // than the averaged derivative) combined with derivative for tiebreaking.
  const vYStart = Math.floor(height * 0.3);
  const vYEnd = Math.floor(height * 0.7);
  const vDerivOff = computeDerivative(computeProjection(img, "vertical", xStart, xEnd));

  const transitionYs: number[] = [];
  for (let x = xStart; x < xEnd; x += Math.max(1, Math.floor((xEnd - xStart) / 20))) {
    let prevIsOrange = false;
    for (let y = 1; y < height; y++) {
      const [r, g, b] = getPixel(img, x, y);
      const isOrange = isCleanOneOrange(r, g, b);
      const isDark = isCleanOneDark(r, g, b);
      if ((prevIsOrange && isDark) || (!prevIsOrange && isOrange && isDark === false)) {
        if (y > vYStart && y < vYEnd) transitionYs.push(y);
      }
      if (isOrange) prevIsOrange = true;
      else if (isDark) prevIsOrange = false;
    }
  }

  let bestOffY = 0, bestVScore = 0;
  for (let off = 0; off < cellH; off++) {
    let transScore = 0;
    for (const ty of transitionYs) {
      const nearestLine = Math.round((ty - off) / cellH) * cellH + off;
      if (Math.abs(ty - nearestLine) <= 3) transScore++;
    }
    const dScore = derivAlignScore(vDerivOff, cellH, vYStart, vYEnd);
    const combined = transScore * 100 + dScore;
    if (combined > bestVScore) { bestVScore = combined; bestOffY = off; }
  }

  // Step 3: With the best offset, find the rectangular extent of board cells.
  // Include partial cells before the offset (the board may extend to the edge).
  // startCol/startRow can be negative (partial cell before offset).
  const startCol = bestOffX > cellW * 0.3 ? -1 : 0;
  const startRow = bestOffY > cellH * 0.3 ? -1 : 0;
  const maxCols = Math.floor((width - bestOffX) / cellW);
  const maxRows = Math.floor((height - bestOffY) / cellH);

  const isBoard = new Map<string, boolean>();
  for (let row = startRow; row < maxRows; row++) {
    for (let col = startCol; col < maxCols; col++) {
      const cx = bestOffX + col * cellW;
      const cy = bestOffY + row * cellH;
      isBoard.set(`${col},${row}`, looksLikeBoardCell(img, cx, cy, cellW, cellH));
    }
  }

  // Find the bounding box of board cells
  let minCol = maxCols, maxCol = startCol, minRow = maxRows, maxRow = startRow;
  for (let row = startRow; row < maxRows; row++) {
    for (let col = startCol; col < maxCols; col++) {
      if (isBoard.get(`${col},${row}`)) {
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
      }
    }
  }

  const cols = maxCol - minCol + 1;
  const rows = maxRow - minRow + 1;
  if (cols < 3 || rows < 3 || cols > 50 || rows > 50) return null;

  // Compute border positions
  const colBorders: number[] = [];
  const rowBorders: number[] = [];
  for (let i = 0; i <= cols; i++) {
    colBorders.push(Math.round(bestOffX + (minCol + i) * cellW));
  }
  for (let i = 0; i <= rows; i++) {
    rowBorders.push(Math.round(bestOffY + (minRow + i) * cellH));
  }

  return { colBorders, rowBorders, cellWidth: cellW, cellHeight: cellH, rows, cols };
}

/** Check if a cell-sized region looks like board content (orange, dark, or number glyph). */
function looksLikeBoardCell(img: ImageData, cx: number, cy: number, cellW: number, cellH: number): boolean {
  const insetX = Math.floor(cellW * 0.2);
  const insetY = Math.floor(cellH * 0.2);
  let boardPixels = 0, sampled = 0;

  for (let dy = insetY; dy < cellH - insetY; dy += 4) {
    for (let dx = insetX; dx < cellW - insetX; dx += 4) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
      sampled++;
      const [r, g, b] = getPixel(img, x, y);
      // Board cells are orange (hidden) or dark gray (revealed bg).
      // Number glyphs and flag icons are small relative to the bg.
      if (isCleanOneOrange(r, g, b) || isCleanOneDark(r, g, b)) {
        boardPixels++;
      }
    }
  }

  return sampled > 4 && boardPixels / sampled > 0.6;
}

/** Refine cell pitch by sweeping ±3px and maximizing orange↔dark cell boundary alignment. */
function refineCellSize(img: ImageData, approxW: number, approxH: number): { w: number; h: number } {
  const { width, height } = img;

  // Collect genuine orange↔dark cell boundary positions.
  // Track runs of orange/dark pixels; a boundary occurs when switching
  // between types after a sustained run. "Other" pixels (glyph content,
  // separators) don't reset the run — they're ignored.
  function collectBoundaries(scanHorizontal: boolean): number[] {
    const boundaries: number[] = [];
    const outerStart = scanHorizontal ? Math.floor(height * 0.2) : Math.floor(width * 0.1);
    const outerEnd = scanHorizontal ? Math.floor(height * 0.8) : Math.floor(width * 0.9);
    const innerMax = scanHorizontal ? width : height;
    const step = Math.max(1, Math.floor((outerEnd - outerStart) / 20));
    const runMin = 3;

    for (let outer = outerStart; outer < outerEnd; outer += step) {
      let orangeRun = 0, darkRun = 0;
      for (let inner = 0; inner < innerMax; inner++) {
        const x = scanHorizontal ? inner : outer;
        const y = scanHorizontal ? outer : inner;
        const [r, g, b] = getPixel(img, x, y);

        if (isCleanOneOrange(r, g, b)) {
          if (darkRun >= runMin) boundaries.push(inner);
          orangeRun++;
          darkRun = 0;
        } else if (isCleanOneDark(r, g, b)) {
          if (orangeRun >= runMin) boundaries.push(inner);
          darkRun++;
          orangeRun = 0;
        }
        // Don't reset on "other" pixels — allow small gaps from separators
      }
    }
    return boundaries;
  }

  function bestPitch(boundaries: number[], approx: number): number {
    let bestP = approx, bestScore = 0;
    for (let p = approx - 3; p <= approx + 3; p++) {
      // Find best offset for this pitch
      let bestOffScore = 0;
      for (let off = 0; off < p; off++) {
        let score = 0;
        for (const t of boundaries) {
          const nearest = Math.round((t - off) / p) * p + off;
          if (Math.abs(t - nearest) <= 3) score++;
        }
        if (score > bestOffScore) bestOffScore = score;
      }
      if (bestOffScore > bestScore) { bestScore = bestOffScore; bestP = p; }
    }
    return bestP;
  }

  // Horizontal scan finds vertical cell boundaries (columns)
  const hBoundaries = collectBoundaries(true);
  // Vertical scan finds horizontal cell boundaries (rows)
  const vBoundaries = collectBoundaries(false);

  const w = hBoundaries.length > 5 ? bestPitch(hBoundaries, approxW) : approxW;
  const h = vBoundaries.length > 5 ? bestPitch(vBoundaries, approxH) : approxH;

  return { w, h };
}

/** Find cell size via autocorrelation + derivative alignment validation. */
function findCleanOneCellSize(img: ImageData): { w: number; h: number } | null {
  const { width, height } = img;

  // Compute R-channel projections and derivatives (full image)
  const hDeriv = computeDerivative(computeProjection(img, "horizontal", 0, height));
  const vDeriv = computeDerivative(computeProjection(img, "vertical", 0, width));

  // Get candidate pitches from autocorrelation peaks
  const hCandidates = topAutocorrelationPeaks(hDeriv, 30, 300, 5);
  const vCandidates = topAutocorrelationPeaks(vDeriv, 30, 300, 5);

  // Pick the best pitch from candidates. Use derivative alignment to verify:
  // for each candidate, check if a multiple (2x, 3x) has a higher per-line
  // score, which would indicate the candidate is a sub-harmonic.
  // Pick the best pitch. The autocorrelation's top candidate (candidates[0])
  // is usually right, but may be a sub-harmonic. Use derivative alignment
  // to check: if a candidate's 2x or 3x multiple is also a candidate AND
  // has strong derivative alignment, the original is a sub-harmonic — use the multiple.
  function bestPitchFromCandidates(deriv: number[], candidates: number[]): number | null {
    if (candidates.length === 0) return null;

    // Score all candidates with derivative alignment
    const scored = candidates.map(p => ({ pitch: p, score: derivAlignScore(deriv, p) }));
    scored.sort((a, b) => b.score - a.score);

    // Start with the highest derivative score
    let best = scored[0]!.pitch;

    // Check if best is a sub-harmonic by seeing if a LARGER candidate is
    // a clean multiple of best. Sub-harmonics score high because every real
    // grid edge is also at sub-harmonic intervals.
    for (const s of scored) {
      if (s.pitch <= best) continue;
      const ratio = s.pitch / best;
      const nearInt = Math.round(ratio);
      if (nearInt >= 2 && nearInt <= 5 && Math.abs(ratio - nearInt) < 0.15) {
        // s.pitch is a potential true pitch. If it has reasonable score,
        // prefer it (it's the fundamental, best was a sub-harmonic).
        if (s.score > scored[0]!.score * 0.6) {
          best = s.pitch;
          break;
        }
      }
    }

    return best;
  }

  // Test all candidates from both dimensions against both derivatives.
  // This finds the pitch that works well in both directions.
  const allCandidates = [...new Set([...hCandidates, ...vCandidates])];
  const w = bestPitchFromCandidates(hDeriv, allCandidates);
  const h = bestPitchFromCandidates(vDeriv, allCandidates);

  // Clean One cells are roughly square.
  if (w && h) {
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio < 1.08) {
      // Very close — use as-is
      return { w, h };
    }
    // They disagree. Check if one is a harmonic of the other.
    const nearInt = Math.round(ratio);
    if (nearInt >= 2 && Math.abs(ratio - nearInt) < 0.2) {
      // One is a harmonic. Use the smaller value for both.
      const smaller = Math.min(w, h);
      return { w: smaller, h: smaller };
    }
    // Neither close nor harmonic — find a pitch that appears as a candidate
    // in both dimensions (most likely to be the true cell size).
    const vSet = new Set(vCandidates);
    for (const c of hCandidates) {
      if (vSet.has(c)) return { w: c, h: c };
    }
    // Fallback: use whichever dimension has a stronger autocorrelation signal
    const wScore = derivAlignScore(hDeriv, w) + derivAlignScore(vDeriv, w);
    const hScore = derivAlignScore(hDeriv, h) + derivAlignScore(vDeriv, h);
    const best = wScore > hScore ? w : h;
    return { w: best, h: best };
  }
  if (w) return { w, h: w };
  if (h) return { w: h, h };
  return null;
}




// --- Clean One cell classification ---
// Hidden: orange ~(215, 127, 55)
// Revealed empty: dark ~(51, 51, 51)
// Revealed numbers: gray/white text on dark background (all numbers same color)
// Flag: flag icon on orange background
//
// Number recognition uses template matching since all digits are the same color.
// We extract the bright region, normalize its bounding box to 8x10, and match.

// Templates are 16 wide x 20 tall binary bitmaps.
// Extracted from actual cluster-based bbox-normalized cell bitmaps.
// The cluster approach finds the densest group of bright pixels (the digit)
// and normalizes that region to the template size using area-averaging.
const CLEAN_ONE_TEMPLATES: { state: CellState; bitmap: string }[] = [
  // "1" — serif + vertical stroke
  { state: "1", bitmap:
    "0000000000000000" +
    "0000000001111000" +
    "0000000011111000" +
    "0000001111111000" +
    "0000011111111000" +
    "0000111100111000" +
    "0000111000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000010000"
  },
  // "2" — top curve, sweeps down-left, bottom bar
  { state: "2", bitmap:
    "0000000000000000" +
    "0000011111100000" +
    "0000111111110000" +
    "0001110000111000" +
    "0011100000011100" +
    "0011100000011100" +
    "0011000000011100" +
    "0000000000011100" +
    "0000000000011100" +
    "0000000000111000" +
    "0000000001111000" +
    "0000000011110000" +
    "0000000111000000" +
    "0000001110000000" +
    "0000111100000000" +
    "0001111000000000" +
    "0011110000000000" +
    "0011111111111100" +
    "0011111111111100" +
    "0000000000000000"
  },
  // "3" — top bar, middle curve, bottom curve
  { state: "3", bitmap:
    "0000000000000000" +
    "0011111111111100" +
    "0011111111111100" +
    "0000000000111100" +
    "0000000001111000" +
    "0000000011110000" +
    "0000000011100000" +
    "0000000111000000" +
    "0000001111000000" +
    "0000011111110000" +
    "0000011111111100" +
    "0000000000011100" +
    "0000000000001110" +
    "0000000000001110" +
    "0010000000001110" +
    "0011000000001110" +
    "0011100000011100" +
    "0001111111111000" +
    "0000111111110000" +
    "0000000110000000"
  },
  // "4" — ascending diagonal + crossbar
  { state: "4", bitmap:
    "0000000000000000" +
    "0000000000111000" +
    "0000000001111000" +
    "0000000011111000" +
    "0000000111111000" +
    "0000001111111000" +
    "0000001110111000" +
    "0000011100111000" +
    "0000111100111000" +
    "0001111000111000" +
    "0001110000111000" +
    "0011100000111000" +
    "0111101111111110" +
    "0111111111111111" +
    "0111111111111110" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000000000"
  },
  // "5" — top bar, LEFT stem, then bottom curve
  { state: "5", bitmap:
    "0000000000000000" +
    "0001111111111100" +
    "0001111111111100" +
    "0001110000000000" +
    "0001100000000000" +
    "0001100000000000" +
    "0001100000000000" +
    "0001111111100000" +
    "0001111111111000" +
    "0011111000111100" +
    "0001100000011100" +
    "0000000000001110" +
    "0000000000001110" +
    "0000000000001110" +
    "0011000000001110" +
    "0011100000001100" +
    "0011110000111100" +
    "0001111111111000" +
    "0000011111110000" +
    "0000000000000000"
  },
  // "6" — descending top curve, bottom loop
  { state: "6", bitmap:
    "0000000000000000" +
    "0000000111000000" +
    "0000000111000000" +
    "0000001110000000" +
    "0000011100000000" +
    "0000111000000000" +
    "0000111000000000" +
    "0001111111100000" +
    "0001111111111000" +
    "0011110000111000" +
    "0011000000011100" +
    "0111000000001100" +
    "0111000000001100" +
    "0111000000001100" +
    "0111000000001100" +
    "0111000000011100" +
    "0011110000111000" +
    "0001111111110000" +
    "0000011111100000" +
    "0000000000000000"
  },
  // "7" — top bar, diagonal down-left
  { state: "7", bitmap:
    "1111111111111110" +
    "1111111111111110" +
    "0000000000111000" +
    "0000000001110000" +
    "0000000001110000" +
    "0000000011100000" +
    "0000000011100000" +
    "0000000111000000" +
    "0000000111000000" +
    "0000001110000000" +
    "0000001110000000" +
    "0000011100000000" +
    "0000011100000000" +
    "0000111000000000" +
    "0000111000000000" +
    "0001110000000000" +
    "0001110000000000" +
    "0011100000000000" +
    "0011100000000000" +
    "0111000000000000"
  },
  // "8" — two loops
  { state: "8", bitmap:
    "0000111111100000" +
    "0001111111110000" +
    "0011110000111000" +
    "0111100000011100" +
    "0111100000011100" +
    "0011110000111000" +
    "0001111111110000" +
    "0001111111110000" +
    "0011110000111000" +
    "0111100000011100" +
    "0111100000011100" +
    "0111100000011100" +
    "0111100000011100" +
    "0011110000111000" +
    "0001111111110000" +
    "0000111111100000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000"
  },
];

const TMPL_W = 16;
const TMPL_H = 20;

function matchCleanOneDigit(bitmap: number[]): CellState {
  let bestState: CellState = "unknown";
  let bestScore = -Infinity;

  for (const tmpl of CLEAN_ONE_TEMPLATES) {
    // Normalized cross-correlation
    let sumAB = 0, sumAA = 0, sumBB = 0;
    const n = TMPL_W * TMPL_H;
    // Compute means
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

  // Require minimum correlation
  if (bestScore < 0.25) return "unknown";
  return bestState;
}

export function classifyCleanOneCell(
  img: ImageData,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
): CellState {
  // Sample the inner region (skip ~20% border to avoid grid lines)
  const insetX = Math.floor(cellW * 0.2);
  const insetY = Math.floor(cellH * 0.2);
  const innerW = cellW - 2 * insetX;
  const innerH = cellH - 2 * insetY;
  if (innerW <= 2 || innerH <= 2) return "unknown";

  // Classify pixels into categories:
  // - orange: hidden cell background (R~215, G~127, B~55)
  // - dark: revealed cell background (gray 35-65)
  // - glyph: number/icon pixels on revealed background (gray 66-200, or colored)
  // - bright: very bright pixels (gray >200, e.g. white highlights)
  let orangeCount = 0;
  let darkCount = 0;
  let glyphCount = 0;  // medium gray or colored — number text, flag icons
  let total = 0;
  let redCount = 0;    // for flag detection

  for (let dy = 0; dy < innerH; dy += 2) {
    for (let dx = 0; dx < innerW; dx += 2) {
      const x = cellX + insetX + dx;
      const y = cellY + insetY + dy;
      if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
      total++;
      const [r, g, b] = getPixel(img, x, y);
      const gray = (r + g + b) / 3;

      if (isCleanOneOrange(r, g, b)) {
        orangeCount++;
      } else if (gray <= 65 && Math.max(r, g, b) - Math.min(r, g, b) < 20) {
        darkCount++;
      } else if (gray > 65) {
        glyphCount++;
        if (r > 150 && g < 80 && b < 80) redCount++;
      }
    }
  }

  if (total === 0) return "unknown";

  const orangePct = orangeCount / total;
  const darkPct = darkCount / total;
  const glyphPct = glyphCount / total;
  const boardPct = orangePct + darkPct + glyphPct;

  // If most pixels aren't recognizable, this isn't a cell
  if (boardPct < 0.6) return "unknown";

  // Mostly orange = hidden or flag
  if (orangePct > 0.6) {
    // Check for flag: flags have red pixels on orange background
    if (redCount > 5) return "flag";
    return "hidden";
  }

  // Revealed cell: mostly dark + some glyph pixels
  if (darkPct + glyphPct > 0.5 && orangePct < 0.3) {
    // Very few glyph pixels = empty revealed cell
    if (glyphPct < 0.03) return "empty";

    // Distinguish flags from numbers by glyph brightness:
    // Numbers are rendered bright white (~200-240 gray)
    // Flags are rendered medium gray (~90-110 gray)
    let brightGlyphs = 0, dimGlyphs = 0;
    for (let dy = 0; dy < innerH; dy += 3) {
      for (let dx = 0; dx < innerW; dx += 3) {
        const x = cellX + insetX + dx;
        const y = cellY + insetY + dy;
        if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
        const [r, g, b] = getPixel(img, x, y);
        const gray = (r + g + b) / 3;
        if (gray > 170) brightGlyphs++;
        else if (gray > 65) dimGlyphs++;
      }
    }

    // Flag detection: flags are dominated by gray ~100 icon pixels (>15% of cell).
    // A few scattered gray pixels from grid separators don't count.
    if (glyphPct > 0.15 && dimGlyphs > brightGlyphs * 5 && brightGlyphs < 5) return "flag";

    // Has glyph pixels = number. Find the digit by locating the densest
    // cluster of bright pixels, then normalize that region to TMPL_W x TMPL_H
    // using area-averaging. This works across all cell sizes.

    const margin = Math.floor(Math.min(cellW, cellH) * 0.08);

    // Compute threshold
    let bgSum = 0, bgCount = 0;
    for (let dy = margin; dy < cellH - margin; dy += 5) {
      for (let dx = margin; dx < cellW - margin; dx += 5) {
        const x = cellX + dx, y = cellY + dy;
        if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
        const [r, g, b] = getPixel(img, x, y);
        const gray = (r + g + b) / 3;
        if (gray < 100) { bgSum += gray; bgCount++; }
      }
    }
    const bgLevel = bgCount > 0 ? bgSum / bgCount : 51;
    const glyphThreshold = bgLevel + (220 - bgLevel) * 0.5;

    // Collect all bright pixel positions
    const brightPts: { x: number; y: number }[] = [];
    for (let dy = margin; dy < cellH - margin; dy += 2) {
      for (let dx = margin; dx < cellW - margin; dx += 2) {
        const x = cellX + dx, y = cellY + dy;
        if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
        const [r, g, b] = getPixel(img, x, y);
        if ((r + g + b) / 3 > glyphThreshold) {
          brightPts.push({ x: dx, y: dy });
        }
      }
    }

    if (brightPts.length < 3) return "empty";

    // Find the densest cluster: compute the centroid, then keep only points
    // within a radius of the digit size (expected ~15-30% of cell width).
    const maxRadius = Math.floor(Math.min(cellW, cellH) * 0.25);

    // Use iterative centroid: start from the median point, then refine
    let cx = brightPts.map(p => p.x).sort((a, b) => a - b)[Math.floor(brightPts.length / 2)]!;
    let cy = brightPts.map(p => p.y).sort((a, b) => a - b)[Math.floor(brightPts.length / 2)]!;

    for (let iter = 0; iter < 3; iter++) {
      const nearby = brightPts.filter(p =>
        Math.abs(p.x - cx) < maxRadius && Math.abs(p.y - cy) < maxRadius
      );
      if (nearby.length === 0) break;
      cx = Math.round(nearby.reduce((s, p) => s + p.x, 0) / nearby.length);
      cy = Math.round(nearby.reduce((s, p) => s + p.y, 0) / nearby.length);
    }

    // Get the bbox of points near the centroid
    const cluster = brightPts.filter(p =>
      Math.abs(p.x - cx) < maxRadius && Math.abs(p.y - cy) < maxRadius
    );
    if (cluster.length < 3) return "empty";

    let gMinX = cellW, gMaxX = 0, gMinY = cellH, gMaxY = 0;
    for (const p of cluster) {
      if (p.x < gMinX) gMinX = p.x;
      if (p.x > gMaxX) gMaxX = p.x;
      if (p.y < gMinY) gMinY = p.y;
      if (p.y > gMaxY) gMaxY = p.y;
    }

    // Add small padding around the digit
    const pad = Math.max(2, Math.floor(Math.min(cellW, cellH) * 0.02));
    gMinX = Math.max(margin, gMinX - pad);
    gMaxX = Math.min(cellW - margin - 1, gMaxX + pad);
    gMinY = Math.max(margin, gMinY - pad);
    gMaxY = Math.min(cellH - margin - 1, gMaxY + pad);

    let gW = gMaxX - gMinX + 1;
    let gH = gMaxY - gMinY + 1;
    if (gW < 3 || gH < 3) return "empty";

    // Pad the bbox to match the template aspect ratio (TMPL_W:TMPL_H).
    // This ensures consistent digit proportions regardless of the original
    // bbox shape, so one template works at all cell sizes.
    const targetRatio = TMPL_W / TMPL_H; // 0.8
    const bboxRatio = gW / gH;
    if (bboxRatio < targetRatio) {
      // Too tall — widen
      const newW = Math.round(gH * targetRatio);
      const expand = newW - gW;
      gMinX = Math.max(margin, gMinX - Math.floor(expand / 2));
      gMaxX = Math.min(cellW - margin - 1, gMinX + newW - 1);
      gW = gMaxX - gMinX + 1;
    } else if (bboxRatio > targetRatio) {
      // Too wide — heighten
      const newH = Math.round(gW / targetRatio);
      const expand = newH - gH;
      gMinY = Math.max(margin, gMinY - Math.floor(expand / 2));
      gMaxY = Math.min(cellH - margin - 1, gMinY + newH - 1);
      gH = gMaxY - gMinY + 1;
    }

    // Normalize the digit region to TMPL_W x TMPL_H using area-averaging
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
        bitmap[ty * TMPL_W + tx] = (count > 0 && sum / count > glyphThreshold) ? 1 : 0;
      }
    }

    return matchCleanOneDigit(bitmap);
  }

  return "unknown";
}
