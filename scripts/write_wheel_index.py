"""Write wheels/index.json: the wheel of each kind the page installs. For
bilby, the wheel of each version in examples/versions.json (written by
scripts/fetch-bilby.sh), by version name.

Run by scripts/dev.sh and the Pages workflow, so the index always matches the
wheels that are actually present.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WHEELS = ROOT / "wheels"
KINDS = {
    "lalsuite": "lalsuite-*.whl",
    "igwn_segments": "igwn_segments-*.whl",
}

if __name__ == "__main__":
    versions = json.loads((ROOT / "examples" / "versions.json").read_text())["versions"]
    index = {"bilby": {v["name"]: v["wheel"] for v in versions if (WHEELS / v["wheel"]).exists()}}
    for key, pattern in KINDS.items():
        found = sorted(p.name for p in WHEELS.glob(pattern))
        index[key] = found[-1] if found else None
    (WHEELS / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    print(f"wrote {WHEELS / 'index.json'}: {index}")
