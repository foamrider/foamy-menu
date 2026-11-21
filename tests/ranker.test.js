const test = require("node:test")
const assert = require("node:assert/strict")
const R = require("../core/Ranker.js")

const NOW = 1_800_000_000_000
const DAY_MS = 86_400_000
const titles = (ranked) => ranked.map((x) => x.candidate.title)
const app = (title, extra = {}) => ({ id: title, type: "application", title, ...extra })

test("transliterate folds diacritics to ASCII", () => {
  assert.equal(R.transliterate("Café Ærø Straße"), "Cafe AEro Strasse")
})

test("the final sigma folds to sigma, as the helper lowercases letter by letter", () => {
  assert.equal(R.transliterate("Οδυσσεύς"), "Οδυσσευσ")
  assert.equal(R.normalize("ΟΣ").normalizedText, "οσ")
  for (const query of ["ΟΣ", "οσ", "ος"]) assert.equal(R.fuzzyMatch("ΟΣ", query), "exact", query)
  // "İ" lowercases to "i" and a combining dot, which transliterate removes.
  assert.equal(R.transliterate("İstanbul".toLowerCase()), "istanbul")
  assert.equal(R.transliterate("İstanbul"), "Istanbul")
})

test("fuzzyMatch golden scores", () => {
  assert.deepEqual(R.fuzzyMatch("Firefox", "fir"), { score: 8, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("Firefox", "fx"), { score: 5, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("LibreOffice Writer", "lw"), { score: 6, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("LibreOffice Writer", "lo"), { score: 6, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("Visual Studio Code", "vsc"), { score: 8, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("foo-bar", "f-b"), { score: 7, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("Font Viewer", "fir"), { score: 6, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("LibreOffice Writer", "fir"), { score: 5, skipped: 0 })
})

test("fuzzyMatch exact, unmatched and separator skipping", () => {
  assert.equal(R.fuzzyMatch("Firefox", "firefox"), "exact")
  assert.equal(R.fuzzyMatch("abc", "cba"), "unmatched")
  assert.equal(R.fuzzyMatch("Files", "fir"), "unmatched")
  assert.equal(R.fuzzyMatch("ab", "abc"), "unmatched")
  assert.deepEqual(R.fuzzyMatch("Firefox", "fire "), { score: 10, skipped: 1 })
})

test("query 'fir' over a realistic app list", () => {
  const apps = ["Firefox", "Files", "Fire Dragon", "Chromium", "Signal", "LibreOffice Writer", "Alacritty", "Font Viewer"].map((t) => app(t))
  assert.deepEqual(titles(R.rank(apps, "fir", { nowMs: NOW })), ["Fire Dragon", "Firefox", "Font Viewer"])
  assert.deepEqual(titles(R.rank(apps, "fir", { nowMs: NOW, sensitivity: "high" })), ["Fire Dragon", "Firefox"])
  assert.deepEqual(titles(R.rank(apps, "fir", { nowMs: NOW, sensitivity: "low" })), ["Fire Dragon", "Firefox", "Font Viewer", "LibreOffice Writer"])
  apps[0].frecency = 101
  assert.deepEqual(titles(R.rank(apps, "fir", { nowMs: NOW })), ["Firefox", "Fire Dragon", "Font Viewer"])
})

test("aliases: exact beats everything, prefix beats a better title", () => {
  assert.equal(R.aliasMatch("ff", "ff"), "exact")
  assert.equal(R.aliasMatch("ffx", "ff"), "prefix")
  assert.equal(R.aliasMatch("f", "ff"), "unmatched")
  const items = [
    app("Firefox", { alias: "ff" }),
    { id: "c", type: "command", title: "ff", frecency: 500 },
    app("Fluffy")
  ]
  assert.equal(titles(R.rank(items, "ff", { nowMs: NOW }))[0], "Firefox")
  const prefix = [app("Fluffy Forest"), { id: "x", type: "command", title: "Xylophone", alias: "flu" }]
  assert.deepEqual(titles(R.rank(prefix, "fl", { nowMs: NOW })), ["Xylophone", "Fluffy Forest"])
})

test("search terms: exact beats a stronger title, expires after 17 days", () => {
  const terms = [{ term: "browser", at: NOW - DAY_MS }]
  assert.deepEqual(R.searchTermMatch(terms, "browser", 101, NOW - DAY_MS, NOW), { kind: "exact", count: 0 })
  assert.deepEqual(R.searchTermMatch(terms, "brow", 101, NOW - DAY_MS, NOW), { kind: "prefix", count: 0 })
  assert.deepEqual(R.searchTermMatch(terms, "browsers!", 101, NOW - DAY_MS, NOW), { kind: "overbounds", count: 2 })
  assert.deepEqual(R.searchTermMatch(terms, "browser1234", 101, NOW - DAY_MS, NOW), { kind: "none", count: 0 })
  assert.equal(R.searchTermMatch(terms, "browser", 1, NOW - DAY_MS, NOW).kind, "none")
  assert.equal(R.searchTermMatch(terms, "browser", 101, NOW - 18 * DAY_MS, NOW).kind, "none")

  const items = [
    app("Firefox", { subtitle: "Web Browser", frecency: 101, openedAt: NOW - DAY_MS, searchTerms: ["web"] }),
    app("Web Builder")
  ]
  assert.deepEqual(titles(R.rank(items, "web", { nowMs: NOW })), ["Firefox", "Web Builder"])
  items[0].openedAt = NOW - 18 * DAY_MS
  assert.deepEqual(titles(R.rank(items, "web", { nowMs: NOW })), ["Web Builder", "Firefox"])
})

test("overbounds of 3+ beats a better title score", () => {
  const items = [
    app("Terminal", { frecency: 50, openedAt: NOW - DAY_MS, searchTerms: ["te"] }),
    app("Tetris")
  ]
  assert.deepEqual(titles(R.rank(items, "tetr", { nowMs: NOW })), ["Tetris"])
  const items2 = [
    app("Kitty", { keywords: ["terminal"], frecency: 50, openedAt: NOW - DAY_MS, searchTerms: ["t"] }),
    app("Tetris")
  ]
  assert.deepEqual(titles(R.rank(items2, "term", { nowMs: NOW })), ["Kitty"])
  const items3 = [
    app("Kitty", { keywords: ["terminal"], frecency: 50, openedAt: NOW - DAY_MS, searchTerms: ["t"] }),
    app("Termius")
  ]
  assert.deepEqual(titles(R.rank(items3, "term", { nowMs: NOW })), ["Kitty", "Termius"])
})

test("a whole-word match of 3+ letters beats the prefix of a longer word", () => {
  assert.deepEqual(titles(R.rank([app("Writerly Notes App"), app("LibreOffice Writer")], "writer", { nowMs: NOW })), ["LibreOffice Writer", "Writerly Notes App"])
  // A camelCase part counts as a word.
  assert.deepEqual(titles(R.rank([app("Officer Tools"), app("LibreOffice")], "office", { nowMs: NOW })), ["LibreOffice", "Officer Tools"])
})

test("an empty query orders by use, then alias, type and title", () => {
  const items = [
    { id: "1", type: "command", title: "Able" },
    app("Delta"),
    app("Beta"),
    { id: "4", type: "command", title: "Gamma", alias: "g" },
    { id: "7", type: "command", title: "Hot", frecency: 300 }
  ]
  // Applications come before commands, whatever the title says.
  assert.deepEqual(titles(R.rank(items, "", { nowMs: NOW })), ["Hot", "Gamma", "Beta", "Delta", "Able"])
})

test("exact titles win over fuzzy ones in a bucket", () => {
  const items = [app("Code Editor"), { id: "c", type: "command", title: "Code" }]
  assert.deepEqual(titles(R.rank(items, "code", { nowMs: NOW })), ["Code", "Code Editor"])
})

test("an exact subtitle finds the row and leads", () => {
  const items = [
    app("Filesystem Viewer"),
    { id: "x", type: "command", title: "Xylophone", alias: "filesync" },
    app("Nautilus", { subtitle: "Files" })
  ]
  // It beats a title prefix and an alias prefix.
  assert.deepEqual(titles(R.rank(items, "files", { nowMs: NOW })), ["Nautilus", "Xylophone", "Filesystem Viewer"])
})

test("every field folds like the title and the query", () => {
  const c = app("Innstillinger", {
    subtitle: "Åpne søkeinnstillinger", alternateTitles: ["Blåtann"], keywords: ["språk"], bundleId: "no.Ærlig.app"
  })
  for (const query of ["sok", "søk", "apne", "blat", "blå", "sprak", "språk", "no.aer", "no.ær"])
    assert.ok(R.buildRecord(c, query, { nowMs: NOW, sensitivity: "high" }).isMatching, query)
  assert.ok(R.buildRecord(app("Kart", { subtitle: "Åpne" }), "apne", { nowMs: NOW }).subtitleExact)
  // A folded alternate title counts as a title prefix for ranking.
  assert.equal(R.buildRecord(c, "blå", { nowMs: NOW }).titleMatch, "prefix")
  // A subtitle that folds to the title is not scored on its own.
  assert.equal(R.buildRecord(app("Ærlig", { subtitle: "aerlig" }), "aer", { nowMs: NOW }).subtitle, null)
  // The threshold counts the folded query: "jær" is four letters, inside a
  // word, so it matches only below high.
  const skjaer = app("Skjærgård")
  assert.ok(R.buildRecord(skjaer, "jær", { nowMs: NOW, sensitivity: "medium" }).isMatching)
  assert.ok(!R.buildRecord(skjaer, "jær", { nowMs: NOW, sensitivity: "high" }).isMatching)
})

test("bundle ids match only when the query has a dot", () => {
  const c = app("Firefox", { bundleId: "org.mozilla.firefox" })
  assert.ok(!R.buildRecord(c, "mozilla", { nowMs: NOW }).isMatching)
  assert.ok(R.buildRecord(c, "org.moz", { nowMs: NOW }).isMatching)
})
