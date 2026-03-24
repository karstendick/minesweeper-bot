/**
 * Vision pipeline: screenshot → 2D board state array.
 *
 * Architecture: skin detection first, then skin-specific pipeline.
 * Currently supports: Classic Windows Minesweeper / minesweeper.online
 */

import sharp from "sharp";

// OpenCV is no longer needed for the classic skin pipeline,
// but we keep the cvReady export for API compatibility.
export const cvReady: Promise<void> = Promise.resolve();

export type CellState =
  | "hidden"
  | "empty"
  | "flag"
  | "mine"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "unknown";

export interface BoardDetectionResult {
  board: CellState[][];
  gridBounds: { x: number; y: number; width: number; height: number };
  cellSize: { width: number; height: number };
  colBorders: number[];
  rowBorders: number[];
  rows: number;
  cols: number;
  skin: string;
}

interface ImageData {
  data: Buffer;
  width: number;
  height: number;
}

async function loadImageRaw(imagePath: string): Promise<ImageData> {
  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function getPixel(img: ImageData, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * 3;
  return [img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!];
}

// --- Skin detection ---

type Skin = "classic" | "clean-one" | "unknown";

/** "Minesweeper - The Clean One" hidden cells: orange ~(220,130,60) */
function isCleanOneOrange(r: number, g: number, b: number): boolean {
  return r >= 200 && r <= 240 && g >= 110 && g <= 150 && b >= 40 && b <= 80 && r - g > 70;
}

/** "The Clean One" dark background: neutral gray ~(50,50,50) */
function isCleanOneDark(r: number, g: number, b: number): boolean {
  return r >= 35 && r <= 65 && g >= 35 && g <= 65 && b >= 35 && b <= 65 &&
    Math.max(r, g, b) - Math.min(r, g, b) < 15;
}

export { type Skin };

export async function classifySkin(imagePath: string): Promise<Skin> {
  const img = await loadImageRaw(imagePath);
  return detectSkin(img);
}

function detectSkin(img: ImageData): Skin {
  let grayFace = 0;
  let grayBorder = 0;
  let orangePixels = 0;
  let darkPixels = 0;
  const sampleStep = 3;
  let total = 0;

  for (let y = 0; y < img.height; y += sampleStep) {
    for (let x = 0; x < img.width; x += sampleStep) {
      total++;
      const [r, g, b] = getPixel(img, x, y);

      // Clean One: orange hidden cells + dark background
      if (isCleanOneOrange(r, g, b)) orangePixels++;
      if (isCleanOneDark(r, g, b)) darkPixels++;
      const gray = (r + g + b) / 3;

      // Classic: gray face + gray border
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 15) {
        if (gray >= 185 && gray <= 205) grayFace++;
        if (gray >= 120 && gray <= 136) grayBorder++;
      }
    }
  }

  const classicGrayPct = grayFace / total;
  const borderPct = grayBorder / total;
  const orangePct = orangePixels / total;
  const darkPct = darkPixels / total;

  // Classic skin: lots of 198 gray + 128 borders
  if (classicGrayPct > 0.15 && borderPct > 0.01) {
    return "classic";
  }

  // Clean One: orange hidden cells + dark background
  if (orangePct > 0.08 && darkPct > 0.08) {
    return "clean-one";
  }

  return "unknown";
}

// --- Classic skin grid detection ---
// The classic skin has characteristic pixel values:
//   ~198 = revealed cell interior
//   ~128 = cell border (shadow side of bevel)
//   ~255 = cell bevel highlight
//   ~165 = anti-aliased transition between 128 and 198
// Cell borders (~128 value) appear at cellSize intervals.
// JPEG compression shifts these values by ±5, so we use tolerant matching.

const BORDER_TOL = 4;  // tolerance for 128 border gray
const FACE_TOL = 6;    // tolerance for 198 face gray
const WHITE_TOL = 8;   // tolerance for 255 highlight

function isBorderGray(r: number, g: number, b: number): boolean {
  return Math.abs(r - 128) <= BORDER_TOL &&
         Math.abs(g - 128) <= BORDER_TOL &&
         Math.abs(b - 128) <= BORDER_TOL &&
         Math.max(r, g, b) - Math.min(r, g, b) <= 6;
}

function isFaceGray(r: number, g: number, b: number): boolean {
  return Math.abs(r - 198) <= FACE_TOL &&
         Math.abs(g - 198) <= FACE_TOL &&
         Math.abs(b - 198) <= FACE_TOL &&
         Math.max(r, g, b) - Math.min(r, g, b) <= 8;
}

function isWhite(r: number, g: number, b: number): boolean {
  return r >= 255 - WHITE_TOL && g >= 255 - WHITE_TOL && b >= 255 - WHITE_TOL;
}

function detectClassicGrid(img: ImageData): {
  colBorders: number[]; rowBorders: number[]; cellSize: number; rows: number; cols: number;
} | null {
  const { width, height } = img;

  // Find cell size by scanning a horizontal line in the middle of the image.
  // Use a single row — horizontal borders are consistent across rows.
  const scanY = Math.floor(height / 2);
  const borderPositions: number[] = [];

  for (let x = 0; x < width; x++) {
    const [r, g, b] = getPixel(img, x, scanY);
    if (isBorderGray(r, g, b)) {
      borderPositions.push(x);
    }
  }

  // Cluster consecutive border pixels (borders can be 1-3px wide)
  const borderLines: number[] = [];
  let clusterStart = -10;
  for (const pos of borderPositions) {
    if (pos - clusterStart > 3) {
      borderLines.push(pos);
    }
    clusterStart = pos;
  }

  if (borderLines.length < 4) return null;

  // Find the dominant spacing = cell size
  const spacings = new Map<number, number>();
  for (let i = 1; i < borderLines.length; i++) {
    const s = borderLines[i]! - borderLines[i - 1]!;
    if (s >= 10 && s <= 150) {
      spacings.set(s, (spacings.get(s) ?? 0) + 1);
    }
  }

  if (spacings.size === 0) return null;

  let cellSize = 0;
  let bestCount = 0;
  for (const [s, count] of spacings) {
    // Count including neighbors ±1
    const total = count + (spacings.get(s - 1) ?? 0) + (spacings.get(s + 1) ?? 0);
    if (total > bestCount) {
      bestCount = total;
      cellSize = s;
    }
  }

  if (cellSize < 10 || bestCount < 5) return null;

  // Find grid origin and extent by scanning for consistent border lines
  // in both directions. Use the horizontal scan to find columns,
  // then do a vertical scan to find rows.

  // Filter to only borders at the dominant spacing.
  // Use maxSkip=3 for columns since numbers can create wider gaps.
  const gridCols = findGridLines(borderLines, cellSize, 3);
  if (gridCols.length < 4) return null;

  // Scan vertically across multiple cell-interior x-positions to find
  // horizontal row borders. Number text can interrupt 128 border pixels,
  // so we merge detections from several columns.
  const vBorderSet = new Set<number>();

  // Sample from several cells across the grid
  for (let colIdx = 0; colIdx < gridCols.length - 1; colIdx += Math.max(1, Math.floor(gridCols.length / 6))) {
    const scanX = Math.floor((gridCols[colIdx]! + gridCols[colIdx + 1]!) / 2);

    for (let y = 0; y < height; y++) {
      const [r, g, b] = getPixel(img, scanX, y);
      if (isBorderGray(r, g, b)) {
        vBorderSet.add(y);
      }
    }
  }

  // Cluster into border lines
  const vBorderLines: number[] = [];
  const sortedVBorders = [...vBorderSet].sort((a, b) => a - b);
  clusterStart = -10;
  for (const pos of sortedVBorders) {
    if (pos - clusterStart > 3) {
      vBorderLines.push(pos);
    }
    clusterStart = pos;
  }

  const gridRows = findGridLines(vBorderLines, cellSize);
  if (gridRows.length < 4) return null;

  // gridCols/gridRows contain the border lines between cells.
  // Add a border line before the first cell if there's board content there.
  const firstColX = gridCols[0]!;
  const firstRowY = gridRows[0]!;

  // Check if there's a cell before the first detected column border
  const cellBeforeCol = firstColX - cellSize;
  if (cellBeforeCol >= 0 && hasBoardContent(img, cellBeforeCol, firstRowY, cellSize)) {
    gridCols.unshift(cellBeforeCol);
  }

  // Check if there's a cell before the first detected row border
  const cellBeforeRow = firstRowY - cellSize;
  if (cellBeforeRow >= 0) {
    const midX = gridCols[Math.floor(gridCols.length / 2)]!;
    const [r, g, b] = getPixel(img, midX, cellBeforeRow);
    if (isBorderGray(r, g, b) && hasBoardContent(img, firstColX, cellBeforeRow, cellSize)) {
      gridRows.unshift(cellBeforeRow);
    }
  }

  // Extend the grid rightward/downward while there's board content.
  // Hidden cells at the edges don't have 128 borders, so findGridLines misses them.
  // Extend the grid rightward/downward while there's board content.
  // Hidden cells at the edges don't have 128 borders, so findGridLines misses them.
  // Stop at the frame border (128 pixels that span the full height/width).

  // Find the right frame border: scan rightward from last detected border
  // for a column of solid 128 pixels
  let rightFrame = width;
  for (let x = gridCols[gridCols.length - 1]! + cellSize; x < width; x++) {
    let is128count = 0;
    for (let y = gridRows[0]!; y < gridRows[gridRows.length - 1]!; y += 10) {
      const [r, g, b] = getPixel(img, x, y);
      if (isBorderGray(r, g, b)) is128count++;
    }
    // If most sampled pixels are 128, this is the frame border
    const totalSamples = Math.floor((gridRows[gridRows.length - 1]! - gridRows[0]!) / 10);
    if (is128count > totalSamples * 0.8) {
      rightFrame = x;
      break;
    }
  }

  // Find the bottom frame border similarly
  let bottomFrame = height;
  for (let y = gridRows[gridRows.length - 1]! + cellSize; y < height; y++) {
    let is128count = 0;
    for (let x = gridCols[0]!; x < gridCols[gridCols.length - 1]!; x += 10) {
      const [r, g, b] = getPixel(img, x, y);
      if (isBorderGray(r, g, b)) is128count++;
    }
    const totalSamples = Math.floor((gridCols[gridCols.length - 1]! - gridCols[0]!) / 10);
    if (is128count > totalSamples * 0.8) {
      bottomFrame = y;
      break;
    }
  }

  // Extend columns up to the frame border
  const midRow = gridRows[Math.floor(gridRows.length / 2)]!;
  while (true) {
    const lastX = gridCols[gridCols.length - 1]!;
    if (lastX + cellSize > rightFrame + 2) break;
    if (!hasBoardContent(img, lastX, midRow, cellSize)) break;
    gridCols.push(lastX + cellSize);
  }

  // Extend rows up to the frame border
  const midCol = gridCols[Math.floor(gridCols.length / 2)]!;
  while (true) {
    const lastY = gridRows[gridRows.length - 1]!;
    if (lastY + cellSize > bottomFrame + 2) break;
    if (!hasBoardContent(img, midCol, lastY, cellSize)) break;
    gridRows.push(lastY + cellSize);
  }

  const cols = gridCols.length - 1;
  const rows = gridRows.length - 1;

  if (rows < 3 || cols < 3 || rows > 50 || cols > 50) return null;

  // Return actual border positions (not computed from uniform cellSize).
  // This handles non-uniform cell sizes from resized screenshots.
  return {
    colBorders: gridCols.slice(0, cols + 1),
    rowBorders: gridRows.slice(0, rows + 1),
    cellSize, // nominal cell size (for reference)
    rows,
    cols,
  };
}

/**
 * Given a list of border line positions and the expected cell size,
 * find the longest consistent grid (lines at regular intervals).
 * Allows skipping up to `maxSkip` consecutive missing lines (where
 * number text interrupts the border pixel).
 */
function findGridLines(positions: number[], cellSize: number, maxSkip: number = 2): number[] {
  let bestGrid: number[] = [];

  for (let startIdx = 0; startIdx < positions.length; startIdx++) {
    const grid: number[] = [positions[startIdx]!];
    let lastPos = positions[startIdx]!;

    while (true) {
      // Try to find the next grid line, allowing up to maxSkip misses
      let found = false;
      for (let skip = 0; skip <= maxSkip; skip++) {
        const expected = lastPos + cellSize * (skip + 1);
        const match = positions.find((p) => Math.abs(p - expected) <= 2);
        if (match !== undefined) {
          // Fill in skipped positions with interpolated values
          for (let s = 1; s <= skip; s++) {
            grid.push(lastPos + cellSize * s);
          }
          grid.push(match);
          lastPos = match;
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    if (grid.length > bestGrid.length) {
      bestGrid = grid;
    }
  }

  return bestGrid;
}

/**
 * Check if a cell-sized region contains board content (198 gray or colored pixels)
 * as opposed to frame/header content (192 gray).
 */
function hasBoardContent(img: ImageData, cellX: number, cellY: number, cellSize: number): boolean {
  const inset = Math.floor(cellSize * 0.25);
  let count198 = 0;
  let countColor = 0;
  let count255 = 0;
  let total = 0;

  for (let dy = inset; dy < cellSize - inset; dy++) {
    for (let dx = inset; dx < cellSize - inset; dx++) {
      const x = cellX + dx;
      const y = cellY + dy;
      if (x < 0 || x >= img.width || y < 0 || y >= img.height) return false;
      const [r, g, b] = getPixel(img, x, y);
      total++;
      if (isFaceGray(r, g, b)) count198++;
      if (isWhite(r, g, b)) count255++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 20) countColor++;
    }
  }

  if (total === 0) return false;
  // Board cells have 198 background, or 255 bevel (hidden), or colored numbers
  return (count198 + countColor + count255) / total > 0.3;
}

/**
 * Snap raw detected grid dimensions to the nearest standard minesweeper size.
 * Standard sizes: 8x8, 9x9, 16x16, 16x30, 30x16, 20x24, 24x30, 30x24, 30x30.
 * Returns null if no standard size is close enough.
 */
function snapToStandardSize(rawCols: number, rawRows: number): { cols: number; rows: number } | null {
  const standardSizes = [
    { cols: 8, rows: 8 },
    { cols: 9, rows: 9 },
    { cols: 16, rows: 16 },
    { cols: 30, rows: 16 },
    { cols: 16, rows: 30 },
    { cols: 20, rows: 24 },
    { cols: 24, rows: 30 },
    { cols: 30, rows: 24 },
    { cols: 30, rows: 30 },
  ];

  // Allow up to 20% overshoot (extra border cells) but not undershoot
  let bestMatch: { cols: number; rows: number } | null = null;
  let bestScore = Infinity;

  for (const size of standardSizes) {
    const colDiff = rawCols - size.cols;
    const rowDiff = rawRows - size.rows;

    // Must have at least as many detected cells as the standard size
    if (colDiff < -1 || rowDiff < -1) continue;

    // Prefer smallest overshoot
    const score = Math.abs(colDiff) + Math.abs(rowDiff);
    if (score < bestScore) {
      bestScore = score;
      bestMatch = size;
    }
  }

  // Only snap if the match is close (within 8 cells total overshoot)
  if (bestMatch && bestScore <= 10) return bestMatch;

  return null;
}

// --- Classic skin cell classification ---
// Known exact colors for classic minesweeper numbers:
//   1 = (0, 0, 247)     bright blue
//   2 = (0, 119, 0)     green
//   3 = (236, 0, 0)     red
//   4 = (0, 0, 119)     dark blue
//   5 = (119, 0, 0)     maroon
//   6 = (0, 119, 119)   teal
//   7 = (0, 0, 0)       black
//   8 = (119, 119, 119) gray
// Flag = red (236, 0, 0) flag shape on gray
// Hidden = bevel pattern (255 highlight + 128 shadow + 198 face)
// Empty = flat 198 with 128 borders

interface ColorSignature {
  state: CellState;
  r: number;
  g: number;
  b: number;
}

const CLASSIC_COLORS: ColorSignature[] = [
  { state: "1", r: 0, g: 0, b: 247 },
  { state: "2", r: 0, g: 119, b: 0 },
  { state: "3", r: 236, g: 0, b: 0 },
  { state: "4", r: 0, g: 0, b: 119 },
  { state: "5", r: 119, g: 0, b: 0 },
  { state: "6", r: 0, g: 119, b: 119 },
  { state: "7", r: 0, g: 0, b: 0 },
  { state: "8", r: 119, g: 119, b: 119 },
];

function classifyClassicCell(
  img: ImageData,
  cellX: number,
  cellY: number,
  cellSize: number
): CellState {
  // Skip the border pixels (first/last 3px are bevel/border)
  const inset = 3;
  const innerX = cellX + inset;
  const innerY = cellY + inset;
  const innerSize = cellSize - 2 * inset;

  if (innerSize <= 0) return "unknown";

  // Check for hidden/flag cell: hidden cells have a raised bevel with
  // 255 (white) highlight pixels in the top-left interior.
  // Revealed cells have 198 gray or 128 borders there instead.
  // Sample a small region just inside the top-left corner.
  // Search the top-left quadrant for any 255 pixel (bevel highlight).
  // Also check that the cell face has 198 gray (not 192 which is frame).
  // Hidden/flag detection: scan rows near the top of the cell for
  // a solid white (255) bevel strip. Hidden cells have 2-3 rows of white
  // after the 128 border. Revealed cells go directly from 128 to 198.
  let maxWhiteInRow = 0;
  for (let dy = 2; dy < Math.min(8, cellSize); dy++) {
    let whites = 0;
    const y = cellY + dy;
    if (y >= img.height) continue;
    for (let dx = 2; dx < cellSize - 2; dx++) {
      const x = cellX + dx;
      if (x >= img.width) continue;
      const [r, g, b] = getPixel(img, x, y);
      if (isWhite(r, g, b)) whites++;
    }
    if (whites > maxWhiteInRow) maxWhiteInRow = whites;
  }

  // Hidden cells have a solid white strip — at least half the cell width
  const isHiddenBevel = maxWhiteInRow > cellSize / 3;

  if (isHiddenBevel) {
    // Check for flag: count red pixels in the cell interior
    let redPixels = 0;
    for (let dy = inset; dy < cellSize - inset; dy++) {
      for (let dx = inset; dx < cellSize - inset; dx++) {
        const x = cellX + dx;
        const y = cellY + dy;
        if (x >= img.width || y >= img.height) continue;
        const [r, g, b] = getPixel(img, x, y);
        if (r > 150 && g < 100 && b < 100) redPixels++;
      }
    }
    if (redPixels > 5) return "flag";
    return "hidden";
  }

  // Check for empty cell: all interior pixels are ~198
  let allGray = true;
  for (let dy = 1; dy < innerSize - 1; dy++) {
    for (let dx = 1; dx < innerSize - 1; dx++) {
      const [r, g, b] = getPixel(img, innerX + dx, innerY + dy);
      const colorfulness = Math.max(r, g, b) - Math.min(r, g, b);
      if (colorfulness > 10 || r < 150) {
        allGray = false;
        break;
      }
    }
    if (!allGray) break;
  }

  if (allGray) return "empty";

  // Number detection: find colored pixels and match to known number colors
  let bestMatch: CellState = "unknown";
  let bestScore = 0;

  // Collect all colored (non-gray) pixels in the cell
  const coloredPixels: [number, number, number][] = [];
  for (let dy = 1; dy < innerSize - 1; dy++) {
    for (let dx = 1; dx < innerSize - 1; dx++) {
      const pixel = getPixel(img, innerX + dx, innerY + dy);
      const [r, g, b] = pixel;
      const colorfulness = Math.max(r, g, b) - Math.min(r, g, b);
      const brightness = (r + g + b) / 3;
      // Non-gray and not background (198) or bevel (255/128)
      if ((colorfulness > 20 || brightness < 50) && !(r >= 190 && g >= 190 && b >= 190)) {
        coloredPixels.push(pixel);
      }
    }
  }

  if (coloredPixels.length === 0) return "empty";

  // Average the colored pixels
  let avgR = 0, avgG = 0, avgB = 0;
  for (const [r, g, b] of coloredPixels) {
    avgR += r;
    avgG += g;
    avgB += b;
  }
  avgR /= coloredPixels.length;
  avgG /= coloredPixels.length;
  avgB /= coloredPixels.length;

  // Match against known colors using Euclidean distance
  for (const sig of CLASSIC_COLORS) {
    const dist = Math.sqrt(
      (avgR - sig.r) ** 2 + (avgG - sig.g) ** 2 + (avgB - sig.b) ** 2
    );
    // Convert distance to score (closer = higher)
    const score = 1 / (1 + dist);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = sig.state;
    }
  }

  return bestMatch;
}

// --- Clean One grid detection ---
// "Minesweeper - The Clean One" has:
//   - Orange hidden cells ~(215,127,55)
//   - Dark revealed cells ~(51,51,51)
//   - Thin (~5px) grid lines between cells visible as R-channel dips in JPEG
//   - No visible grid lines between same-state cells in PNG
//   - Board extends edge-to-edge (may be clipped by screen)

function detectCleanOneGrid(img: ImageData): {
  colBorders: number[]; rowBorders: number[]; cellWidth: number; cellHeight: number; rows: number; cols: number;
} | null {
  const { width, height } = img;

  // Step 1: Find cell size via autocorrelation on the R-channel derivative
  // across the full image. Grid lines create periodic patterns regardless
  // of whether cells are hidden or revealed.
  const cellSize = findCleanOneCellSize(img);
  if (!cellSize) return null;

  const cellW = cellSize.w;
  const cellH = cellSize.h;

  // Step 2: Slide a cell-sized window across the image and classify each
  // position. A cell is "board" if it looks like hidden (orange) or
  // revealed (dark). This finds the board without needing to pre-compute bounds.
  // We scan at cell-pitch intervals starting from every possible offset.

  // Try all possible grid offsets (0 to cellW-1) and find the one where
  // the most cell-sized windows classify as board content.
  let bestOffX = 0, bestOffY = 0, bestBoardCount = 0;
  const offStep = Math.max(1, Math.floor(cellW / 8));

  for (let offX = 0; offX < cellW; offX += offStep) {
    for (let offY = 0; offY < cellH; offY += offStep) {
      let boardCount = 0;
      for (let cy = offY; cy + cellH <= height; cy += cellH) {
        for (let cx = offX; cx + cellW <= width; cx += cellW) {
          // Score cells that are cleanly orange OR cleanly dark (not mixed).
          // Well-aligned grids have pure cells; misaligned ones straddle boundaries.
          const inset = Math.floor(Math.min(cellW, cellH) * 0.2);
          let orangeCount = 0, darkCount = 0, sampled = 0;
          for (let dy = inset; dy < cellH - inset; dy += 4) {
            for (let dx = inset; dx < cellW - inset; dx += 4) {
              const px = cx + dx, py = cy + dy;
              if (px >= width || py >= height) continue;
              sampled++;
              const [r, g, b] = getPixel(img, px, py);
              if (isCleanOneOrange(r, g, b)) orangeCount++;
              else if (isCleanOneDark(r, g, b)) darkCount++;
            }
          }
          if (sampled < 4) continue;
          const oPct = orangeCount / sampled;
          const dPct = darkCount / sampled;
          // Cell is "clean" if it's mostly one type (>60% orange OR >60% dark)
          if (oPct > 0.6 || dPct > 0.6) boardCount++;
        }
      }
      if (boardCount > bestBoardCount) {
        bestBoardCount = boardCount;
        bestOffX = offX;
        bestOffY = offY;
      }
    }
  }

  if (bestBoardCount < 3) return null;

  // Step 3: With the best offset, find the rectangular extent of board cells.
  // Classify each grid position and find the bounding box of board cells.
  const maxCols = Math.floor((width - bestOffX) / cellW);
  const maxRows = Math.floor((height - bestOffY) / cellH);

  const isBoard: boolean[][] = [];
  for (let row = 0; row < maxRows; row++) {
    const rowArr: boolean[] = [];
    for (let col = 0; col < maxCols; col++) {
      const cx = bestOffX + col * cellW;
      const cy = bestOffY + row * cellH;
      rowArr.push(looksLikeBoardCell(img, cx, cy, cellW, cellH));
    }
    isBoard.push(rowArr);
  }

  // Find the largest rectangular region of board cells
  let minCol = maxCols, maxCol = 0, minRow = maxRows, maxRow = 0;
  for (let row = 0; row < maxRows; row++) {
    for (let col = 0; col < maxCols; col++) {
      if (isBoard[row]![col]) {
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

/** Find cell size via full-image R-channel derivative autocorrelation. */
function findCleanOneCellSize(img: ImageData): { w: number; h: number } | null {
  const { width, height } = img;

  // Horizontal projection: average R per column.
  // Try both derivative and raw autocorrelation — pick the one that gives
  // a stronger, more consistent result.
  const hProj: number[] = [];
  for (let x = 0; x < width; x++) {
    let sum = 0, count = 0;
    for (let y = 0; y < height; y += 3) {
      const [r] = getPixel(img, x, y);
      sum += r;
      count++;
    }
    hProj.push(sum / count);
  }
  const hDeriv: number[] = [];
  for (let i = 1; i < hProj.length; i++) {
    hDeriv.push(Math.abs(hProj[i]! - hProj[i - 1]!));
  }
  const cellW = bestAutocorrelationPeak(hDeriv, 30, 300);

  // Vertical projection: average R per row
  const vProj: number[] = [];
  for (let y = 0; y < height; y++) {
    let sum = 0, count = 0;
    for (let x = 0; x < width; x += 3) {
      const [r] = getPixel(img, x, y);
      sum += r;
      count++;
    }
    vProj.push(sum / count);
  }
  const vDeriv: number[] = [];
  for (let i = 1; i < vProj.length; i++) {
    vDeriv.push(Math.abs(vProj[i]! - vProj[i - 1]!));
  }
  const cellH = bestAutocorrelationPeak(vDeriv, 30, 300);

  if (cellW && cellH) return { w: cellW, h: cellH };
  if (cellW) return { w: cellW, h: cellW }; // assume square
  if (cellH) return { w: cellH, h: cellH };
  return null;
}

/** Find the strongest autocorrelation peak using cluster scoring. */
function bestAutocorrelationPeak(signal: number[], minPeriod: number, maxPeriod: number): number | null {
  const n = signal.length;
  const mean = signal.reduce((a, b) => a + b, 0) / n;
  const norm = signal.map((v) => v - mean);

  let ac0 = 0;
  for (const v of norm) ac0 += v * v;
  if (ac0 === 0) return null;

  // Compute autocorrelation for all lags
  const scores: number[] = [];
  for (let lag = minPeriod; lag <= Math.min(maxPeriod, Math.floor(n / 2)); lag++) {
    let ac = 0;
    for (let i = 0; i < n - lag; i++) ac += norm[i]! * norm[i + lag]!;
    scores.push(ac / ac0);
  }

  // Find all local maxima (peaks)
  const peaks: { lag: number; score: number }[] = [];
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i]! > scores[i - 1]! && scores[i]! > scores[i + 1]! && scores[i]! > 0.05) {
      peaks.push({ lag: minPeriod + i, score: scores[i]! });
    }
  }

  if (peaks.length === 0) return null;

  // Score peaks by combining their own strength with nearby peaks' strength.
  // True cell sizes have clusters of strong peaks around them; artifacts don't.
  // Use a ±10% window to accumulate support.
  let bestLag = peaks[0]!.lag;
  let bestSupport = 0;

  for (const p of peaks) {
    let support = 0;
    for (const q of peaks) {
      if (Math.abs(q.lag - p.lag) / p.lag < 0.1) {
        support += q.score;
      }
    }
    if (support > bestSupport) {
      bestSupport = support;
      bestLag = p.lag;
    }
  }

  // Within the winning cluster, pick the peak with the highest score
  const clusterPeaks = peaks.filter((p) => Math.abs(p.lag - bestLag) / bestLag < 0.1);
  clusterPeaks.sort((a, b) => b.score - a.score);

  return clusterPeaks[0]!.lag;
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
  // "1" (170px) — serif + vertical stroke
  { state: "1", bitmap:
    "0000000000000000" +
    "0000000000111110" +
    "0000000011111110" +
    "0000001111111110" +
    "0000111111111110" +
    "0011111110011110" +
    "0011110000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000001100"
  },
  // "1" (237px) — same shape, thicker strokes
  { state: "1", bitmap:
    "0000000000000000" +
    "0000000000000000" +
    "0000000000011110" +
    "0000000000111110" +
    "0000000001111110" +
    "0000000011111110" +
    "0000000111111110" +
    "0000001111111110" +
    "0000011111111110" +
    "0000111111111110" +
    "0001111111011110" +
    "0001111110011110" +
    "0011111100011110" +
    "0111111000011110" +
    "0011110000011110" +
    "0011100000011110" +
    "0001000000011110" +
    "0000000000011110" +
    "0000000000011110" +
    "0000000000011110"
  },
  // "2" (170px) — top curve, sweeps down-left, bottom bar
  { state: "2", bitmap:
    "0000000000000000" +
    "0000011111110000" +
    "0000111111111000" +
    "0001110000111100" +
    "0011100000001100" +
    "0011100000001110" +
    "0011000000001110" +
    "0000000000001110" +
    "0000000000011100" +
    "0000000000111100" +
    "0000000001111000" +
    "0000000011110000" +
    "0000000111100000" +
    "0000001111000000" +
    "0000111110000000" +
    "0001111000000000" +
    "0011110000000000" +
    "0111111111111110" +
    "0111111111111110" +
    "0000000000000000"
  },
  // "2" (237px) — same shape, thicker
  { state: "2", bitmap:
    "0000000000000000" +
    "0000000000000000" +
    "0000001111000000" +
    "0000011111110000" +
    "0000111111110000" +
    "0001111111111000" +
    "0001111111111100" +
    "0011110000111100" +
    "0011110000011100" +
    "0011100000011110" +
    "0011100000001110" +
    "0111100000001110" +
    "0111000000001110" +
    "0111000000001110" +
    "0111000000001110" +
    "0000000000001110" +
    "0000000000001110" +
    "0000000000001110" +
    "0000000000011110" +
    "0000000000011100"
  },
  // "3" (170px) — top bar, middle curve, bottom curve
  { state: "3", bitmap:
    "0000000000000000" +
    "0011111111111110" +
    "0011111111111110" +
    "0000000000111100" +
    "0000000000111000" +
    "0000000001110000" +
    "0000000011100000" +
    "0000000111000000" +
    "0000001111000000" +
    "0000011111111000" +
    "0000011111111100" +
    "0000000000011110" +
    "0000000000001110" +
    "0000000000000110" +
    "0010000000000110" +
    "0111000000001110" +
    "0011100000011110" +
    "0011111111111100" +
    "0001111111111000" +
    "0000000110000000"
  },
  // "3" (237px) — filled top half, narrowing bottom-right
  { state: "3", bitmap:
    "0000000000000000" +
    "0011111111111100" +
    "0111111111111110" +
    "0111111111111110" +
    "0111111111111110" +
    "0111111111111110" +
    "0011111111111110" +
    "0000000000111100" +
    "0000000000111100" +
    "0000000001111000" +
    "0000000001111000" +
    "0000000011110000" +
    "0000000011110000" +
    "0000000111110000" +
    "0000000111100000" +
    "0000000111000000" +
    "0000001111000000" +
    "0000001110000000" +
    "0000011111000000" +
    "0000011111110000"
  },
  // "4" (170px) — ascending diagonal + crossbar
  { state: "4", bitmap:
    "0000000000000000" +
    "0000000000111000" +
    "0000000001111000" +
    "0000000011111000" +
    "0000000111111000" +
    "0000000111111000" +
    "0000001110111000" +
    "0000011100111000" +
    "0000111100111000" +
    "0000111000111000" +
    "0001110000111000" +
    "0011100000111000" +
    "0111100000111000" +
    "0111111111111111" +
    "0111111111111110" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000111000" +
    "0000000000010000"
  },
  // "4" (237px) — filled triangle
  { state: "4", bitmap:
    "0000000000000000" +
    "0000000000000000" +
    "0000000000011100" +
    "0000000000111110" +
    "0000000000111110" +
    "0000000001111110" +
    "0000000001111110" +
    "0000000011111110" +
    "0000000011111110" +
    "0000000111111110" +
    "0000000111111110" +
    "0000001111111110" +
    "0000001111011110" +
    "0000011111011110" +
    "0000111110011110" +
    "0000111110011110" +
    "0001111100011110" +
    "0001111100011110" +
    "0011111000011110" +
    "0011110000011110"
  },
  // "5" (237px) — top bar, left stem, bottom curve
  { state: "5", bitmap:
    "0000000000000000" +
    "0001111111111100" +
    "0001111111111100" +
    "0001110000000000" +
    "0011100000000000" +
    "0011100000000000" +
    "0011100000000000" +
    "0011111111100000" +
    "0011111111111000" +
    "0011111111111100" +
    "0011100000011110" +
    "0000000000001110" +
    "0000000000000110" +
    "0000000000000110" +
    "0111000000000110" +
    "0111000000001110" +
    "0011110000011110" +
    "0001111111111100" +
    "0000111111110000" +
    "0000000000000000"
  },
  // "6" (standard shape)
  { state: "6", bitmap:
    "0000011111100000" +
    "0001111111110000" +
    "0011111000000000" +
    "0111110000000000" +
    "0111100000000000" +
    "0111100000000000" +
    "0111111111110000" +
    "0111111111111000" +
    "0111110000011100" +
    "0111100000001110" +
    "0111100000001110" +
    "0111100000001110" +
    "0111100000001110" +
    "0011110000011100" +
    "0001111111111000" +
    "0000111111110000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000"
  },
  // "7" (top bar, diagonal down-left)
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
  // "8" (two loops)
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

function classifyCleanOneCell(
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

    const gW = gMaxX - gMinX + 1;
    const gH = gMaxY - gMinY + 1;
    if (gW < 3 || gH < 3) return "empty";

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

// --- Main entry point ---

export async function detectBoard(imagePath: string): Promise<BoardDetectionResult | null> {
  await cvReady;
  const img = await loadImageRaw(imagePath);

  const skin = detectSkin(img);
  if (skin === "unknown") return null;

  if (skin === "classic") {
    const grid = detectClassicGrid(img);
    if (!grid) return null;

    const board: CellState[][] = [];
    for (let row = 0; row < grid.rows; row++) {
      const rowCells: CellState[] = [];
      const cellY = grid.rowBorders[row]!;
      const cellH = grid.rowBorders[row + 1]! - cellY;
      for (let col = 0; col < grid.cols; col++) {
        const cellX = grid.colBorders[col]!;
        const cellW = grid.colBorders[col + 1]! - cellX;
        const state = classifyClassicCell(img, cellX, cellY, Math.min(cellW, cellH));
        rowCells.push(state);
      }
      board.push(rowCells);
    }

    const x = grid.colBorders[0]!;
    const y = grid.rowBorders[0]!;
    const w = grid.colBorders[grid.cols]! - x;
    const h = grid.rowBorders[grid.rows]! - y;

    return {
      board,
      gridBounds: { x, y, width: w, height: h },
      cellSize: { width: grid.cellSize, height: grid.cellSize },
      colBorders: grid.colBorders,
      rowBorders: grid.rowBorders,
      rows: grid.rows,
      cols: grid.cols,
      skin: "classic",
    };
  }

  if (skin === "clean-one") {
    const grid = detectCleanOneGrid(img);
    if (!grid) return null;

    let board: CellState[][] = [];
    for (let row = 0; row < grid.rows; row++) {
      const rowCells: CellState[] = [];
      const cellY = grid.rowBorders[row]!;
      const cellH = grid.rowBorders[row + 1]! - cellY;
      for (let col = 0; col < grid.cols; col++) {
        const cellX = grid.colBorders[col]!;
        const cellW = grid.colBorders[col + 1]! - cellX;
        rowCells.push(classifyCleanOneCell(img, cellX, cellY, cellW, cellH));
      }
      board.push(rowCells);
    }

    // Trim rows/cols from edges that don't contain real board content.
    // Real board rows have hidden cells or recognized numbers.
    // Edge rows with only empty+unknown are likely app UI (header/footer).
    let { colBorders, rowBorders } = grid;
    let { rows, cols } = grid;

    // Trim edge rows/cols that have no confident cell classifications.
    // A row with only "unknown" and "empty" at the edge is likely app UI.
    // Real board rows have hidden cells, flags, or recognized numbers.
    function isNonBoardRow(r: CellState[]): boolean {
      return r.every((c) => c === "unknown" || c === "empty");
    }
    function isNonBoardCol(colIdx: number): boolean {
      return board.every((r) => r[colIdx] === "unknown" || r[colIdx] === "empty");
    }

    // Trim top rows
    while (rows > 0 && isNonBoardRow(board[0]!)) {
      board.shift();
      rowBorders = rowBorders.slice(1);
      rows--;
    }
    // Trim bottom rows
    while (rows > 0 && isNonBoardRow(board[rows - 1]!)) {
      board.pop();
      rowBorders = rowBorders.slice(0, -1);
      rows--;
    }
    // Trim left cols
    while (cols > 0 && isNonBoardCol(0)) {
      board = board.map((r) => r.slice(1));
      colBorders = colBorders.slice(1);
      cols--;
    }
    // Trim right cols
    while (cols > 0 && isNonBoardCol(cols - 1)) {
      board = board.map((r) => r.slice(0, -1));
      colBorders = colBorders.slice(0, -1);
      cols--;
    }

    if (rows < 3 || cols < 3) return null;

    const x = colBorders[0]!;
    const y = rowBorders[0]!;
    const w = colBorders[cols]! - x;
    const h = rowBorders[rows]! - y;

    return {
      board,
      gridBounds: { x, y, width: w, height: h },
      cellSize: { width: grid.cellWidth, height: grid.cellHeight },
      colBorders,
      rowBorders,
      rows,
      cols,
      skin: "clean-one",
    };
  }

  return null;
}
