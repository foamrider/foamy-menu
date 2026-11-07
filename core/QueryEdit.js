// The search field's text and cursor: a line editor without selection.
// Each edit takes { text, cursor } and returns the next { text, cursor }; the
// cursor is a character index, 0 (before the first) to text.length (after
// the last). The launcher's search field is drawn text, not a TextInput, so
// its keys come here (LauncherWindow.handleKey).

function clamp(text, cursor) {
  var n = Number(cursor)
  if (!isFinite(n)) return text.length
  return Math.max(0, Math.min(text.length, Math.round(n)))
}

function state(text, cursor) {
  var t = String(text || "")
  return { text: t, cursor: clamp(t, cursor) }
}

// The start of the word before the cursor: spaces, then the word, as
// Ctrl+Backspace and Ctrl+← treat them in a shell.
function wordStart(text, cursor) {
  var i = cursor
  while (i > 0 && /\s/.test(text.charAt(i - 1))) i--
  while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--
  return i
}

// The end of the word after the cursor: spaces, then the word.
function wordEnd(text, cursor) {
  var i = cursor
  while (i < text.length && /\s/.test(text.charAt(i))) i++
  while (i < text.length && !/\s/.test(text.charAt(i))) i++
  return i
}

function insert(s, value) {
  var v = String(value || "")
  return { text: s.text.slice(0, s.cursor) + v + s.text.slice(s.cursor), cursor: s.cursor + v.length }
}

function removeRange(s, from, to) {
  return { text: s.text.slice(0, from) + s.text.slice(to), cursor: from }
}

// Backspace: the character before the cursor, or the word with Ctrl.
function backspace(s, word) {
  if (s.cursor === 0) return s
  return removeRange(s, word ? wordStart(s.text, s.cursor) : s.cursor - 1, s.cursor)
}

// Delete: the character after the cursor, or the word with Ctrl.
function deleteForward(s, word) {
  if (s.cursor === s.text.length) return s
  return removeRange(s, s.cursor, word ? wordEnd(s.text, s.cursor) : s.cursor + 1)
}

// Ctrl+U: everything before the cursor (all of it when the cursor is at the end).
function killToStart(s) {
  return removeRange(s, 0, s.cursor)
}

function move(s, direction, word) {
  var to = word ? (direction < 0 ? wordStart(s.text, s.cursor) : wordEnd(s.text, s.cursor)) : s.cursor + direction
  return { text: s.text, cursor: clamp(s.text, to) }
}

function home(s) { return { text: s.text, cursor: 0 } }
function end(s) { return { text: s.text, cursor: s.text.length } }

// The cursor index nearest to x along the text, given its glyph advance per
// prefix (advance(text.slice(0, i))).
function indexAt(text, x, advance) {
  var best = 0
  var bestDistance = Infinity
  for (var i = 0; i <= text.length; i++) {
    var distance = Math.abs(advance(text.slice(0, i)) - x)
    if (distance < bestDistance) { best = i; bestDistance = distance }
  }
  return best
}

if (typeof module !== "undefined") module.exports = {
  state: state, insert: insert, backspace: backspace, deleteForward: deleteForward, killToStart: killToStart,
  move: move, home: home, end: end, wordStart: wordStart, wordEnd: wordEnd, indexAt: indexAt
}
