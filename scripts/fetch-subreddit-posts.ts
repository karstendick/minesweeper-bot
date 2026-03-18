/**
 * Fetches posts from r/Minesweeper using Arctic Shift (Pushshift successor)
 * for historical data beyond Reddit's ~1000-post listing cap.
 * Downloads images from image posts for local development.
 *
 * Usage: npx tsx scripts/fetch-subreddit-posts.ts [--days 365] [--refresh] [--download-images]
 *
 * --days N             How many days of history to fetch (default: 365)
 * --refresh            Ignore post cache and re-fetch from Arctic Shift
 * --download-images    Download images from image posts to data/images/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const SUBREDDIT = "Minesweeper";
const USER_AGENT = "minesweeper-bot-research/1.0";
const PER_PAGE = 100;
const REQUEST_DELAY_MS = 1000; // Arctic Shift has no documented rate limit, but be polite
const IMAGE_DOWNLOAD_DELAY_MS = 200;
const DATA_DIR = join(import.meta.dirname, "..", "data");
const CACHE_PATH = join(DATA_DIR, "subreddit-posts.json");
const IMAGES_DIR = join(DATA_DIR, "images");

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  url: string;
  created_utc: number;
  score: number;
  num_comments: number;
  is_self: boolean;
  post_hint?: string;
  domain: string;
  permalink: string;
  author: string;
  link_flair_text: string | null;
  is_gallery?: boolean;
  is_video?: boolean;
  over_18: boolean;
  spoiler: boolean;
  stickied: boolean;
}

interface CacheData {
  fetched_at: string;
  subreddit: string;
  days: number;
  posts: RedditPost[];
}

function parseArgs(): { days: number; refresh: boolean; downloadImages: boolean } {
  const args = process.argv.slice(2);
  let days = 365;
  let refresh = false;
  let downloadImages = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--refresh") {
      refresh = true;
    } else if (args[i] === "--download-images") {
      downloadImages = true;
    }
  }

  return { days, refresh, downloadImages };
}

function loadCache(): CacheData | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveCache(data: CacheData): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  console.log(`Cached ${data.posts.length} posts to ${CACHE_PATH}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchArcticShiftPage(after: string, before: string): Promise<RedditPost[]> {
  const params = new URLSearchParams({
    subreddit: SUBREDDIT,
    after: after,
    before: before,
    sort: "asc",
    limit: String(PER_PAGE),
  });

  const url = `https://arctic-shift.photon-reddit.com/api/posts/search?${params}`;
  console.log(`Fetching: ${url}`);

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(`Arctic Shift API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  return json.data as RedditPost[];
}

async function fetchAllPosts(days: number): Promise<RedditPost[]> {
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const beforeISO = now.toISOString();
  let afterISO = start.toISOString();

  const allPosts: RedditPost[] = [];
  let page = 0;

  while (true) {
    const posts = await fetchArcticShiftPage(afterISO, beforeISO);
    page++;

    if (posts.length === 0) {
      console.log(`No more results at page ${page}. Done.`);
      break;
    }

    allPosts.push(...posts);
    console.log(`  Page ${page}: got ${posts.length} posts (${allPosts.length} total)`);

    // Advance cursor past the last post we received
    const lastPost = posts[posts.length - 1]!;
    const lastTimestamp = new Date(lastPost.created_utc * 1000);
    // Add 1 second to avoid fetching the same post again
    afterISO = new Date(lastTimestamp.getTime() + 1000).toISOString();

    if (posts.length < PER_PAGE) {
      console.log(`Got fewer than ${PER_PAGE} results. Done.`);
      break;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return allPosts;
}

function isImagePost(post: RedditPost): boolean {
  return (
    post.post_hint === "image" ||
    post.domain === "i.redd.it" ||
    /\.(png|jpg|jpeg|gif|webp)$/i.test(post.url)
  );
}

function getImageExtension(url: string): string {
  const ext = extname(new URL(url).pathname).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return ext;
  return ".jpg"; // default fallback
}

async function downloadImage(post: RedditPost): Promise<"downloaded" | "skipped" | "failed"> {
  const ext = getImageExtension(post.url);
  const filename = `${post.id}${ext}`;
  const filepath = join(IMAGES_DIR, filename);

  if (existsSync(filepath)) return "skipped";

  try {
    const res = await fetch(post.url, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!res.ok || !res.body) {
      console.error(`  Failed to download ${post.id}: ${res.status}`);
      return "failed";
    }

    const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    await pipeline(nodeStream, createWriteStream(filepath));
    return "downloaded";
  } catch (err) {
    console.error(`  Failed to download ${post.id}: ${err}`);
    return "failed";
  }
}

async function downloadAllImages(posts: RedditPost[]): Promise<void> {
  mkdirSync(IMAGES_DIR, { recursive: true });

  const imagePosts = posts.filter(isImagePost);
  // Skip galleries — their URL points to the gallery page, not a direct image
  const galleryPosts = posts.filter((p) => p.is_gallery);
  const directImagePosts = imagePosts.filter((p) => !p.is_gallery);

  console.log(`\n=== IMAGE DOWNLOAD ===`);
  console.log(`Image posts: ${imagePosts.length} (${galleryPosts.length} galleries skipped, ${directImagePosts.length} to download)`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < directImagePosts.length; i++) {
    const post = directImagePosts[i]!;
    const result = await downloadImage(post);

    if (result === "downloaded") downloaded++;
    else if (result === "skipped") skipped++;
    else failed++;

    if ((i + 1) % 50 === 0 || i === directImagePosts.length - 1) {
      console.log(`  Progress: ${i + 1}/${directImagePosts.length} (${downloaded} new, ${skipped} cached, ${failed} failed)`);
    }

    if (result === "downloaded") await sleep(IMAGE_DOWNLOAD_DELAY_MS);
  }

  console.log(`\nDone: ${downloaded} downloaded, ${skipped} already cached, ${failed} failed`);
}

function printSummary(posts: RedditPost[]): void {
  const nonStickied = posts.filter((p) => !p.stickied);

  if (nonStickied.length === 0) {
    console.log("\nNo posts found.");
    return;
  }

  const earliest = new Date(Math.min(...nonStickied.map((p) => p.created_utc)) * 1000);
  const latest = new Date(Math.max(...nonStickied.map((p) => p.created_utc)) * 1000);
  const daySpan = (latest.getTime() - earliest.getTime()) / (1000 * 60 * 60 * 24);

  console.log("\n=== SUMMARY ===");
  console.log(`Total posts: ${nonStickied.length} (excluding ${posts.length - nonStickied.length} stickied)`);
  console.log(`Date range: ${earliest.toISOString().slice(0, 10)} to ${latest.toISOString().slice(0, 10)} (${daySpan.toFixed(1)} days)`);
  console.log(`Posts per day: ${(nonStickied.length / daySpan).toFixed(1)}`);

  // Post types
  const imagePosts = nonStickied.filter(isImagePost);
  const galleryPosts = nonStickied.filter((p) => p.is_gallery);
  const selfPosts = nonStickied.filter((p) => p.is_self);
  const videoPosts = nonStickied.filter((p) => p.is_video || p.post_hint === "video" || p.post_hint === "hosted:video" || p.post_hint === "rich:video");
  const linkPosts = nonStickied.filter(
    (p) => !p.is_self && !isImagePost(p) && !p.is_gallery && !p.is_video
  );

  console.log("\n--- Post types ---");
  console.log(`Image posts: ${imagePosts.length} (${pct(imagePosts.length, nonStickied.length)})`);
  console.log(`  Direct images: ${imagePosts.length - galleryPosts.length}`);
  console.log(`  Galleries: ${galleryPosts.length}`);
  console.log(`Text (self) posts: ${selfPosts.length} (${pct(selfPosts.length, nonStickied.length)})`);
  console.log(`Video posts: ${videoPosts.length} (${pct(videoPosts.length, nonStickied.length)})`);
  console.log(`Link posts: ${linkPosts.length} (${pct(linkPosts.length, nonStickied.length)})`);

  // Image domains
  console.log("\n--- Image hosting domains ---");
  const domainCounts = new Map<string, number>();
  for (const p of imagePosts) {
    domainCounts.set(p.domain, (domainCounts.get(p.domain) ?? 0) + 1);
  }
  for (const [domain, count] of [...domainCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${domain}: ${count}`);
  }

  // Flairs
  console.log("\n--- Flairs ---");
  const flairCounts = new Map<string, number>();
  for (const p of nonStickied) {
    const flair = p.link_flair_text ?? "(none)";
    flairCounts.set(flair, (flairCounts.get(flair) ?? 0) + 1);
  }
  for (const [flair, count] of [...flairCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flair}: ${count}`);
  }

  // Help-related keywords in titles
  const helpKeywords = /\b(help|stuck|hint|advice|next move|what (should|do|would)|where|guess|safe|50.?50)\b/i;
  const helpPosts = nonStickied.filter((p) => helpKeywords.test(p.title) || helpKeywords.test(p.selftext));
  const helpImagePosts = helpPosts.filter(isImagePost);
  const helpFlairPosts = nonStickied.filter((p) => p.link_flair_text === "Help");
  const helpFlairImagePosts = helpFlairPosts.filter(isImagePost);

  console.log("\n--- Help request detection ---");
  console.log(`"Help" flair posts: ${helpFlairPosts.length} (${pct(helpFlairPosts.length, nonStickied.length)})`);
  console.log(`  ...of which are image posts: ${helpFlairImagePosts.length}`);
  console.log(`Keyword-matched posts: ${helpPosts.length} (${pct(helpPosts.length, nonStickied.length)})`);
  console.log(`  ...of which are image posts: ${helpImagePosts.length}`);
  // Union of both signals
  const targetPosts = nonStickied.filter(
    (p) => isImagePost(p) && (p.link_flair_text === "Help" || helpKeywords.test(p.title) || helpKeywords.test(p.selftext))
  );
  console.log(`Combined (flair OR keywords) image posts: ${targetPosts.length}`);
  console.log(`  → ~${(targetPosts.length / daySpan).toFixed(1)} targetable posts per day`);

  // Engagement stats
  const scores = nonStickied.map((p) => p.score).sort((a, b) => a - b);
  const comments = nonStickied.map((p) => p.num_comments).sort((a, b) => a - b);
  const median = (arr: number[]) => arr[Math.floor(arr.length / 2)]!;

  console.log("\n--- Engagement ---");
  console.log(`Score:    median=${median(scores)}, mean=${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}`);
  console.log(`Comments: median=${median(comments)}, mean=${(comments.reduce((a, b) => a + b, 0) / comments.length).toFixed(1)}`);
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main() {
  const { days, refresh, downloadImages } = parseArgs();

  let posts: RedditPost[];

  // Try cache first
  const cached = loadCache();
  if (!refresh && cached && cached.days >= days) {
    console.log(`Using cached data from ${cached.fetched_at} (${cached.posts.length} posts, ${cached.days} days)`);
    console.log("Run with --refresh to re-fetch from Arctic Shift.\n");
    posts = cached.posts;
  } else {
    console.log(`Fetching posts from r/${SUBREDDIT} (last ${days} days) via Arctic Shift...\n`);
    posts = await fetchAllPosts(days);

    saveCache({
      fetched_at: new Date().toISOString(),
      subreddit: SUBREDDIT,
      days,
      posts,
    });
  }

  printSummary(posts);

  if (downloadImages) {
    await downloadAllImages(posts);
  } else {
    const imageCount = posts.filter(isImagePost).length;
    console.log(`\nTo download ${imageCount} images, run with --download-images`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
