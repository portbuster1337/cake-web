#!/bin/sh
# Publishes Cake Wallet Web to Codeberg Pages: the app built from the current
# commit becomes a new commit on the `pages` branch, then git-pages is told
# about it the way its Forgejo webhook does, and serves it at
# https://OWNER.codeberg.page/REPO/.
#   scripts/publish-pages.sh            (needs a clean work tree and an `origin` remote)
set -eu
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "uncommitted changes: commit them first, so the published app matches a commit" >&2
  exit 1
fi
src=$(git rev-parse --short HEAD)
path=$(git remote get-url origin | sed -E 's#^https://([^@]*@)?codeberg\.org/##; s#^git@codeberg\.org:##; s#\.git$##')
owner=${path%%/*}
repo=${path#*/}

out=$(mktemp -d)
index=$(mktemp)
trap 'rm -rf "$out" "$index"' EXIT
node scripts/prepare-assets.mjs
PAGES_BASE="/$repo/" npx vite build --outDir "$out" --emptyOutDir
rm -f "$index"
GIT_INDEX_FILE=$index git --work-tree="$out" add -A -f .
tree=$(GIT_INDEX_FILE=$index git write-tree)

git fetch -q origin pages 2>/dev/null || true
parent=$(git rev-parse -q --verify refs/remotes/origin/pages || true)
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  commit=$parent
  echo "the pages branch already has this version"
else
  commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "Cake Wallet Web $src")
fi
git push -q origin "$commit:refs/heads/pages"

curl -fsS -X POST "https://$owner.codeberg.page/$repo/" \
  -H 'Content-Type: application/json' \
  -H 'X-Forgejo-Event: push' \
  --data "{\"ref\":\"refs/heads/pages\",\"repository\":{\"clone_url\":\"https://codeberg.org/$owner/$repo.git\"}}" || true
echo
echo "published $src: https://$owner.codeberg.page/$repo/"
