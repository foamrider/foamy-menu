// The bundled helper and the built-in matcher (core/Ranker.js) must agree on
// what matches at each search strictness: the menu uses the built-in matcher
// when the helper is missing or fails, and the setting must mean the same
// either way. Ranking may differ; the matched set may not.
const test = require("node:test")
const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const readline = require("node:readline")
const R = require("../core/Ranker.js")
const F = require("../core/FleaSearch.js")
const helper = require("./search-helper.js")

const LEVELS = ["low", "medium", "high"]

const candidates = [
  { id: "ssh", title: "SSH", type: "command", subtitle: "Koble til en vert i ~/.ssh/config" },
  { id: "ssh-en", title: "SSH", type: "command", subtitle: "Connect to a host in ~/.ssh/config" },
  { id: "living", title: "Living Room Lights", type: "command" },
  { id: "firefox", title: "Firefox", type: "application", subtitle: "Web Browser", keywords: ["internet"] },
  { id: "files", title: "Files", type: "application" },
  { id: "dragon", title: "Fire Dragon", type: "application" },
  { id: "font", title: "Font Viewer", type: "application" },
  { id: "writer", title: "LibreOffice Writer", type: "application", keywords: ["word processor"] },
  { id: "code", title: "Visual Studio Code", type: "application", keywords: ["editor"] },
  { id: "calc", title: "Calculator", type: "application", alternateTitles: ["Kalkulator"] },
  { id: "bt", title: "Bluetooth Settings", type: "command" }
]

// [query, {level: matched ids}]; every row runs through both matchers.
const SHARED = [
  // The SSH row's subtitle holds l…i…v…i…n spread over four words: only the
  // loosest level takes it.
  ["livin", { low: ["living", "ssh"], medium: ["living"], high: ["living"] }],
  // Dropped letters: tighter levels need fewer gaps.
  ["frfx", { low: ["firefox"], medium: ["firefox"], high: [] }],
  ["settngs", { low: ["bt"], medium: ["bt"], high: [] }],
  ["vsc", { low: ["code", "ssh"], medium: ["code", "ssh"], high: ["code", "ssh"] }],
  ["lw", { low: ["writer"], medium: ["writer"], high: ["writer"] }],
  ["fx", { low: ["firefox"], medium: ["firefox"], high: ["firefox"] }],
  // Prefix and word starts in titles.
  ["fir", { low: ["dragon", "firefox", "font", "writer"], medium: ["dragon", "firefox", "font"], high: ["dragon", "firefox"] }],
  ["f", { low: ["dragon", "files", "firefox", "font", "ssh", "ssh-en", "writer"], medium: ["dragon", "files", "firefox", "font"], high: ["dragon", "files", "firefox", "font"] }],
  ["fire dragon", { low: ["dragon"], medium: ["dragon"], high: ["dragon"] }],
  // Subtitles, keywords and alternate titles.
  ["browser", { low: ["firefox"], medium: ["firefox"], high: ["firefox"] }],
  ["web", { low: ["firefox"], medium: ["firefox"], high: ["firefox"] }],
  ["vert", { low: ["ssh"], medium: ["ssh"], high: ["ssh"] }],
  ["config", { low: ["ssh", "ssh-en"], medium: ["ssh", "ssh-en"], high: ["ssh", "ssh-en"] }],
  ["internet", { low: ["firefox"], medium: ["firefox"], high: ["firefox"] }],
  ["editor", { low: ["code"], medium: ["code"], high: ["code"] }],
  ["kalk", { low: ["calc"], medium: ["calc"], high: ["calc"] }],
  ["zzz", { low: [], medium: [], high: [] }]
]

// Edit typos (swapped or wrong letters) are the helper's own: the built-in
// matcher only finds letters in order. The helper takes them below `high`.
const HELPER_TYPOS = [
  ["fierfox", "firefox"],
  ["firefoc", "firefox"],
  ["calculatro", "calc"]
]

function builtIn(query, sensitivity) {
  return R.rank(candidates, query, { nowMs: 0, sensitivity }).map((r) => r.candidate.id).sort()
}

async function start(t) {
  const child = spawn(helper.argv[0], helper.argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let id = 0
  const ask = async (obj) => {
    child.stdin.write(JSON.stringify({ id: ++id, ...obj }) + "\n")
    return JSON.parse((await lines.next()).value)
  }
  assert.equal((await ask({ entries: F.entries(candidates, R.transliterate) })).loaded, candidates.length)
  const ids = candidates.map((c) => c.id)
  // The query as Backend.qml sends it.
  return async (query, sensitivity) => {
    const reply = await ask({ query: R.transliterate(query.toLowerCase()), sensitivity })
    return Object.keys(F.hits(F.reply(JSON.stringify(reply)), ids)).sort()
  }
}

test("the built-in matcher matches the expected ids at each level", () => {
  const differ = []
  for (const [query, expected] of SHARED)
    for (const level of LEVELS) {
      const js = builtIn(query, level)
      if (JSON.stringify(js) !== JSON.stringify([...expected[level]].sort())) differ.push(`${query} at ${level}: ${js}`)
    }
  assert.deepEqual(differ, [])
})

test("the helper and the built-in matcher match the same ids at each level", { skip: helper.skip, timeout: 10000 }, async (t) => {
  const search = await start(t)
  const differ = []
  for (const [query] of SHARED)
    for (const level of LEVELS) {
      const native = await search(query, level)
      const js = builtIn(query, level)
      if (JSON.stringify(native) !== JSON.stringify(js)) differ.push(`${query} at ${level}: helper ${native}, built-in ${js}`)
    }
  assert.deepEqual(differ, [])
})

test("edit typos match in the helper below high only", { skip: helper.skip, timeout: 10000 }, async (t) => {
  const search = await start(t)
  for (const [query, id] of HELPER_TYPOS) {
    for (const level of ["low", "medium"]) assert.ok((await search(query, level)).includes(id), `${query} at ${level}`)
    assert.ok(!(await search(query, "high")).includes(id), `${query} at high`)
    for (const level of LEVELS) assert.ok(!builtIn(query, level).includes(id), `built-in ${query} at ${level}`)
  }
})
