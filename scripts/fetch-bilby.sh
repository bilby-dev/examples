#!/usr/bin/env bash
# Get bilby's examples and a bilby wheel for each version in
# bilby-versions.json, each from its pinned commit of
# github.com/bilby-dev/bilby.
#
#   scripts/fetch-bilby.sh            # use the pinned commits
#   scripts/fetch-bilby.sh --update   # pin the current head of main first
#
# Writes examples/<name>/ for each version (without notebooks, adapted to
# Pyodide by scripts/adapt_examples.py), wheels/bilby-*.whl, and
# examples/versions.json, which lists the versions for the page. A blobless
# clone is kept in .cache/bilby so that setuptools_scm can compute a real
# version (e.g. 2.8.3.devN+g<hash>) from the tags; built wheels are kept in
# .cache/bilby-wheels/<commit>/.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${BILBY_REPO:-https://github.com/bilby-dev/bilby.git}"
CLONE=.cache/bilby

if [[ "${1:-}" == "--update" ]]; then
  HEAD="$(git ls-remote "$REPO" refs/heads/main | cut -f1)"
  python3 - "$HEAD" <<'EOF'
import json, sys
path = "bilby-versions.json"
config = json.load(open(path))
next(v for v in config["versions"] if v["name"] == "main")["commit"] = sys.argv[1]
open(path, "w").write(json.dumps(config, indent=1) + "\n")
EOF
  echo "pinned bilby main at $HEAD"
fi

if [[ ! -d "$CLONE/.git" ]]; then
  git clone --quiet --filter=blob:none --no-checkout "$REPO" "$CLONE"
fi

rm -rf examples
mkdir -p examples wheels
rm -f wheels/bilby-*.whl
# name, commit and tag ("-" for none) of each version
python3 -c '
import json
for v in json.load(open("bilby-versions.json"))["versions"]:
    print(v["name"], v["commit"], v.get("tag", "-"))
' | while read -r NAME COMMIT TAG; do
  git -C "$CLONE" cat-file -e "$COMMIT^{commit}" 2>/dev/null \
    || git -C "$CLONE" fetch --quiet --tags origin
  if [[ "$TAG" != "-" && "$(git -C "$CLONE" rev-parse "$TAG^{commit}")" != "$COMMIT" ]]; then
    echo "bilby-versions.json: $TAG is not $COMMIT" >&2
    exit 1
  fi

  # Examples are re-extracted every time (cheap), so changes to
  # adapt_examples.py always apply to a pristine copy.
  DEST="examples/$NAME"
  mkdir -p "$DEST"
  git -C "$CLONE" archive --format=tar "$COMMIT" examples \
    | tar -x --exclude='*.ipynb' --strip-components=1 -C "$DEST" -f -
  find "$DEST" -type d -empty -delete
  # the examples are bilby's (MIT); keep its licence next to them
  git -C "$CLONE" show "$COMMIT:LICENSE.md" > "$DEST/LICENSE.md"
  python3 scripts/adapt_examples.py "$DEST"

  BUILT=".cache/bilby-wheels/$COMMIT"
  if ! ls "$BUILT"/bilby-*.whl >/dev/null 2>&1; then
    git -C "$CLONE" checkout --quiet --force --detach "$COMMIT"
    rm -rf "$BUILT"
    python3 -m pip wheel --quiet --no-deps --wheel-dir "$BUILT" "$CLONE"
  fi
  cp "$BUILT"/bilby-*.whl wheels/
  echo "bilby $NAME: $(cd "$BUILT" && ls bilby-*.whl)"
done

python3 - <<'EOF'
import json
from pathlib import Path

config = json.load(open("bilby-versions.json"))
versions = []
for v in config["versions"]:
    (wheel,) = Path(".cache/bilby-wheels", v["commit"]).glob("bilby-*.whl")
    versions.append({
        "name": v["name"], "commit": v["commit"], "tag": v.get("tag"),
        "version": wheel.name.split("-")[1], "wheel": wheel.name,
    })
out = {"default": config["default"], "versions": versions}
Path("examples/versions.json").write_text(json.dumps(out, indent=1) + "\n")
print("wrote examples/versions.json")
EOF
