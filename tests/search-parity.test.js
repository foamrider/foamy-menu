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
  { id: "code", title: "Visual Studio Code", type: "application", keywords: ["editor"], bundleId: "com.visualstudio.code" },
  { id: "calc", title: "Calculator", type: "application", alternateTitles: ["Kalkulator"] },
  { id: "bt", title: "Bluetooth Settings", type: "command" },
  { id: "sok", title: "Innstillinger", type: "command", subtitle: "Åpne søkeinnstillinger" },
  { id: "kbd", title: "Tastatur", type: "command", alternateTitles: ["Tastaturoppsett"], keywords: ["språk"] },
  { id: "gt", title: "GNOME Terminal", type: "application", subtitle: "Use the command line" },
  { id: "bl", title: "Blåtann", type: "command" },
  { id: "wifi", title: "Wi-Fi", type: "command", subtitle: "Trådløst nettverk", keywords: ["nettverksinnstillinger"] },
  { id: "naut", title: "Filbehandler", type: "application", bundleId: "org.gnome.Nautilus" },
  { id: "skjaer", title: "Skjærgård", type: "command", alternateTitles: ["Øyrike"] },
  { id: "os", title: "ΟΣ", type: "command" },
  { id: "odysseus", title: "Οδυσσεύς", type: "command" }
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
  ["lw", { low: ["wifi", "writer"], medium: ["wifi", "writer"], high: ["writer"] }],
  ["fx", { low: ["firefox"], medium: ["firefox"], high: ["firefox"] }],
  // Prefix and word starts in titles.
  ["fir", { low: ["dragon", "firefox", "font", "naut", "wifi", "writer"], medium: ["dragon", "firefox", "font", "naut", "wifi"], high: ["dragon", "firefox", "naut"] }],
  ["f", { low: ["dragon", "files", "firefox", "font", "naut", "ssh", "ssh-en", "wifi", "writer"], medium: ["dragon", "files", "firefox", "font", "naut", "wifi"], high: ["dragon", "files", "firefox", "font", "naut", "wifi"] }],
  ["fire dragon", { low: ["dragon"], medium: ["dragon"], high: ["dragon"] }],
  // Subtitles, keywords and alternate titles.
  ["browser", { low: ["firefox"], medium: ["firefox"], high: ["firefox"] }],
  ["web", { low: ["firefox"], medium: ["firefox"], high: ["firefox"] }],
  ["vert", { low: ["ssh", "wifi"], medium: ["ssh", "wifi"], high: ["ssh"] }],
  ["config", { low: ["ssh", "ssh-en"], medium: ["ssh", "ssh-en"], high: ["ssh", "ssh-en"] }],
  ["internet", { low: ["firefox", "sok"], medium: ["firefox", "sok"], high: ["firefox"] }],
  ["editor", { low: ["code"], medium: ["code"], high: ["code"] }],
  ["kalk", { low: ["calc"], medium: ["calc"], high: ["calc"] }],
  ["zzz", { low: [], medium: [], high: [] }],
  // Norwegian letters fold the same way in every field and in the query:
  // the subtitle "Åpne søkeinnstillinger", the keyword "språk", the
  // alternate title "Øyrike".
  ["sok", { low: ["sok"], medium: ["sok"], high: ["sok"] }],
  ["søk", { low: ["sok"], medium: ["sok"], high: ["sok"] }],
  ["apne", { low: ["sok"], medium: ["sok"], high: ["sok"] }],
  ["åpne", { low: ["sok"], medium: ["sok"], high: ["sok"] }],
  ["sprak", { low: ["kbd"], medium: ["kbd"], high: ["kbd"] }],
  ["språk", { low: ["kbd"], medium: ["kbd"], high: ["kbd"] }],
  ["spr", { low: ["kbd", "sok"], medium: ["kbd"], high: ["kbd"] }],
  ["blat", { low: ["bl"], medium: ["bl"], high: ["bl"] }],
  ["blå", { low: ["bl"], medium: ["bl"], high: ["bl"] }],
  ["trådløst", { low: ["wifi"], medium: ["wifi"], high: ["wifi"] }],
  ["tradlost", { low: ["wifi"], medium: ["wifi"], high: ["wifi"] }],
  ["øyr", { low: ["skjaer"], medium: ["skjaer"], high: ["skjaer"] }],
  ["oyr", { low: ["skjaer"], medium: ["skjaer"], high: ["skjaer"] }],
  ["skjær", { low: ["skjaer"], medium: ["skjaer"], high: ["skjaer"] }],
  // "æ" folds to "ae": the threshold counts the folded query's four letters.
  ["jær", { low: ["skjaer"], medium: ["skjaer"], high: [] }],
  // A query separator takes any text separator or none: "-" and "." for a
  // space, a space for nothing ("Tastaturoppsett"), and the reverse.
  ["gnome t", { low: ["gt"], medium: ["gt"], high: ["gt"] }],
  ["gnome-t", { low: ["gt"], medium: ["gt"], high: ["gt"] }],
  ["wi fi", { low: ["wifi"], medium: ["wifi"], high: ["wifi"] }],
  ["wifi", { low: ["wifi"], medium: ["wifi"], high: ["wifi"] }],
  ["tast opp", { low: ["kbd"], medium: ["kbd"], high: ["kbd"] }],
  ["tast-opp", { low: ["kbd"], medium: ["kbd"], high: ["kbd"] }],
  ["v.s", { low: ["code", "living", "ssh", "wifi"], medium: ["code", "ssh"], high: ["code"] }],
  ["f.b", { low: ["firefox", "naut"], medium: ["firefox", "naut"], high: ["firefox", "naut"] }],
  // Bundle ids, for queries with a period.
  ["com.vis", { low: ["code"], medium: ["code"], high: ["code"] }],
  ["org.n", { low: ["naut"], medium: ["naut"], high: ["naut"] }],
  ["gnome.naut", { low: ["gt", "naut"], medium: ["gt", "naut"], high: ["naut"] }],
  // Several words, across the title and its subtitle.
  ["use the", { low: ["gt"], medium: ["gt"], high: ["gt"] }],
  ["fire drag", { low: ["dragon"], medium: ["dragon"], high: ["dragon"] }],
  ["firedragon", { low: ["dragon"], medium: ["dragon"], high: ["dragon"] }],
  ["browser fire", { low: ["firefox"], medium: ["firefox"], high: ["firefox"] }],
  ["ssh config", { low: ["ssh", "ssh-en"], medium: ["ssh", "ssh-en"], high: ["ssh", "ssh-en"] }],
  ["trå nett", { low: ["wifi"], medium: ["wifi"], high: ["wifi"] }],
  // Lowercasing a whole word gives a final sigma ("ΟΣ" gives "ος"); the
  // helper's matcher lowercases each letter ("οσ"). Both sides fold it.
  ["ΟΣ", { low: ["odysseus", "os"], medium: ["odysseus", "os"], high: ["odysseus", "os"] }],
  ["οσ", { low: ["odysseus", "os"], medium: ["odysseus", "os"], high: ["odysseus", "os"] }],
  ["ος", { low: ["odysseus", "os"], medium: ["odysseus", "os"], high: ["odysseus", "os"] }]
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
