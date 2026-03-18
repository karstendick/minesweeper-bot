# Minesweeper Bot — Design Document

## Purpose

A Reddit bot for r/Minesweeper that monitors posts where users share a screenshot and ask for help with their next move. The bot analyzes the board and replies with safe cells, flagged mines, and probabilities for forced-guess situations.

## Language

**TypeScript** — enables code sharing with a future frontend and aligns with the primary author's professional experience.

## Architecture

| Component | Technology | Notes |
|---|---|---|
| Compute | AWS Lambda (free tier) | Triggered on schedule by EventBridge (~every 5 min), polling via PRAW-equivalent |
| Database | Supabase (free tier, Postgres) | Tracks already-processed post/comment IDs to avoid duplicate replies |
| Image storage | Cloudflare R2 (free tier) | Both input screenshots and output annotated images; free egress, 10GB storage |

## Bot Behavior

1. Lambda wakes on schedule, polls r/Minesweeper for new posts
2. Checks Supabase to skip already-processed posts
3. For posts containing a board screenshot and a help request:
   - Download the image
   - Run vision pipeline
   - Run solver
   - Generate annotated image
   - Post reply
4. Records processed post ID in Supabase

## Vision Pipeline (image → board state)

**Approach:** OpenCV template matching — no LLM needed. The problem is well-constrained:
- Minesweeper grids are perfectly regular (uniform cell size, even spacing)
- Only ~12–15 possible cell states: hidden, empty, flagged, mine, digits 1–8
- Within a given game skin, every "3" looks identical to every other "3"

**Steps:**
1. Detect grid bounds and infer cell dimensions (edge detection or repeating-pattern analysis)
2. Slice image into individual cell patches
3. Template-match each patch against a pre-built library of reference images for the identified skin
4. Output: 2D array of cell states, e.g. `[["hidden", "1", "2", "flag", ...], ...]`

**Skin identification:** Color histogram matching or a fingerprint crop from a known location to identify which game the screenshot is from before template matching.

**Supported skins (start small):** Google Minesweeper, Minesweeper Online (minesweeper.online), and possibly classic Windows. Expand based on what actually shows up in the subreddit.

**Known challenges:** Scale variance (people crop/resize before posting) — handle by normalizing or running template matching at multiple scales.

## Solver

**Approach:** Build a custom solver on top of [`logic-solver`](https://www.npmjs.com/package/logic-solver), an npm package wrapping MiniSat (compiled to JS via Emscripten).

**Why `logic-solver`:**
- Sum constraints map directly to minesweeper: `Logic.equalBits(Logic.sum(neighborVars), cellValue)` expresses "exactly N of these neighbors are mines"
- Supports solution enumeration via a solve/forbid loop, enabling exact probability calculation by counting valid configurations
- Small (~100KB), one dependency (`underscore`), proven in production (Meteor's package resolver)
- MiniSat-based performance is sufficient for minesweeper constraint regions (typically 10–25 variables per connected component)

**Alternatives considered:**
- `z3-solver` (Z3 via WASM): Most powerful, but ~34MB bundle and requires `SharedArrayBuffer`. Overkill.
- JSMiniSolvers (MiniCard): Native cardinality constraints, but not on npm and only 3 stars.
- Extracting from [DavidNHill/JSMinesweeper](https://github.com/DavidNHill/JSMinesweeper): Battle-tested JS solver with exact probabilities, but embedded in a web app, not a library.
- Porting [JohnnyDeuss/minesweeper-solver](https://github.com/JohnnyDeuss/minesweeper-solver) (Python): Good constraint-programming solver with numpy-based probability calculation, but would require a full port.

**Fallback:** If `logic-solver` enumeration is too slow on large boards, write a custom backtracking enumerator with constraint propagation (similar to [mrgriscom/minesweepr](https://github.com/mrgriscom/minesweepr)).

**Solver input:** 2D board state array from the vision pipeline. Vision and solver layers are cleanly decoupled.

## Output

Generate an annotated version of the original screenshot (using a canvas/image library) marking:
- **Green:** definitely safe cells
- **Red:** definite mines
- **Probability labels** on forced-guess cells

Upload annotated image to image storage, reply to the Reddit post with the image link and a text explanation of the reasoning.

## Subreddit Data (scraped 2026-03-18, 30-day window)

**Volume:** ~435 posts/month, ~14.6 posts/day

**Post types:** 80.9% images (mostly i.redd.it), 17.7% text, 3.9% video, 1.4% links

**Flairs:** "Help" (190), "Miscellaneous" (78), "Meme" (38), "Puzzle/Tactic" (28), "No Guess" (24), "Accomplishment" (19), "50/50 Casualty" (18), others smaller

**Bot target posts:** ~4.8/day (~142/month) — image posts matching help keywords. The "Help" flair (190 posts) is a strong primary signal; keyword matching is a useful supplement.

**Engagement:** median 5 upvotes, median 5 comments per post

## Capacity Planning

Assuming ~150 bot posts/month (current), ~500KB avg image, 30-day TTL, ~20 views per output image.

| Resource | Free Tier | Current (~150/mo) | 10x (~1,500/mo) | Risk? |
|---|---|---|---|---|
| Lambda requests | 1M/mo | ~9K | ~10K | No |
| Lambda compute | 400K GB-s/mo | ~750 GB-s | ~7,500 GB-s | No |
| EventBridge | 14M/mo | ~8,640 | ~8,640 | No |
| Supabase DB | 500MB | trivial | trivial | No |
| R2 storage | 10GB | ~150MB steady state | ~1.5GB steady state | No |
| R2 egress | Free | Free | Free | No |
| R2 writes | 1M/mo | ~300 | ~3,000 | No |
| R2 reads | 10M/mo | ~3,000 | ~30,000 | No |

**Image storage decision: Cloudflare R2.** Supabase Storage (1GB storage, 10GB egress) would hit limits at 10x growth. R2's 10GB storage and free egress handle 10x comfortably.

## Open Questions

- Confirm which games dominate r/Minesweeper posts (manual browse of image posts before building template library)
- How to handle partial screenshots (cropped boards missing edges)
- Post detection: use "Help" flair as primary signal, keyword matching as supplement — needs validation
- OpenCV in Lambda: heavy dependency (~50MB+); may need Lambda container image instead of zip deployment
- Reddit API library choice for TypeScript (snoowrap, or raw API calls)
