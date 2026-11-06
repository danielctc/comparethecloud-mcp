#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/dist"
python3 - "$root" <<'PY'
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import sys
root = Path(sys.argv[1])
package = root / 'plugins/chatgpt'
with ZipFile(root / 'dist/comparethecloud-chatgpt-plugin.zip', 'w', ZIP_DEFLATED) as archive:
    for path in [package / 'plugin.json', package / 'mcp.json', *(package / 'assets').rglob('*'), *(package / 'skills').rglob('*')]:
        if path.is_file() and not path.name.startswith('.'):  # no .DS_Store or editor backups in the ZIP
            archive.write(path, path.relative_to(package))
PY
