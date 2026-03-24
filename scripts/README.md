# Scripts

## Data Collection
- **fetch-subreddit-posts.ts** — Fetch posts from r/Minesweeper and download images
- **find-by-skin.ts** — Classify all images by detected skin type, save per-skin lists

## Testing & Verification
- **test-ground-truth.ts** — Test vision pipeline against ground truth files, report per-cell accuracy
- **test-vision.ts** — Run vision pipeline against all images, report aggregate stats
- **check-grid.ts** — Show detected grid as 2D character array for manual verification

## Visualization
- **visualize-grid.ts** — Draw detected grid lines on image, save to `data/debug/`

## Template Extraction
- **extract-templates-cluster.ts** — Extract 16x20 templates using cluster-based bbox (matches vision.ts logic)
