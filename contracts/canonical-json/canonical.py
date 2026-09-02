"""Reference implementation of the canonical-json contract. See CONTRACT.md.

Canonical form: keys sorted, no insignificant whitespace, UTF-8 output,
non-finite numbers refused. The digest is SHA-256 over those bytes.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


class CanonicalError(ValueError):
    """A value that has no canonical form."""


def canonical_json_bytes(value: Any) -> bytes:
    try:
        text = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except ValueError as error:  # allow_nan=False raises on inf/nan
        raise CanonicalError(str(error)) from error
    except TypeError as error:
        raise CanonicalError(str(error)) from error
    return text.encode("utf-8")


def content_id(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json_bytes(value)).hexdigest()
