// Bounded HTTPS GETs: the exchange rates and the web-search suggestions.
//
// Qt's XMLHttpRequest has no size limit, and aborting from a LOADING callback
// is not one either: Qt's network thread keeps reading while the GUI thread is
// busy, and a test saw 128 MB arrive in the next callback. So the requests run
// in curl, which stops once the bytes received would pass MAX_BYTES (on the
// body itself, Content-Length or not, since curl 8.4) and exits 63. The shell
// reads at most MAX_BYTES of its stdout, and services/BoundedFetch.qml drops
// the reply of any request that did not exit 0.
//
// Nothing about the request is on curl's command line, which other local users
// can read from /proc (a suggestion URL holds what was typed): the URL and the
// headers go in on stdin as a curl config. --disable comes first so ~/.curlrc
// cannot change these limits.

var MAX_BYTES = 256 * 1024
var TIMED_OUT = "timed out"

// Constant flags, then the two limits; no caller text.
function argv(maxBytes, seconds) {
  return ["curl", "--disable", "--config", "-", "--silent", "--show-error", "--fail",
    "--location", "--max-redirs", "3", "--proto", "=https",
    "--max-filesize", String(Math.floor(maxBytes)), "--max-time", String(Math.floor(seconds)), "--output", "-"]
}

// curl config for one GET, or "" for a URL this refuses to fetch. Refusing
// quotes, backslashes, spaces and control characters leaves nothing to escape;
// a filled URL template never has them (the query is URL-encoded).
function config(url, languages) {
  var text = String(url || "")
  if (!/^https:\/\/[^/]/.test(text) || /[\x00-\x20\x7f"\\]/.test(text)) return ""
  var out = 'url = "' + text + '"\n'
  // As XMLHttpRequest sent them, so suggestions keep the same language.
  out += 'user-agent = "Mozilla/5.0"\n'
  var language = languageHeader(languages)
  if (language) out += 'header = "Accept-Language: ' + language + '"\n'
  return out
}

// ["nb-NO", "en"] -> "nb-NO,en,*"
function languageHeader(languages) {
  var tags = []
  var list = languages && typeof languages.length === "number" ? languages : []
  for (var i = 0; i < list.length && tags.length < 8; i++) {
    var tag = String(list[i])
    if (/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(tag) && tags.indexOf(tag) < 0) tags.push(tag)
  }
  return tags.length ? tags.join(",") + ",*" : ""
}

// "" when curl succeeded with a reply of at most maxBytes, else why not.
function failure(exitCode, stderr, text, maxBytes) {
  if (exitCode === 28) return TIMED_OUT
  if (exitCode === 63 || (exitCode === 0 && String(text || "").length > maxBytes)) return "reply is over " + maxBytes + " bytes"
  if (exitCode === 0) return ""
  var line = String(stderr || "").split("\n").filter(function(l) { return l.trim() })[0] || ""
  return (line.replace(/^curl: \(\d+\) /, "") || "curl exited with code " + exitCode).slice(0, 200)
}

if (typeof module !== "undefined") {
  module.exports = { MAX_BYTES: MAX_BYTES, TIMED_OUT: TIMED_OUT, argv: argv, config: config, languageHeader: languageHeader, failure: failure }
}
