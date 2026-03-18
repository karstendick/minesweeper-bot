/**
 * Checks which image posts failed to download and diagnoses why.
 * Usage: npx tsx scripts/check-failed-downloads.ts
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const CACHE_PATH = join(DATA_DIR, "subreddit-posts.json");
const IMAGES_DIR = join(DATA_DIR, "images");

interface RedditPost {
  id: string;
  title: string;
  url: string;
  created_utc: number;
  domain: string;
  post_hint?: string;
  is_gallery?: boolean;
  author: string;
}

const cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
const posts: RedditPost[] = cache.posts;

const downloadedIds = new Set(
  readdirSync(IMAGES_DIR).map((f) => f.replace(/\.[^.]+$/, ""))
);

const imagePosts = posts.filter(
  (p) =>
    !p.is_gallery &&
    (p.post_hint === "image" ||
      p.domain === "i.redd.it" ||
      /\.(png|jpg|jpeg|gif|webp)$/i.test(p.url))
);

const missing = imagePosts.filter((p) => !downloadedIds.has(p.id));

console.log(`Total direct image posts: ${imagePosts.length}`);
console.log(`Downloaded: ${downloadedIds.size}`);
console.log(`Missing: ${missing.length}\n`);

// Check a sample of missing posts to diagnose
const SAMPLE_SIZE = 20;
const sample = missing.slice(0, SAMPLE_SIZE);

console.log(`Checking ${SAMPLE_SIZE} failed URLs...\n`);

const statusCounts = new Map<number, number>();
const authorCounts = new Map<string, number>();

for (const post of missing) {
  authorCounts.set(post.author, (authorCounts.get(post.author) ?? 0) + 1);
}

for (const post of sample) {
  try {
    const res = await fetch(post.url, {
      method: "HEAD",
      headers: { "User-Agent": "minesweeper-bot-research/1.0" },
      redirect: "follow",
    });
    statusCounts.set(res.status, (statusCounts.get(res.status) ?? 0) + 1);
    console.log(`  ${post.id}: ${res.status} — ${post.url}`);
  } catch (err) {
    console.log(`  ${post.id}: NETWORK_ERROR — ${post.url} — ${err}`);
  }
}

console.log("\n--- Status codes (sample) ---");
for (const [status, count] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${status}: ${count}`);
}

// Check if deleted authors are overrepresented
const deletedAuthorPosts = missing.filter((p) => p.author === "[deleted]");
console.log(`\n--- Author analysis (all ${missing.length} missing) ---`);
console.log(`[deleted] author: ${deletedAuthorPosts.length} (${((deletedAuthorPosts.length / missing.length) * 100).toFixed(1)}%)`);

// Age distribution — are older posts more likely to fail?
const now = Date.now() / 1000;
const missingByMonth = new Map<string, number>();
const totalByMonth = new Map<string, number>();
for (const p of imagePosts) {
  const month = new Date(p.created_utc * 1000).toISOString().slice(0, 7);
  totalByMonth.set(month, (totalByMonth.get(month) ?? 0) + 1);
}
for (const p of missing) {
  const month = new Date(p.created_utc * 1000).toISOString().slice(0, 7);
  missingByMonth.set(month, (missingByMonth.get(month) ?? 0) + 1);
}

console.log("\n--- Failure rate by month ---");
for (const [month, total] of [...totalByMonth.entries()].sort()) {
  const failed = missingByMonth.get(month) ?? 0;
  const bar = "#".repeat(Math.round((failed / total) * 50));
  console.log(`  ${month}: ${failed}/${total} failed (${((failed / total) * 100).toFixed(1)}%) ${bar}`);
}
