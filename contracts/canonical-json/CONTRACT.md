# canonical-json

One byte representation for a JSON value, and one content id derived from it, so
that independent implementations in different languages produce the same digest
for the same data.

`vector.json` is the contract. Prose describes it; the vector decides it.

## Why this exists

Two projects arrived at this encoding separately — `ai-cohort/src/threads/receipt.js`
in JavaScript and `laicode/laicode/canonical.py` in Python — and were found to
agree byte for byte on every case here. Nothing checked that. An agreement
nobody verifies is a coincidence with a short life: one project fixes an edge
case, the other does not, and two digests that used to match quietly stop
matching. Both now verify against this vector in CI.

## The rules

1. Object keys are sorted ascending by UTF-16 code unit. Input order is
   irrelevant.
2. Array order is significant and preserved.
3. No insignificant whitespace. The separators are exactly `,` and `:`.
4. Output is UTF-8. Non-ASCII characters are emitted literally, never
   `\u`-escaped.
5. Control characters and quotes use the shortest JSON escape.
6. Non-finite numbers — `NaN`, `Infinity`, `-Infinity` — have no canonical form
   and must be refused rather than encoded.
7. `content_id` is `sha256:` followed by the lowercase hex SHA-256 of the
   canonical UTF-8 bytes.

A digest function may return bare hex instead of the prefixed form; the
verifiers accept both, because the prefix is presentation and not part of the
bytes being attested.

## What is deliberately not frozen

**Astral-plane object keys — a live divergence, not a preference.** Rule 1 says
UTF-16 code unit order, which is what RFC 8785 (JSON Canonicalization Scheme)
mandates and what JavaScript's `sort` does. Python's `sort_keys=True` sorts by
codepoint instead. The two agree for every key below U+10000 and disagree above
it, because U+1D11E is the single code unit sequence `D834 DD1E` in UTF-16 —
whose first unit is below U+FEFF — but the codepoint `0x1D11E`, which is above
it:

```
input   {"\uFEFF": 1, "\U0001D11E": 2}
JS      {"𝄞":2,"\uFEFF":1}
Python  {"\uFEFF":1,"𝄞":2}
```

Different bytes, therefore a different SHA-256, with no error raised on either
side. An object carrying both an astral-plane key and a BMP key at or above
U+E000 will not round-trip between the two.

No vector case contains an astral key, and `tests/known-divergences.mjs` asserts
the disagreement still exists, so closing it has to be deliberate. Closing it
properly means making the Python side sort by UTF-16 code unit — which changes
content ids for such documents and is therefore an ADR in each consuming
project, not a vector edit.

**Floating-point numbers.** No case in the vector contains one, and whether an
implementation accepts them is left open.

laicode refuses floats outright — `floating-point values are not allowed; use an
integer unit` — to avoid the representation ambiguity that makes float digests
fragile across languages. ai-cohort accepts finite ones, because a receipt over
database rows has no reason to reject them.

Both remain conformant. This contract covers what they already agree on, and
freezing a float rule would change a published artifact in one project or the
other — an ADR, not a vector edit. If you need floats hashed reproducibly, the
answer is to encode them as integers in a stated unit, not to argue about
`repr`.

## Verifying an implementation

```sh
node contracts/canonical-json/verify.mjs path/to/module.mjs \
  --canonical canonicalize --digest receiptDigest

python3 contracts/canonical-json/verify.py your.module \
  --canonical canonical_json_bytes --digest content_id
```

Both exit non-zero on the first disagreement and print what differed. A vector
case that an implementation *refuses* is a failure too: everything here must be
encodable.

## Changing the contract

Don't, unless the change is deliberate and both consumers move together.

`build-vector.mjs` regenerates `vector.json` from `canonical.mjs`. Running it is
easy, which is exactly the risk: a regenerated vector that nobody diffed proves
nothing, because it will happily bless whatever the implementation now does. If
you regenerate, read the diff, and expect every consuming project's CI to go red
until each one is updated on purpose.

## Reference implementations

`canonical.mjs` and `canonical.py` exist so a third language does not have to
guess. They are not the contract — the vector is — and they are checked against
it like any other implementation.
