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
  { id: "odysseus", title: "Οδυσσεύς", type: "command" },
  { id: "kas", title: "ΚΑΣ ΒΓ", type: "command" },
  { id: "slash", title: "/x", type: "command" },
  { id: "root", title: "/", type: "command" }
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
  ["ος", { low: ["odysseus", "os"], medium: ["odysseus", "os"], high: ["odysseus", "os"] }],
  // A word-final capital sigma inside a title, found as a prefix.
  ["κασ", { low: ["kas"], medium: ["kas"], high: ["kas"] }],
  // A title that starts with "/" and is the whole query matches at every level.
  // The loosest level also takes a separator and an "x" anywhere.
  ["/x", { low: ["firefox", "slash"], medium: ["slash"], high: ["slash"] }],
  ["/", { low: ["bt", "code", "dragon", "firefox", "font", "gt", "kas", "living", "root", "slash", "sok", "ssh", "ssh-en", "wifi", "writer"], medium: ["root"], high: ["root"] }]
]

// Edit typos (swapped or wrong letters) are the helper's own: the built-in
// matcher only finds letters in order. The helper takes them below `high`.
const HELPER_TYPOS = [
  ["fierfox", "firefox"],
  ["firefoc", "firefox"],
  ["calculatro", "calc"]
]

function builtIn(query, sensitivity, list = candidates) {
  return R.rank(list, query, { nowMs: 0, sensitivity }).map((r) => r.candidate.id).sort()
}

async function start(t, list = candidates) {
  const child = spawn(helper.argv[0], helper.argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let id = 0
  const ask = async (obj) => {
    child.stdin.write(JSON.stringify({ id: ++id, ...obj }) + "\n")
    return JSON.parse((await lines.next()).value)
  }
  assert.equal((await ask({ entries: F.entries(list, R.transliterate) })).loaded, list.length)
  const ids = list.map((c) => c.id)
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

// A seeded generator (mulberry32), so every run checks the same rows.
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), a | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

// Candidates with random words (some capitalised, with Norwegian and other
// folded letters, separators, a leading "/") in every field, and queries cut
// from those fields: prefixes, pieces, letters left out, a "/" in front,
// and random words.
function randomRound(seed) {
  const next = random(seed)
  const pick = (list) => list[Math.floor(next() * list.length)]
  const word = () => {
    let w = ""
    for (let n = 2 + Math.floor(next() * 7); n > 0; n--) w += next() < 0.06 ? pick("æøåéüß") : pick("abcdefghijklmnopqrstuvwxyz")
    return next() < 0.05 ? w.toUpperCase() : next() < 0.3 ? w.charAt(0).toUpperCase() + w.slice(1) : w
  }
  const text = () => {
    let s = next() < 0.15 ? "/" : ""
    for (let n = 1 + Math.floor(next() * 3), i = 0; i < n; i++) s += (i ? pick("   -./()") : "") + word()
    return s
  }
  const list = []
  for (let i = 0; i < 30; i++) {
    const c = { id: "r" + i, title: text(), type: next() < 0.5 ? "application" : "command" }
    if (next() < 0.4) c.subtitle = text()
    if (next() < 0.2) c.keywords = [text()]
    if (next() < 0.15) c.alternateTitles = [text()]
    list.push(c)
  }
  const queries = []
  while (queries.length < 40) {
    const c = pick(list)
    const field = pick([c.title, c.subtitle, ...(c.keywords || []), ...(c.alternateTitles || [])].filter(Boolean))
    const kind = next()
    let q
    if (kind < 0.3) q = field.slice(0, 1 + Math.floor(next() * field.length))
    else if (kind < 0.55) {
      const at = Math.floor(next() * field.length)
      q = field.slice(at, at + 1 + Math.floor(next() * 6))
    } else if (kind < 0.85) q = [...field].filter(() => next() < 0.5).join("")
    else q = word()
    if (next() < 0.1) q = "/" + q
    q = (next() < 0.2 ? q.toLowerCase() : q).trim()
    if (q) queries.push(q)
  }
  return { list, queries }
}

// Below high the helper also takes edit typos, so there the built-in matches
// must be among the helper's; at high both match the same rows.
test("random fields and queries: the built-in matches are the helper's, and the same at high", { skip: helper.skip, timeout: 30000 }, async (t) => {
  const differ = []
  for (let seed = 1; seed <= 10; seed++) {
    const { list, queries } = randomRound(seed)
    const search = await start(t, list)
    const fields = (id) => JSON.stringify(list.find((c) => c.id === id))
    for (const query of queries)
      for (const level of LEVELS) {
        const native = await search(query, level)
        const js = builtIn(query, level, list)
        const extra = js.filter((id) => !native.includes(id))
        const missing = level === "high" ? native.filter((id) => !js.includes(id)) : []
        if (extra.length || missing.length)
          differ.push(`seed ${seed}, ${JSON.stringify(query)} at ${level}: only the built-in matcher ${extra.map(fields)}; only the helper ${missing.map(fields)}`)
      }
  }
  assert.deepEqual(differ, [])
})
