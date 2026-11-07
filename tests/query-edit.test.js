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

test("the cursor never splits a character beyond U+FFFF", () => {
  const smile = "\u{1F600}"
  const s = Q.state(smile, 2)
  assert.equal(Q.move(s, -1, false).cursor, 0, "← steps over the whole emoji")
  assert.equal(Q.insert(Q.move(s, -1, false), "x").text, "x" + smile)
  assert.equal(Q.move(Q.state(smile, 0), 1, false).cursor, 2)
  assert.equal(Q.backspace(Q.state("a" + smile, 3), false).text, "a", "Backspace removes the whole emoji")
  assert.equal(Q.deleteForward(Q.state(smile + "b", 0), false).text, "b")
  assert.equal(Q.state(smile, 1).cursor, 2, "a cursor inside the pair moves past it")
  assert.equal(Q.indexAt(smile, 9, (p) => p.length * 10), 0, "a click never lands inside it")
  assert.equal(Q.indexAt(smile, 11, (p) => p.length * 10), 2)
})

test("a long query scrolls just enough to keep the cursor in view", () => {
  assert.equal(Q.scrollFor(50, 30, 80, 100), 0, "fits: no scroll")
  assert.equal(Q.scrollFor(0, 300, 300, 100), 200, "the end in view")
  assert.equal(Q.scrollFor(200, 0, 300, 100), 0, "Home: the start in view")
  assert.equal(Q.scrollFor(200, 250, 300, 100), 200, "a visible cursor leaves the scroll alone")
  assert.equal(Q.scrollFor(200, 150, 300, 100), 150, "just enough to the left")
})
