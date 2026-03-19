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

type Skin = "classic" | "unknown";

function detectSkin(img: ImageData): Skin {
  // Classic skin: dominant gray value is 192 or 198
  // Count pixels at key gray values (with JPEG tolerance)
  let grayFace = 0;   // ~192-200 (cell face / frame)
  let grayBorder = 0; // ~128 (cell borders)
  const sampleStep = 3;

  for (let y = 0; y < img.height; y += sampleStep) {
    for (let x = 0; x < img.width; x += sampleStep) {
      const [r, g, b] = getPixel(img, x, y);
      if (Math.max(r, g, b) - Math.min(r, g, b) > 15) continue; // skip colored
      const gray = Math.round((r + g + b) / 3);
      if (gray >= 185 && gray <= 205) grayFace++;
      if (gray >= 120 && gray <= 136) grayBorder++;
    }
  }

  const totalSampled = Math.floor(img.width / sampleStep) * Math.floor(img.height / sampleStep);
  const classicGrayPct = grayFace / totalSampled;
  const borderPct = grayBorder / totalSampled;

  // Classic skin: >20% of pixels are face gray, with some border gray
  if (classicGrayPct > 0.15 && borderPct > 0.01) {
    return "classic";
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

  return null;
}
