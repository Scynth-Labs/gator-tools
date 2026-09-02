#!/usr/bin/env python3
"""Python half of the cross-language differential test.

Reads a JSONL batch produced by differential-canonical.mjs, each line carrying a
value and the canonical form and content id JavaScript produced for it. Fails on
the first disagreement and prints the value that caused it, so a failure is a
reproduction rather than a report.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "contracts" / "canonical-json"))

from canonical import canonical_json_bytes, content_id  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: differential_canonical_check.py <batch.jsonl>", file=sys.stderr)
        return 2

    checked = 0
    for line in Path(argv[1]).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        value = record["value"]

        produced = canonical_json_bytes(value).decode("utf-8")
        if produced != record["canonical"]:
            print(
                f"DISAGREEMENT on document {record['index']}\n"
                f"  value      {json.dumps(value, ensure_ascii=False)}\n"
                f"  javascript {record['canonical']}\n"
                f"  python     {produced}",
                file=sys.stderr,
            )
            return 1

        digest = content_id(value)
        if digest != record["content_id"]:
            print(
                f"DIGEST DISAGREEMENT on document {record['index']}\n"
                f"  value      {json.dumps(value, ensure_ascii=False)}\n"
                f"  javascript {record['content_id']}\n"
                f"  python     {digest}",
                file=sys.stderr,
            )
            return 1
        checked += 1

    print(f"python agreed on {checked} documents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
