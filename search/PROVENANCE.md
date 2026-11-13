# Matcher provenance

The matcher comes from [Flea](https://github.com/thisisgm/flea), base commit `7c866397b` with
flea-search's pre-release `wk2` and `H` changes (diff SHA-256
`942bbf17235ff91e7758ff3ff28d77a6c22924616d96ec343afe45b6d069ad14`).
The hashes below identify the exact upstream file contents used for this snapshot.

| Source file | Source SHA-256 |
| --- | --- |
| `searchmatch.rs` | `1416164b21d32cfaee769582de04885a3d64e0d5180447a53977969f898b9158` |
| `searchascii.rs` | `a923431abd51f8ed93ad463a895fe1db518771b07b1b196cc6fcfb7b987b8c4c` |
| `searchtypo.rs` | `9edefcf793c1f02e6513c776e59103d4f84e41e6c46d198c591395a5b781470e` |
| `searchbits.rs` | `b7842ff21afbe14065556b82760b4c4185798cb1c8d41e01ed4f7d4896c2b027` |

`searchascii.rs`, `searchtypo.rs`, and `searchbits.rs` are byte-for-byte copies.
The only change to `searchmatch.rs` is removal of this trailing module reference,
including its preceding blank line, because the snapshot does not include
`searchmatch_tests.rs`:

```rust
#[cfg(test)]
#[path = "searchmatch_tests.rs"]
pub(crate) mod tests;
```

`src/backend/mod.rs` retains the original module hierarchy, including the
`crate::backend::searchtypo` reference. Unused filesystem-search APIs and the
newer clippy lints the vendored code trips are allowed, and rustfmt is skipped,
at the adapter's module boundary (`src/main.rs`), so the vendored files need no
warning or formatting edits. `tests/search-provenance.test.js` checks the
hashes above and the license hash below.
The helper's own tests live in `src/engine.rs`, `src/catalogs.rs`,
`src/protocol.rs`, and `tests/protocol.rs`.

## License

The vendored source is MIT licensed, copyright (c) 2026 GM. The original MIT
license and notice are retained verbatim in `LICENSE`, SHA-256
`d2a2191fc6fa3fb43cd6dfe0a7b156ded8f4a5e23c498ef1111788c37ec4f0c4`.

## Adapter contract

`foamy-menu-search` uses synchronous NDJSON on stdin and stdout. Each response is
flushed before reading another request. A write, flush, or input I/O failure ends
the process with failure. Unknown object properties are accepted. Requests must
contain exactly one of `entries` or `query` and an unsigned 64-bit integer `id`.
Optional entry fields may be omitted; present nulls and wrong types are rejected.
Errors include `id` when a complete JSON object contains a valid unsigned ID.
Invalid JSON and oversized drained lines have no recoverable ID.

The helper holds named catalogs (`src/catalogs.rs`). A load,
`{"id":1,"catalog":"view","entries":[...]}`, replaces that name's list; a
search, `{"id":2,"catalog":"view","query":"web","sensitivity":"medium"}`,
searches it, and hit indexes refer to that list. A request without `catalog`
names `root`. A name is 1 to 64 ASCII letters, digits, `-`, `_`, `.` or `:`;
`null` or another type is rejected. Every rejected request preserves every
loaded catalog, and a rejected load of a new name does not add it. A
successful empty load counts as loaded; a search of a name before its first
successful load fails. `services/NativeSearch.qml` uses `root` for the root
candidates (which submenus and the Apps grid also search) and `view` for the
open scope's items or the settings rows.

The caller applies `Ranker.transliterate` to every input string and query once;
it also folds the Greek final sigma (`ς`) to `σ`, the only letter whose
lowercase depends on context (a word's last `Σ` lowercases to `ς` in a whole
text, to `σ` letter by letter, as the matcher does). The helper performs no
transliteration, normalization, trimming, or path search.
Each score comes directly from `Matcher::name_bytes`. Before scoring, a field is
skipped when upstream's letter-presence filter (`searchbits::possible` on the
query's and the field's `searchbits::mask`, the field mask computed once at load)
rules it out: the field lacks more query letters than the edit budget, or a digit
or punctuation of the query. The filter only rejects fields the matcher couldn't
score (non-ASCII text always passes), so results are identical. Hits retain loaded entry
order and contain explicit numeric or null `title`, `alternate`, `subtitle`, and
`keyword` scores. Entries with no surviving channel are omitted. Alternate and
keyword channels take their maximum score. A subtitle equal to the title after
Unicode lowercasing is not scored separately. Nonempty subtitles contribute both
`title + " " + subtitle` and `subtitle + " " + title` to keywords, even when the
subtitle duplicates the title. Bundle IDs contribute only to queries containing
a literal period. Empty queries return `hits: []` for legacy UI suggestions.

All channels drop shadow typo scores `<= SHADOW_TYPO` (`992000`). `low` keeps
every other score. Default `medium` and `high` keep a score of `NAME - HIT_SPAN`
(`1900000`) or more (query letters in order: name, word, prefix, exact) only when
the field passes the built-in matcher's threshold for that level, computed by
`src/strictness.rs` with the same score and thresholds as `core/Ranker.js`
(`fuzzyMatch`, `passesThreshold`), so a level matches the same rows with or
without the helper. An exact score, and a prefix score of an ASCII field for an
ASCII query without Ranker.js separators, pass without that check: Ranker.js
scores such a prefix above both thresholds. `low` and `medium` keep listed typo
scores; `high` drops them. At `high` the gate runs before the matcher: a
field it rejects keeps only an exact score, so the matcher scores such a field
only when it has as many characters as the query. A field that starts with a
plain ASCII query is scored as at the other levels, matcher first.

Ranker.js lets a query separator (tab, newline, space, `-`, `.`, `/`, `(`, `)`,
`[`, `]`) take any text separator or none, while the matcher reads it literally.
For a query with one, a field without an in-order score still matches at a
level when `src/strictness.rs` passes it at that level. Its score is the
matcher's score for the query without its separators, held to
`NAME +/- HIT_SPAN` (`NAME - HIT_SPAN` when that score is not in order). A field
that lacks a character of the query other than its separators is skipped first
(`searchbits::possible` with no edits; non-ASCII always passes).

`src/strictness.rs` lowercases the field and the query as Ranker.js does, then
folds `ς` to `σ` as Ranker.js does after every lowercasing. It decides most
fields without Ranker.js's alignment. It first finds the rows the alignment
places: a query separator row takes a text separator with gain 1, or is
skipped when its columns hold none. Paths it scores in one pass give lower
bounds on a field's score: those rows found whole, and for queries of 8 or
more letters the rows at their first places in order, then at places that
prefer adjacent rows and word starts (a search capped at twice the field's
length). For such queries, word starts, adjacent letter pairs and the field's
stretches of query pairs bound the letters' score, and each placed separator
row adds at most 1, or 2 between two letters. A field that no bound decides
runs the alignment, which fills at most one cell per query and field UTF-16
unit, no more than the matcher's own name DP over that field.
`tests/search-parity.test.js` runs both matchers over the same queries at every
level. Upstream name DP scores are bounded by `2000000 +/- 100000`; exact,
prefix, and word scores are `5000000`, `4000000`, and `3500000`. Upstream listed
typo scores are `999000` or `998000`: one edit from four alphanumeric query
characters, two from eight, and no edits when the query starts with a
non-alphanumeric character. Digits and punctuation remain literal.

Limits are inclusive: 4 catalog names, 40000 entries over all catalogs (a
reload counts its new list, not the one it replaces), 20000 entries per load, 1024 supplied text fields per
entry, 16384 UTF-8 bytes per supplied text field, 256 Unicode scalar values per
query, and 8 MiB per wire line excluding LF. The field count includes the title,
each present subtitle and bundle ID (including empty strings), and every
alternate-title and keyword array item. Generated keyword combinations are not
supplied fields. CR in CRLF counts toward the wire limit. Lines are read with
foamy-kit's bounded `foamy_helper::io::LineReader`: a line stops growing at the
limit, and an oversized line drains through LF or EOF using the existing reader
buffer. The last line may omit LF.

## Build and verification

Dependencies are `serde` (derive), `serde_json` and foamy-kit's `foamy-helper`
(vendored at `kit/rust/foamy-helper`, by path: the bounded line reader and the
panic exit); edition is 2024. The crate is
the `search` member of the plugin's root Cargo workspace; `Cargo.lock` and
`rust-toolchain.toml` (foamy-kit, Rust 1.99.1) sit at the plugin root. The release
binaries `bin/x86_64/foamy-menu-search` and `bin/aarch64/foamy-menu-search` are
committed, static musl, built reproducibly by the plugin's `kit/native/build-native.sh`
(through `bin/build-search`; CI rebuilds and attests them, see the README) with the kit's release profile (`kit/rust/release.toml`:
opt-level "s", fat LTO, `panic = "abort"`; `main` installs the kit's
`process::exit_on_panic(101)`, so a panic exits 101), and
recorded in `native.pin`. `bin/build-search --test` runs `cargo fmt --check`, clippy
with `-D warnings` and `cargo test --locked`; `bin/build-search --verify` rebuilds
in a fresh target dir and compares bytes. The integration tests execute the built
binary, or the one named by `FOAMY_HELPER` (a JSON argv prefix, e.g. the aarch64
build through qemu-user binfmt), and cover protocol recovery, reload atomicity,
channel scores, optional fields, reordered fields, Unicode, long requests, and each
input limit, named catalogs and their bounds. Unit tests also cover matcher
tiers, shadow removal, sensitivity, and
write/flush failure.
