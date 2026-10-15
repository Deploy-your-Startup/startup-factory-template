#!/usr/bin/env python3
"""Validate the standalone template before testing or publishing."""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    source = root / "template"
    # Do not follow a link that could pull an owner's data into the template.
    if any(path.is_symlink() for path in source.rglob("*")):
        parser.error("template contains a symlink; review it before publishing")
    forbidden = {".git", ".env", ".sprowi-legacy", ".DS_Store"}
    owner_roots = {"projects", "sprowi/tasks", "sprowi/runs", "sprowi/experiments"}
    for path in source.rglob("*"):
        relative = path.relative_to(source)
        if any(part in forbidden for part in relative.parts) or any(
            relative == Path(owner) or Path(owner) in relative.parents
            for owner in owner_roots
        ):
            parser.error("template contains owner state or repository history")
    config = json.loads((source / "sprowi/config.default.json").read_text())
    if config.get("publish", {}).get("app", {}).get("id"):
        parser.error("template contains an owner GitHub App ID")
    print("Template contains no forbidden owner state or repository history.")


if __name__ == "__main__":
    main()
