# Scripts

## Data Collection

- **fetch-subreddit-posts.ts** — Fetch posts from r/Minesweeper and download images
  ```
  npx tsx scripts/fetch-subreddit-posts.ts [--days 365] [--refresh] [--download-images]
  ```

- **find-by-skin.ts** — Classify all images by detected skin type, save per-skin lists
  ```
  npx tsx scripts/find-by-skin.ts                # show counts per skin
  npx tsx scripts/find-by-skin.ts --save          # write data/<skin>-images.txt files
  npx tsx scripts/find-by-skin.ts --skin classic  # list images matching a specific skin
  ```

## Testing & Verification

- **scan-all-images.ts** — Run vision pipeline against all images, report aggregate stats
  ```
  npx tsx scripts/scan-all-images.ts [--limit 10] [--verbose]
  ```

- **check-grid.ts** — Show detected grid as 2D character array for manual verification
  ```
  npx tsx scripts/check-grid.ts <image-file>                # check one image
  npx tsx scripts/check-grid.ts --skin clean-one [--offset N]  # iterate through a skin's image list
  ```

## Visualization

- **visualize-grid.ts** — Draw detected grid lines on image, save to `data/debug/`
  ```
  npx tsx scripts/visualize-grid.ts <image-file>
  ```

## Template Extraction

- **extract-templates-cluster.ts** — Extract 16x20 templates using cluster-based bbox (matches vision.ts logic)
  ```
  npx tsx scripts/extract-templates-cluster.ts <image> <col,row=digit> ...
  npx tsx scripts/extract-templates-cluster.ts 1jfjg2j.jpeg 2,7=3 3,7=1 4,7=2
  ```
