var MAX_QUERY_LENGTH = 256
var MAX_REPLY_LENGTH = 8 * 1024 * 1024
// The helper refuses a request line over MAX_REQUEST_BYTES, the newline not
// counted (search/src/protocol.rs MAX_LINE_BYTES), and a list of more than
// MAX_ENTRIES entries (search/src/engine.rs MAX_ENTRIES). A refusal turns the
// helper off in every view, so NativeSearch sends no list past either.
var MAX_REQUEST_BYTES = 8 * 1024 * 1024
var MAX_ENTRIES = 20000

// A list's load request without its newline; line is the entries as JSON.
function loadRequest(id, catalog, line) {
  return "{\"id\":" + id + ",\"catalog\":" + JSON.stringify(catalog) + ",\"entries\":" + line + "}"
}

// The UTF-8 bytes of a list's load request with the longest id a request
// can have, so the size holds whatever id it gets.
function loadSize(catalog, line) {
  return utf8Length(loadRequest(Number.MAX_SAFE_INTEGER, catalog, "")) + utf8Length(line)
}

// Whether the helper takes a list of count entries whose JSON is line.
function loadFits(catalog, count, line) {
  return count <= MAX_ENTRIES && loadSize(catalog, line) <= MAX_REQUEST_BYTES
}

// The bytes of text in UTF-8 as Qt writes it: a surrogate pair is 4, a lone
// surrogate becomes U+FFFD, 3.
function utf8Length(text) {
  var bytes = text.length
  var wide = /[^\x00-\x7f]/g
  for (var match = wide.exec(text); match; match = wide.exec(text)) {
    var code = text.charCodeAt(match.index), next = text.charCodeAt(match.index + 1)
    if (code < 0x800) bytes += 1
    else if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      bytes += 2
      wide.lastIndex = match.index + 2
    } else bytes += 2
  }
  return bytes
}

function entries(candidates, fold) {
  function strings(values) {
    return Array.isArray(values) ? values.map(function(value) { return fold(String(value || "")) }) : []
  }
  return candidates.map(function(c) {
    return {
      title: fold(String(c.title || "")), subtitle: fold(String(c.subtitle || "")),
      alternateTitles: strings(c.alternateTitles), keywords: strings(c.keywords), bundleId: fold(String(c.bundleId || ""))
    }
  })
}

// Replies look like {id: 7, hits: [{index: 0, title: 4000000, alternate: null, subtitle: null, keyword: null}]}.
function reply(line) {
  if (line.length > MAX_REPLY_LENGTH) throw new Error("Search reply exceeds the size limit")
  var data = JSON.parse(line)
  if (!data || !Number.isSafeInteger(data.id)) throw new Error("Search reply has no request id")
  return data
}

var CHANNELS = ["title", "alternate", "subtitle", "keyword"]

// The higher of two channel scores, either of which may be null.
function best(a, b) {
  return a === null ? b : (b === null ? a : Math.max(a, b))
}

// Hits by candidate id. A list can hold one id twice (a list scope with a
// repeated value): those hits merge, keeping each channel's best score.
function hits(data, ids) {
  if (!Array.isArray(data.hits)) throw new Error("Search reply has no hits")
  var out = Object.create(null)
  var seen = Object.create(null)
  for (var i = 0; i < data.hits.length; i++) {
    var hit = data.hits[i]
    if (!hit || !Number.isInteger(hit.index) || hit.index < 0 || hit.index >= ids.length)
      throw new Error("Search reply has an invalid entry index")
    if (seen[hit.index]) throw new Error("Search reply repeats an entry")
    seen[hit.index] = true
    for (var j = 0; j < CHANNELS.length; j++) {
      var score = hit[CHANNELS[j]]
      if (score !== null && (!Number.isInteger(score) || score <= 0 || score > 5000000))
        throw new Error("Search reply has an invalid score")
    }
    if (CHANNELS.every(function(channel) { return hit[channel] === null })) throw new Error("Search reply contains an empty hit")
    var id = ids[hit.index]
    var before = Object.prototype.hasOwnProperty.call(out, id) ? out[id] : null
    out[id] = before ? {
      index: before.index, title: best(before.title, hit.title), alternate: best(before.alternate, hit.alternate),
      subtitle: best(before.subtitle, hit.subtitle), keyword: best(before.keyword, hit.keyword)
    } : hit
  }
  return out
}

if (typeof module !== "undefined") module.exports = { MAX_QUERY_LENGTH, MAX_REQUEST_BYTES, MAX_ENTRIES, loadRequest, loadSize, loadFits, utf8Length, entries, reply, hits }
