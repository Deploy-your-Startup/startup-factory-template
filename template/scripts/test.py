"""Run the integration suite with the repository's locked CLI runtime."""

import argparse
import os
import subprocess
import sys
import sysconfig
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
root = parser.parse_args().root.resolve()
scripts = Path(sysconfig.get_path("scripts"))
environment = {
    **os.environ,
    "FACTORY_TEST_PYTHON": sys.executable,
    "STARTUP_TEST_EXECUTABLE": str(scripts / "startup"),
    "PATH": str(scripts) + os.pathsep + os.environ["PATH"],
}
# A caller's checkout must not replace the CLI selected by this repository.
environment.pop("PYTHONPATH", None)
tests = sorted((root / "scripts/tests").glob("*.test.mjs"))
tests += sorted((root / "sprowi").glob("*.integration.test.mjs"))
raise SystemExit(
    subprocess.call(["node", "--test", *map(str, tests)], cwd=root, env=environment)
)
