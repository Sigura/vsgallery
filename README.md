# LoRA Dataset Studio

A VS Code extension for curating image + caption datasets for Stable Diffusion LoRA training
(kohya-ss sd-scripts layout: `N_name` folders, one `.txt` caption per image).

## Features

- **Gallery** — virtualized thumbnail grid with a disk thumbnail cache, sorting (name, date, size,
  resolution, aspect), flat / grouped / single-folder views, kohya folder tags (`10_char` → "char (10)"),
  search in names, captions or exact tags, a file watcher and optional polling.
- **Detail view** — zoomable viewer and a caption editor with tag chips, autocomplete from the
  dataset's tags, autosave and a three-way merge when the file changes on disk. Images without a
  caption get *Generate* / *Write caption* buttons.
- **Auto-caption** — WD Tagger v3 (ONNX, runs in the webview on WebGPU or WASM) for one image (G) or
  a batch, with thresholds, excluded tags, a trigger word and skip / append / overwrite modes.
- **Batch resize** — to kohya buckets, a maximum or short side, or a multiple of 8/64, with a
  per-image plan and crop preview; in place (with `.bak`) or into a mirror folder.
- **Image editor** — layers, move/scale, brush, eraser, wet paint, clone stamp, eyedropper, crop to
  ratios or buckets, rectangle / lasso / magic-wand selections, content-aware fill of a selection,
  rotate/flip, undo history, before/after, save over the original (with `.bak`) or as a copy.
- **Statistics** (*Stats*) — images per folder with kohya repeats and samples per epoch, short-side and
  orientation distribution, bucket assignment counts, caption coverage, tag counts, quality flags.
- **Tag tools** (*Tags…*) — tag frequency list with search; rename / merge, remove, add at the start or
  end, move the trigger word first. Every operation is previewed from the files on disk before it
  is applied.
- **Duplicates** (*Duplicates…*) — near-duplicate groups by pHash or dHash with an adjustable Hamming
  threshold; the largest copy is kept, the rest are marked for deletion, click to change.
- **Quality flags** — small resolution, blurry (variance of the Laplacian), not ÷8 / ÷64, extreme
  aspect, missing / empty / short / long caption; shown as tile badges and as a filter.
- **Review mode** (*Review*) — step through images: keep, delete, skip, edit caption, with a counter.

Tools that act on several images use the selected images, or all visible (filtered) images when
nothing is selected. Deleting is permanent (no trash); images are deleted without confirmation
unless `loraDataset.confirmDelete` is on, folders always ask.

Hashes and the blur metric are computed in the background from the thumbnails (from the original
when there is no thumbnail yet) and stored with the dataset's index, so they are computed once
per file version.

## Usage

Right-click a folder in the Explorer → **Open Dataset Gallery**, or an image → **Open Image in
Dataset Editor**. Press **?** in the gallery for all keyboard shortcuts.

## Settings

All settings are under *Settings › LoRA Dataset* (`loraDataset.*`): thumbnail size and cache,
caption extensions, minimum resolution, quality thresholds (`quality.blurThreshold`,
`quality.maxAspect`, `quality.minWords`, `quality.maxTokens`), delete confirmation, polling, caption
autosave, editor defaults and the tagger (model, thresholds, excluded tags, trigger word, backend).

## Development

```sh
npm install
npm run build        # bundles into dist/
npm run typecheck
npm test             # unit tests of src/shared
npm run watch        # rebuild on change; run "Run Extension" (F5) in VS Code
scripts/fetch-models.sh [wd-vit-tagger-v3|wd-eva02-large-tagger-v3]   # bundle a tagger model into models/
npm run package      # .vsix
```

Layout: `src/host` runs in the extension host (scanning, file writes, thumbnail cache, model store),
`src/webview` is the gallery / detail / editor UI, `src/shared` holds pure logic with unit tests in
`test/`.

## Not yet verified in VS Code

- onnxruntime's threaded WASM build without `SharedArrayBuffer`, and WebGPU inside webviews.
- Ctrl+V image paste and file drop onto the editor (VS Code may require Shift while dropping).
- Whether Ctrl+A / Ctrl+D / Ctrl+Shift+I reach the webview or are taken by VS Code.
- Marching-ants performance on very large magic-wand selections.
- The default blur threshold (50) has not been tuned on real datasets.
