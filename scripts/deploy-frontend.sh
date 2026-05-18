#!/bin/bash
# cc-web frontend deploy: hash-bust app.js + style.css and update index.html
set -euo pipefail
cd "$(dirname "$0")/../public"

deploy_one() {
  local src="$1"   # e.g. app.js or style.css
  local pattern="$2" # regex to match in index.html, e.g. "app\.[a-f0-9]\+\\.js"

  local hash=$(sha256sum "$src" | cut -c1-10)
  local ext="${src##*.}"
  local base="${src%.*}"
  local new="${base}.${hash}.${ext}"

  if [ -f "$new" ]; then
    echo "[skip] $new (unchanged)"
    return
  fi

  # Remove old hashed versions
  for old in "${base}".*."${ext}"; do
    [ -f "$old" ] && rm -f "$old" && echo "Removed $old"
  done

  cp "$src" "$new"
  sed -i "s|${pattern}|${new}|g" index.html
  echo "Deployed: $new"
}

deploy_one "app.js"   "app\.[a-f0-9]\+\\.js"
deploy_one "style.css" "style\.[a-f0-9]\+\\.css"
