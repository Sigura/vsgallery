#!/usr/bin/env bash
# Downloads the WD tagger model(s) into models/<id>/ so `npm run package` ships them in the .vsix.
# Usage: scripts/fetch-models.sh [model-id ...]   (default: wd-vit-tagger-v3)
set -euo pipefail

cd "$(dirname "$0")/.."

for tool in curl node; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

models=("$@")
[ ${#models[@]} -gt 0 ] || models=(wd-vit-tagger-v3)

for id in "${models[@]}"; do
  case "$id" in
    wd-vit-tagger-v3|wd-eva02-large-tagger-v3) ;;
    *) echo "error: unknown model '$id' (expected wd-vit-tagger-v3 or wd-eva02-large-tagger-v3)" >&2; exit 1 ;;
  esac
  repo="SmilingWolf/$id"
  dir="models/$id"
  mkdir -p "$dir"

  echo "==> $repo: reading file list"
  tree="$(curl -fsSL --retry 5 "https://huggingface.co/api/models/$repo/tree/main")"

  for f in model.onnx selected_tags.csv; do
    # sha256 of LFS files (model.onnx); empty for regular git files.
    sha="$(node -e '
      const tree = JSON.parse(process.argv[1]);
      const e = tree.find((x) => x.path === process.argv[2]);
      if (!e) { console.error(`${process.argv[2]} not in repository`); process.exit(1); }
      console.log(e.lfs ? e.lfs.oid : "");
    ' "$tree" "$f")"

    if [ -f "$dir/$f" ] && [ -n "$sha" ] && echo "$sha  $dir/$f" | sha256sum -c --status; then
      echo "==> $dir/$f: already present and verified"
      continue
    fi

    echo "==> $dir/$f: downloading"
    curl -fL --retry 10 --retry-all-errors -C - -o "$dir/$f.part" "https://huggingface.co/$repo/resolve/main/$f"

    if [ -n "$sha" ]; then
      echo "==> $dir/$f: verifying sha256"
      if ! echo "$sha  $dir/$f.part" | sha256sum -c --status; then
        echo "error: checksum mismatch for $dir/$f; partial file removed, run again" >&2
        rm -f "$dir/$f.part"
        exit 1
      fi
    fi
    mv "$dir/$f.part" "$dir/$f"
  done
  ls -la "$dir"
done

echo "==> done; models/ is included by .vscodeignore when packaging"
