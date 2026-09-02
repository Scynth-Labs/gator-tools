#!/usr/bin/env python3
"""Check a Python implementation against the frozen canonical-json vector.

    python3 verify.py laicode.canonical
    python3 verify.py /path/to/module.py --canonical canonical_json_bytes --digest content_id

The canonical export may return `bytes` or `str`; both are compared as UTF-8
text. The digest export may return bare hex or a "sha256:"-prefixed id, since
that prefix is a presentation choice and not part of the attested bytes.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import sys
from pathlib import Path

VECTOR = Path(__file__).with_name("vector.json")


def load_module(reference: str):
    if reference.endswith(".py") or "/" in reference:
        path = Path(reference).resolve()
        spec = importlib.util.spec_from_file_location(path.stem, path)
        if spec is None or spec.loader is None:
            raise SystemExit(f"cannot load {reference}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    return importlib.import_module(reference)


def text_of(value) -> str:
    return value.decode("utf-8") if isinstance(value, (bytes, bytearray)) else str(value)


def hex_of(value: str) -> str:
    text = str(value)
    return text[len("sha256:"):] if text.startswith("sha256:") else text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("module")
    parser.add_argument("--canonical", default="canonical_json_bytes")
    parser.add_argument("--digest", default="content_id")
    args = parser.parse_args()

    vector = json.loads(VECTOR.read_text(encoding="utf-8"))
    module = load_module(args.module)

    canonical = getattr(module, args.canonical, None)
    if not callable(canonical):
        print(f"{args.module} exports no callable named {args.canonical}", file=sys.stderr)
        return 2
    digest = getattr(module, args.digest, None)

    failures = 0
    for case in vector["cases"]:
        try:
            produced = text_of(canonical(case["value"]))
            if produced != case["canonical"]:
                failures += 1
                print(f"FAIL {case['name']}\n  expected {case['canonical']}\n  produced {produced}", file=sys.stderr)
                continue
            if callable(digest):
                got = hex_of(digest(case["value"]))
                want = hex_of(case["content_id"])
                if got != want:
                    failures += 1
                    print(f"FAIL {case['name']} digest\n  expected {want}\n  produced {got}", file=sys.stderr)
        except Exception as error:  # a vector case must not be refused
            failures += 1
            print(f"FAIL {case['name']} raised: {error}", file=sys.stderr)

    if failures:
        print(f"\n{failures} of {len(vector['cases'])} cases failed", file=sys.stderr)
        return 1
    print(f"canonical-json v{vector['version']}: {len(vector['cases'])} cases reproduced by {args.module}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
