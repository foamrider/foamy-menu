// The search field's line editing (core/QueryEdit.js): insert, delete and
// move at a cursor, by character or word.
const test = require("node:test")
const assert = require("node:assert/strict")
const Q = require("../core/QueryEdit.js")

const at = (marked) => Q.state(marked.replace("|", ""), marked.indexOf("|"))
const show = (s) => s.text.slice(0, s.cursor) + "|" + s.text.slice(s.cursor)

test("typing and pasting insert at the cursor", () => {
  assert.equal(show(Q.insert(at("gm|es"), "a")), "gma|es")
  assert.equal(show(Q.insert(at("|rock"), "deep ")), "deep |rock")
  assert.equal(show(Q.insert(at("x|"), "")), "x|")
})

test("Backspace and Delete remove a character or, with Ctrl, a word", () => {
  assert.equal(show(Q.backspace(at("gam|es"), false)), "ga|es")
  assert.equal(show(Q.backspace(at("|games"), false)), "|games", "nothing before the start")
  assert.equal(show(Q.backspace(at("deep rock  |gal"), true)), "deep |gal", "spaces, then the word")
  assert.equal(show(Q.deleteForward(at("ga|mes"), false)), "ga|es")
  assert.equal(show(Q.deleteForward(at("games|"), false)), "games|", "nothing after the end")
  assert.equal(show(Q.deleteForward(at("deep| rock gal"), true)), "deep| gal")
  assert.equal(show(Q.killToStart(at("deep |rock"))), "|rock", "Ctrl+U clears what is before the cursor")
  assert.equal(show(Q.killToStart(at("deep rock|"))), "|", "all of it at the end")
})

test("the cursor moves by character, by word, and to either end", () => {
  assert.equal(show(Q.move(at("ab|c"), -1, false)), "a|bc")
  assert.equal(show(Q.move(at("|abc"), -1, false)), "|abc")
  assert.equal(show(Q.move(at("abc|"), 1, false)), "abc|")
  assert.equal(show(Q.move(at("deep rock|"), -1, true)), "deep |rock")
  assert.equal(show(Q.move(at("deep |rock"), -1, true)), "|deep rock")
  assert.equal(show(Q.move(at("|deep rock"), 1, true)), "deep| rock")
  assert.equal(show(Q.move(at("deep| rock"), 1, true)), "deep rock|")
  assert.equal(show(Q.home(at("ab|c"))), "|abc")
  assert.equal(show(Q.end(at("a|bc"))), "abc|")
  assert.equal(Q.state("abc", 9).cursor, 3, "out of range clamps")
  assert.equal(Q.state("abc", undefined).cursor, 3, "no cursor means the end")
})

test("a click lands on the nearest character boundary", () => {
  const advance = (prefix) => prefix.length * 10
  assert.equal(Q.indexAt("games", 0, advance), 0)
  assert.equal(Q.indexAt("games", 14, advance), 1)
  assert.equal(Q.indexAt("games", 16, advance), 2)
  assert.equal(Q.indexAt("games", 999, advance), 5)
})
