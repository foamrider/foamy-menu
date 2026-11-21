const test = require("node:test")
const assert = require("node:assert/strict")
const Migrate = require("../core/Migrate.js")
const Schema = require("../core/Schema.js")

const migrations = [
  { version: 1, name: "init", up: (d) => { d.items = []; return d } },
  { version: 2, name: "add-flag", up: (d) => { d.flag = true } }
]

test("a new document runs every migration and records history", () => {
  const r = Migrate.migrate(null, migrations, 1000)
  assert.equal(r.from, 0)
  assert.equal(r.to, 2)
  assert.ok(r.changed)
  assert.deepEqual(r.applied, ["init", "add-flag"])
  assert.deepEqual(r.doc, {
    items: [], flag: true, schemaVersion: 2,
    schemaHistory: [{ version: 1, name: "init", appliedAt: 1000 }, { version: 2, name: "add-flag", appliedAt: 1000 }]
  })
})

test("only pending migrations run, and the input is not mutated", () => {
  const v1 = { items: [1], schemaVersion: 1, schemaHistory: [{ version: 1, name: "init", appliedAt: 5 }] }
  const before = JSON.stringify(v1)
  const r = Migrate.migrate(v1, migrations, 9)
  assert.deepEqual(r.applied, ["add-flag"])
  assert.deepEqual(r.doc.items, [1])
  assert.equal(r.doc.schemaHistory.length, 2)
  assert.equal(JSON.stringify(v1), before)
})

test("an up-to-date document is unchanged", () => {
  const latest = Migrate.migrate(null, migrations, 1).doc
  const r = Migrate.migrate(latest, migrations, 2)
  assert.equal(r.changed, false)
  assert.deepEqual(r.doc, latest)
})

test("a document from a newer build is read-only and untouched", () => {
  const future = { schemaVersion: 7, items: ["x"] }
  const r = Migrate.migrate(future, migrations, 1)
  assert.equal(r.readOnly, true)
  assert.equal(r.changed, false)
  assert.deepEqual(r.doc, future)
})

test("an invalid schemaVersion is reported, not migrated", () => {
  const r = Migrate.migrate({ schemaVersion: "two" }, migrations, 1)
  assert.equal(r.readOnly, true)
  assert.match(r.error, /invalid schemaVersion/)
})

test("migration lists must be numbered 1..n with names", () => {
  assert.throws(() => Migrate.validateMigrations([{ version: 2, name: "x", up() {} }]), /in order/)
  assert.throws(() => Migrate.validateMigrations([{ version: 1, name: "Bad Name", up() {} }]), /kebab-case/)
  assert.throws(() => Migrate.validateMigrations([{ version: 1, name: "x" }]), /no up/)
})

test("parse separates new, valid, and unreadable files", () => {
  assert.deepEqual(Migrate.parse(""), { doc: null, error: "" })
  assert.deepEqual(Migrate.parse('{"a":1}'), { doc: { a: 1 }, error: "" })
  assert.match(Migrate.parse("{oops").error, /JSON|Expected|Unexpected/)
  assert.match(Migrate.parse("[1]").error, /not a JSON object/)
})

test("the shipped migrations give a new store the fields the launcher reads", () => {
  for (const name of Object.keys(Schema.documents)) {
    const { migrations } = Schema.documents[name]
    const r = Migrate.migrate(null, migrations, 1)
    assert.equal(r.readOnly, false, name + ": " + r.error)
    assert.equal(r.doc.schemaVersion, migrations.length, name + " is at the newest version")
  }
  const fresh = (name) => Migrate.migrate(null, Schema.documents[name].migrations, 1).doc
  const settings = fresh("settings")
  assert.equal(settings.general.uiZoom, 1, "settings: the zoom the window scales by")
  assert.deepEqual(settings.commands, {}, "settings: aliases, favorites and disabled commands")
  const frecency = fresh("frecency")
  assert.deepEqual([frecency.items, frecency.searchHistory], [{}, []], "frecency: visits and search history")
  assert.deepEqual(fresh("calculator").history, [], "calculator: the history list")
})
