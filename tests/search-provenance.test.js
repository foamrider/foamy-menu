const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const search = path.join(__dirname, "../search")
const provenance = fs.readFileSync(path.join(search, "PROVENANCE.md"), "utf8")
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex")
// The one documented edit: searchmatch.rs drops its trailing test module.
const removed = { "searchmatch.rs": '\n#[cfg(test)]\n#[path = "searchmatch_tests.rs"]\npub(crate) mod tests;\n' }

test("vendored Flea files match the upstream hashes in PROVENANCE.md", () => {
  const rows = [...provenance.matchAll(/^\| `([a-z]+\.rs)` \| `([0-9a-f]{64})` \|$/gm)]
  assert.deepEqual(rows.map(r => r[1]).sort(), ["searchascii.rs", "searchbits.rs", "searchmatch.rs", "searchtypo.rs"])
  for (const [, file, hash] of rows) {
    const body = fs.readFileSync(path.join(search, "src/backend", file))
    assert.equal(sha256(Buffer.concat([body, Buffer.from(removed[file] || "")])), hash, file)
  }
})

test("the vendored license matches PROVENANCE.md", () => {
  const hash = provenance.match(/verbatim in `LICENSE`, SHA-256\s+`([0-9a-f]{64})`/)[1]
  assert.equal(sha256(fs.readFileSync(path.join(search, "LICENSE"))), hash)
})
