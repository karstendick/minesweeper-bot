/**
 * Test vision pipeline against ground truth files.
 * Reports per-cell accuracy, ignoring cells marked as '?' in ground truth.
 *
 * Usage:
 *   npx tsx scripts/test-ground-truth.ts              — test all ground truth files
 *   npx tsx scripts/test-ground-truth.ts <image>      — test one image
 *
 * Ground truth format: one file per image in data/ground-truth/<filename>.txt
 * Characters: . = hidden, F = flag, (space) = empty, 1-8 = numbers, ? = don't care
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectBoard, type CellState } from "../src/vision.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");
const GT_DIR = join(import.meta.dirname, "..", "data", "ground-truth");

const charMap: Record<string, CellState> = {
  ".": "hidden",
  " ": "empty",
  "F": "flag",
  "*": "mine",
  "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8",
};

const reverseCharMap: Record<CellState, string> = {
  hidden: ".", empty: " ", flag: "F", mine: "*", unknown: "?",
  "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8",
};

function parseGroundTruth(text: string): (CellState | null)[][] {
  return text.trimEnd().split("\n").map(line => {
    return [...line].map(ch => {
      if (ch === "?") return null; // don't care
      return charMap[ch] ?? null;
    });
  });
}

const specificFile = process.argv[2];
const gtFiles = specificFile
  ? [`${specificFile.replace(/.*\//, "")}.txt`]
  : readdirSync(GT_DIR).filter(f => f.endsWith(".txt"));

let totalCorrect = 0, totalWrong = 0, totalSkipped = 0;
let allPassed = true;

for (const gtFile of gtFiles) {
  const imageName = gtFile.replace(".txt", "");
  const gtPath = join(GT_DIR, gtFile);
  const imagePath = join(IMAGES_DIR, imageName);

  const gtText = readFileSync(gtPath, "utf-8");
  const gt = parseGroundTruth(gtText);

  const result = await detectBoard(imagePath);

  if (!result) {
    console.log(`\n❌ ${imageName}: No grid detected`);
    allPassed = false;
    continue;
  }

  // Compare
  const gtRows = gt.length;
  const gtCols = Math.max(...gt.map(r => r.length));
  let correct = 0, wrong = 0, skipped = 0;
  const errors: string[] = [];

  // Allow slight size mismatches — find the best alignment offset.
  // The detected grid may have extra edge rows/cols or be missing some.
  let bestDr = 0, bestDc = 0, bestAlignScore = -1;
  const maxShift = 3;
  for (let dr = -maxShift; dr <= maxShift; dr++) {
    for (let dc = -maxShift; dc <= maxShift; dc++) {
      let score = 0;
      for (let row = 0; row < gtRows; row++) {
        for (let col = 0; col < (gt[row]?.length ?? 0); col++) {
          const expected = gt[row]![col];
          if (expected === null) continue;
          const detRow = row + dr;
          const detCol = col + dc;
          if (detRow < 0 || detRow >= result.rows || detCol < 0 || detCol >= result.cols) continue;
          if (result.board[detRow]![detCol] === expected) score++;
        }
      }
      if (score > bestAlignScore) { bestAlignScore = score; bestDr = dr; bestDc = dc; }
    }
  }

  if (result.rows !== gtRows || result.cols !== gtCols) {
    console.log(`\n⚠️  ${imageName}: Grid size mismatch — detected ${result.cols}x${result.rows}, expected ${gtCols}x${gtRows} (aligned with offset row=${bestDr} col=${bestDc})`);
  }

  for (let row = 0; row < gtRows; row++) {
    for (let col = 0; col < (gt[row]?.length ?? 0); col++) {
      const expected = gt[row]![col];
      if (expected === null) { skipped++; continue; }

      const detRow = row + bestDr;
      const detCol = col + bestDc;
      if (detRow < 0 || detRow >= result.rows || detCol < 0 || detCol >= result.cols) {
        wrong++;
        const expChar = reverseCharMap[expected] ?? "?";
        errors.push(`  (${col},${row}): expected '${expChar}' (${expected}), got OUT OF BOUNDS`);
        continue;
      }
      const detected = result.board[detRow]![detCol] ?? "unknown";

      if (detected === expected) {
        correct++;
      } else {
        wrong++;
        const expChar = reverseCharMap[expected] ?? "?";
        const detChar = reverseCharMap[detected] ?? "?";
        errors.push(`  (${col},${row}): expected '${expChar}' (${expected}), got '${detChar}' (${detected})`);
      }
    }
  }

  const total = correct + wrong;
  const pct = total > 0 ? ((correct / total) * 100).toFixed(1) : "N/A";
  const status = wrong === 0 ? "✅" : "❌";

  if (wrong > 0) allPassed = false;

  console.log(`\n${status} ${imageName}: ${correct}/${total} correct (${pct}%), ${skipped} skipped`);
  if (errors.length > 0) {
    for (const e of errors) console.log(e);
  }

  totalCorrect += correct;
  totalWrong += wrong;
  totalSkipped += skipped;
}

console.log(`\n${"=".repeat(50)}`);
const totalCells = totalCorrect + totalWrong;
const totalPct = totalCells > 0 ? ((totalCorrect / totalCells) * 100).toFixed(1) : "N/A";
console.log(`Total: ${totalCorrect}/${totalCells} correct (${totalPct}%), ${totalSkipped} skipped`);
console.log(allPassed ? "✅ All tests passed!" : "❌ Some tests failed.");
process.exit(allPassed ? 0 : 1);
