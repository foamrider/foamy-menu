// Scopes: a keyword that becomes a tag in the search field and swaps the list
// for the scope's own items (SSH hosts, …). Tab on the keyword, or on the
// scope's row, enters it. Items are searched only inside their scope.
//
// A query scope (web search) has no list: what is typed is the item. Its own
// past searches ("history": true) and the engine's suggestions
// ("suggest": true) can fill the list; both are off unless turned on.
//
// A scope is one JSON object. The built-in SSH, Steam Games and web-search
// scopes ship here; user scopes
// live in ~/.config/foamy-menu/scopes/<id>.json. A user file whose id matches
// a built-in overrides its fields, so {"id": "ssh", "enabled": false} turns the
// built-in off. Commands are argv arrays, never shell strings: {value} is the
// chosen item's value and {plugin} this plugin's directory, each substituted
// inside one argument; {query} is the value URL-encoded.

var ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
var KEYWORD_PATTERN = /^[^\s]{1,32}$/
var MAX_ITEMS = 5000
var MAX_TEXT = 512
var DEFAULT_TIMEOUT_MS = 10000
// A scope without icon or iconName gets a search glyph (Nerd Font md-magnify).
var DEFAULT_ICON = "\u{f0349}"
var MAX_TIMEOUT_MS = 60000
var MAX_SUGGESTIONS = 8
// Saved searches kept per query scope; the least recently used go first.
var MAX_HISTORY = 100

// A host name ssh accepts as one argument; never an option.
var SSH_HOST_PATTERN = "^[A-Za-z0-9_.:@%+][A-Za-z0-9_.:@%+-]*$"
// A Steam app id.
var STEAM_APPID_PATTERN = "^[0-9]{1,10}$"

// How a scope lays its items out: a list, or a grid like Apps with each
// item's icon ("icons") or portrait cover art ("covers").
var LAYOUTS = ["list", "icons", "covers"]

// The bundled helper bin/<arch>/<name>, run as kit/FoamyNative.js command()
// runs it (bash picks the arch and execs the helper, so one process; no
// helper for this CPU exits 126/127). Kept in step with the kit by
// tests/ssh-hosts.test.js.
var NATIVE_SCRIPT = 'exec -- "$1/bin/$HOSTTYPE/$2" "${@:3}"'

function nativeCommand(name, args) {
  return ["bash", "-c", NATIVE_SCRIPT, "foamy-native", "{plugin}", name].concat(args || [])
}

// Whether a (filled) command, an array or a QML list, runs a bundled helper.
function isNativeCommand(argv) {
  return !!argv && argv.length > 5 && argv[0] === "bash" && argv[1] === "-c" && argv[2] === NATIVE_SCRIPT
}

var BUILTINS = [
  {
    id: "ssh",
    enabled: true,
    title: "SSH",
    subtitle: "Connect to a host in ~/.ssh/config",
    keyword: "ssh",
    icon: "\u{f048d}",
    itemsTitle: "Hosts",
    placeholder: "Search hosts…",
    emptyText: "No hosts in ~/.ssh/config",
    // Every concrete Host in ~/.ssh/config and its Includes (search/src/ssh_hosts.rs).
    source: { type: "command", command: nativeCommand("foamy-menu-search", ["ssh-hosts"]) },
    open: ["omarchy-launch-tui", "--app-id=TUI.tile", "{plugin}/bin/foamy-ssh-connect", "{value}"],
    openTitle: "Connect",
    valuePattern: SSH_HOST_PATTERN,
    actions: [
      { title: "Copy SSH Command", copy: "ssh {value}" },
      { title: "Copy Host Name", copy: "{value}" },
      { title: "Open in Files (SFTP)", open: ["xdg-open", "sftp://{value}/"] }
    ],
    builtin: true
  },
  webSearch("google", "Google", "g", "\u{f1a0}", "https://www.google.com", "https://www.google.com/search?q={query}",
    "https://suggestqueries.google.com/complete/search?client=firefox&q={query}"),
  webSearch("duckduckgo", "DuckDuckGo", "ddg", "\u{f002}", "https://duckduckgo.com", "https://duckduckgo.com/?q={query}",
    "https://duckduckgo.com/ac/?q={query}&type=list"),
  {
    id: "steam",
    // Shown once the helper finds installed games (requireItems); the
    // steamGames setting adds them to the root search (Settings.applyToScopes).
    enabled: true,
    requireItems: true,
    // Shown like Apps: "Games" in the root search, a grid with no scope tag.
    title: "Games",
    subtitle: "Steam",
    keyword: "steam",
    icon: "\u{f04d3}",
    // Grid cells without art show Steam's own icon.
    iconName: "steam",
    itemsTitle: "Games",
    placeholder: "Search games…",
    emptyText: "No installed Steam games",
    // Installed games with their icons and covers (search/src/steam_games.rs).
    source: { type: "command", command: nativeCommand("foamy-menu-search", ["steam-games"]) },
    // Through the steam:// handler, so the Flatpak works too.
    open: ["uwsm-app", "--", "xdg-open", "steam://rungameid/{value}"],
    openTitle: "Play",
    valuePattern: STEAM_APPID_PATTERN,
    layout: "covers",
    rootSearch: false,
    itemLabel: "Game",
    actions: [
      { title: "Show in Library", open: ["uwsm-app", "--", "xdg-open", "steam://nav/games/details/{value}"] },
      { title: "Open Store Page", open: ["uwsm-app", "--", "xdg-open", "steam://store/{value}"] },
      { title: "Copy App ID", copy: "{value}" }
    ],
    builtin: true
  }
]

function webSearch(id, title, keyword, icon, home, url, suggestUrl) {
  return {
    id: id,
    enabled: true,
    title: title,
    subtitle: "Web search",
    keyword: keyword,
    icon: icon,
    source: { type: "query" },
    open: ["omarchy-launch-browser", url],
    openTitle: "Search",
    home: ["omarchy-launch-browser", home],
    history: false,
    suggest: false,
    suggestUrl: suggestUrl,
    actions: [{ title: "Copy Search URL", copy: url }],
    builtin: true
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function text(value, field, errors, required) {
  if (value === undefined || value === null) {
    if (required) errors.push(field + " is required")
    return ""
  }
  if (typeof value !== "string") { errors.push(field + " must be a string"); return "" }
  if (value.length > MAX_TEXT) { errors.push(field + " is longer than " + MAX_TEXT + " characters"); return "" }
  return value
}

function argv(value, field, errors, required) {
  if (value === undefined || value === null) {
    if (required) errors.push(field + " is required")
    return null
  }
  if (!Array.isArray(value) || value.length === 0) { errors.push(field + " must be a non-empty array of strings"); return null }
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string" || value[i].length === 0 || value[i].length > MAX_TEXT) {
      errors.push(field + "[" + i + "] must be a non-empty string")
      return null
    }
  }
  if (value[0].indexOf("{value}") >= 0) { errors.push(field + "[0] cannot be {value}"); return null }
  return value.slice()
}

function source(value, errors) {
  if (!isPlainObject(value)) { errors.push("source must be an object"); return null }
  if (value.type === "command") {
    var command = argv(value.command, "source.command", errors, true)
    var timeout = value.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(value.timeout)
    if (!(timeout >= 100 && timeout <= MAX_TIMEOUT_MS)) { errors.push("source.timeout must be 100–" + MAX_TIMEOUT_MS + " ms"); return null }
    return command ? { type: "command", command: command, timeout: Math.round(timeout) } : null
  }
  if (value.type === "list") {
    if (!Array.isArray(value.items)) { errors.push("source.items must be an array"); return null }
    var items = []
    for (var i = 0; i < value.items.length && items.length < MAX_ITEMS; i++) {
      var raw = value.items[i]
      if (typeof raw === "string") raw = { title: raw }
      if (!isPlainObject(raw)) { errors.push("source.items[" + i + "] must be a string or an object"); return null }
      var itemErrors = []
      var title = text(raw.title, "source.items[" + i + "].title", itemErrors, true)
      var item = {
        title: title,
        value: text(raw.value, "source.items[" + i + "].value", itemErrors, false) || title,
        subtitle: text(raw.subtitle, "source.items[" + i + "].subtitle", itemErrors, false)
      }
      var icon = imagePath(text(raw.icon, "source.items[" + i + "].icon", itemErrors, false), true)
      var cover = imagePath(text(raw.cover, "source.items[" + i + "].cover", itemErrors, false), false)
      if (icon) item.icon = icon
      if (cover) item.cover = cover
      if (itemErrors.length) { errors.push(itemErrors[0]); return null }
      if (title) items.push(item)
    }
    return { type: "list", items: items }
  }
  if (value.type === "query") return { type: "query" }
  errors.push("source.type must be \"command\", \"list\" or \"query\"")
  return null
}

// An item's picture: an absolute file path, or nothing. An icon may also be
// an icon theme name (letters, digits, ".", "_", "-").
function imagePath(value, allowName) {
  var v = String(value || "").trim()
  if (/^\/[^\0-\x1f\x7f]*$/.test(v) && !/(^|\/)\.\.(\/|$)/.test(v)) return v
  if (allowName && /^[A-Za-z0-9._-]+$/.test(v)) return v
  return ""
}

function actions(value, errors) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) { errors.push("actions must be an array"); return [] }
  var out = []
  for (var i = 0; i < value.length; i++) {
    var raw = value[i]
    var field = "actions[" + i + "]"
    if (!isPlainObject(raw)) { errors.push(field + " must be an object"); continue }
    var title = text(raw.title, field + ".title", errors, true)
    if (!title) continue
    if (typeof raw.copy === "string" && raw.open === undefined) out.push({ title: title, copy: raw.copy })
    else if (raw.copy === undefined) {
      var open = argv(raw.open, field + ".open", errors, true)
      if (open) out.push({ title: title, open: open })
    } else errors.push(field + " needs exactly one of copy or open")
  }
  return out
}

// A complete scope from a merged definition, or { errors }.
function normalize(raw) {
  var errors = []
  if (!isPlainObject(raw)) return { errors: ["a scope must be a JSON object"] }
  var id = typeof raw.id === "string" ? raw.id : ""
  if (!ID_PATTERN.test(id)) return { errors: ["id must be lowercase letters, digits and dashes"] }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push("enabled must be true or false")
  var keyword = raw.keyword === undefined ? id : raw.keyword
  var isQuery = isPlainObject(raw.source) && raw.source.type === "query"
  for (var f = 0; f < 4; f++) {
    var flag = ["history", "suggest", "rootSearch", "requireItems"][f]
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") errors.push(flag + " must be true or false")
  }
  var layout = raw.layout === undefined ? "list" : raw.layout
  if (LAYOUTS.indexOf(layout) < 0) { errors.push("layout must be \"list\", \"icons\" or \"covers\""); layout = "list" }
  if (isQuery && layout !== "list") { errors.push("a query scope has no grid layout"); layout = "list" }
  if (isQuery && (raw.rootSearch === true || raw.requireItems === true)) errors.push("a query scope has no items for rootSearch or requireItems")
  if (typeof keyword !== "string" || !KEYWORD_PATTERN.test(keyword)) errors.push("keyword must be 1–32 characters without spaces")
  var scope = {
    id: id,
    enabled: raw.enabled !== false,
    title: text(raw.title, "title", errors, true),
    subtitle: text(raw.subtitle, "subtitle", errors, false),
    keyword: String(keyword).toLowerCase(),
    icon: text(raw.icon, "icon", errors, false) || (raw.iconName ? "" : DEFAULT_ICON),
    iconName: text(raw.iconName, "iconName", errors, false),
    itemsTitle: text(raw.itemsTitle, "itemsTitle", errors, false) || "Items",
    placeholder: text(raw.placeholder, "placeholder", errors, false),
    emptyText: text(raw.emptyText, "emptyText", errors, false),
    source: source(raw.source, errors),
    open: argv(raw.open, "open", errors, true),
    openTitle: text(raw.openTitle, "openTitle", errors, false) || (isQuery ? "Search" : "Open"),
    home: argv(raw.home, "home", errors, false),
    history: isQuery && raw.history === true,
    suggest: isQuery && raw.suggest === true,
    suggestUrl: text(raw.suggestUrl, "suggestUrl", errors, false),
    valuePattern: text(raw.valuePattern, "valuePattern", errors, false),
    layout: layout,
    rootSearch: !isQuery && raw.rootSearch === true,
    requireItems: !isQuery && raw.requireItems === true,
    itemLabel: text(raw.itemLabel, "itemLabel", errors, false),
    actions: actions(raw.actions, errors),
    builtin: raw.builtin === true
  }
  if (scope.suggest && !/^https:\/\/[^\s]*\{query\}/.test(scope.suggestUrl)) errors.push("suggest needs a suggestUrl: an https URL with {query}")
  if (scope.valuePattern) {
    try { new RegExp(scope.valuePattern) } catch (e) { errors.push("valuePattern is not a valid regular expression") }
  }
  return errors.length ? { errors: errors, id: id } : { scope: scope }
}

// A user scope file's text, parsed. fileName (without directories) names the
// scope when the file leaves out "id".
function parseFile(fileName, raw) {
  var parsed
  try { parsed = JSON.parse(raw) } catch (e) { return { errors: ["not valid JSON: " + e.message] } }
  if (!isPlainObject(parsed)) return { errors: ["a scope file must hold one JSON object"] }
  if (parsed.id === undefined) parsed.id = String(fileName || "").replace(/\.json$/, "")
  return { definition: parsed }
}

// Built-ins with the user definitions laid over them by id; later files win.
// Returns { scopes, errors: [{ id, file, errors }] }. Disabled scopes are left
// out, and two enabled scopes cannot share a keyword (the first one keeps it).
function merge(builtins, files) {
  var order = []
  var byId = {}
  var origin = {}
  for (var b = 0; b < builtins.length; b++) {
    order.push(builtins[b].id)
    byId[builtins[b].id] = builtins[b]
    origin[builtins[b].id] = "built-in"
  }
  var problems = []
  for (var f = 0; f < files.length; f++) {
    var file = files[f]
    var def = file.definition
    if (!def) { problems.push({ id: "", file: file.name, errors: file.errors || ["unreadable"] }); continue }
    var base = byId[def.id]
    var next = {}
    if (base) for (var k in base) next[k] = base[k]
    for (var key in def) if (key !== "builtin") next[key] = def[key]
    if (!base) order.push(def.id)
    byId[def.id] = next
    origin[def.id] = file.name
  }
  var scopes = []
  var keywords = {}
  // Every valid query scope, disabled ones too: their saved searches stay
  // stored, so clearing them must find them.
  var queryIds = []
  for (var i = 0; i < order.length; i++) {
    var result = normalize(byId[order[i]])
    if (!result.scope) { problems.push({ id: order[i], file: origin[order[i]], errors: result.errors }); continue }
    var scope = result.scope
    if (scope.source && scope.source.type === "query") queryIds.push(scope.id)
    if (!scope.enabled) continue
    if (keywords[scope.keyword]) {
      problems.push({ id: scope.id, file: origin[scope.id], errors: ["keyword \"" + scope.keyword + "\" is already used by " + keywords[scope.keyword]] })
      continue
    }
    keywords[scope.keyword] = scope.id
    scopes.push(scope)
  }
  return { scopes: scopes, errors: problems, queryIds: queryIds }
}

// Tab in the root search: the scope whose keyword the query names, and the
// text typed after it. "ssh" and "ssh prod" both name the ssh scope.
function matchKeyword(scopes, query) {
  var q = String(query || "").replace(/^\s+/, "")
  var lower = q.toLowerCase()
  for (var i = 0; i < scopes.length; i++) {
    var keyword = scopes[i].keyword
    if (lower === keyword) return { scope: scopes[i], rest: "" }
    if (lower.indexOf(keyword + " ") === 0) return { scope: scopes[i], rest: q.slice(keyword.length + 1).replace(/^\s+/, "") }
  }
  return null
}

// Command output: one item per line,
// "title<TAB>value<TAB>subtitle<TAB>icon<TAB>cover"; value defaults to the
// title, the rest may be left out. icon is an image file or an icon name,
// cover an image file (absolute paths; anything else is dropped). Blank and
// over-long lines are skipped; at most MAX_ITEMS items, duplicate values kept
// once.
function parseOutput(output) {
  var lines = String(output || "").split("\n")
  var items = []
  var seen = {}
  for (var i = 0; i < lines.length && items.length < MAX_ITEMS; i++) {
    var line = lines[i].replace(/\r$/, "")
    if (!line.trim() || line.length > MAX_TEXT * 5) continue
    var parts = line.split("\t")
    var title = parts[0].trim()
    if (!title || title.length > MAX_TEXT) continue
    var value = (parts[1] || "").trim() || title
    if (value.length > MAX_TEXT || seen[value]) continue
    seen[value] = true
    var icon = (parts[3] || "").length <= MAX_TEXT ? imagePath(parts[3], true) : ""
    var cover = (parts[4] || "").length <= MAX_TEXT ? imagePath(parts[4], false) : ""
    var item = { title: title, value: value, subtitle: (parts[2] || "").trim().slice(0, MAX_TEXT) }
    if (icon) item.icon = icon
    if (cover) item.cover = cover
    items.push(item)
  }
  return items
}

function itemId(scopeId, value) {
  return "scope-item:" + scopeId + ":" + value
}

// The row for entering a scope from the root search.
function scopeCandidate(scope, t) {
  var tr = typeof t === "function" ? t : function(s) { return s }
  var title = tr(scope.title)
  var keywords = [scope.keyword]
  if (title !== scope.title) keywords.push(scope.title)
  return {
    id: "scope:" + scope.id,
    type: "command",
    kind: "scope",
    title: title,
    subtitle: tr(scope.subtitle),
    keywords: keywords,
    // A grid opens like the Apps menu row does.
    typeLabel: isGrid(scope) ? "Menu" : "Scope",
    grid: isGrid(scope),
    scopeId: scope.id,
    scopeKeyword: scope.keyword,
    glyph: scope.icon,
    iconName: scope.icon ? "" : scope.iconName,
    rootSearch: { when: "always" }
  }
}

function itemCandidate(scope, item, t) {
  var tr = typeof t === "function" ? t : function(s) { return s }
  return {
    id: itemId(scope.id, item.value),
    type: "scope-item",
    kind: "scope-item",
    title: item.title,
    subtitle: item.subtitle,
    keywords: item.value !== item.title ? [item.value] : [],
    typeLabel: tr(scope.itemLabel || scope.title),
    scopeId: scope.id,
    value: item.value,
    openTitle: scope.openTitle,
    scopeActions: scope.actions,
    glyph: scope.icon,
    iconName: scope.icon ? "" : scope.iconName,
    // The grid's picture: the item's own, else the scope's icon name.
    image: item.icon || "",
    cover: item.cover || "",
    fallbackIcon: scope.iconName || "",
    rootSearch: { when: "never" }
  }
}

// The URL an item's image file loads from: an .ico through Quickshell's icon
// provider (which picks its largest size; a plain file URL shows its first,
// often 32 px), anything else as a file URL. "" for an icon name, which the
// app library resolves.
function imageUrl(path) {
  var p = String(path || "")
  if (p.charAt(0) !== "/") return ""
  if (/\.ico$/i.test(p)) return "image://icon/" + p
  return "file://" + p.split("/").map(encodeURIComponent).join("/")
}

// An item of a rootSearch scope as a root search row: found while typing,
// ranked and filtered as an application (Steam games next to apps), with the
// scope's subtitle ("Steam") when the item has none. Its id is the item's id
// inside the scope, so both share ranking and actions.
function rootItemCandidate(scope, item, t) {
  var tr = typeof t === "function" ? t : function(s) { return s }
  var c = itemCandidate(scope, item, t)
  c.type = "application"
  c.subtitle = item.subtitle || tr(scope.subtitle)
  c.rootSearch = { when: "searching" }
  return c
}

// Whether a scope is offered (its row, its keyword): a requireItems scope only
// once its source has listed something (Games: Steam is installed with games).
function isShown(scope, items) {
  return !!scope && (!scope.requireItems || (!!items && items.length > 0))
}

// Scopes whose items load without being entered: for the root search, or to
// know whether a requireItems scope is shown.
function loadsEarly(scope) {
  return !!scope && (scope.rootSearch || scope.requireItems)
}

function isGrid(scope) {
  return !!scope && scope.layout !== undefined && scope.layout !== "list"
}

function valueAllowed(scope, value) {
  var v = String(value || "")
  if (!v || v.indexOf("\n") >= 0 || v.indexOf("\0") >= 0) return false
  return !scope.valuePattern || new RegExp(scope.valuePattern).test(v)
}

function substitute(text, value, pluginDir) {
  return String(text).replace(/\{(value|query|plugin)\}/g, function(_, name) {
    if (name === "value") return String(value)
    if (name === "query") return encodeURIComponent(String(value).trim())
    return String(pluginDir)
  })
}

// One argv with {value}, {query} and {plugin} substituted inside each argument.
function fill(args, value, pluginDir) {
  return args.map(function(arg) { return substitute(arg, value, pluginDir) })
}

function fillText(template, value) {
  return substitute(template, value, "")
}

function isQuery(scope) {
  return !!scope && !!scope.source && scope.source.type === "query"
}

// The typed text as a row. Inside the scope it leads the list; in the root
// search it is one of the "Use “…” with…" rows (inRoot).
function queryCandidate(scope, query, t, inRoot) {
  var tr = typeof t === "function" ? t : function(s, v) { return v ? s.replace("%1", v[0]).replace("%2", v[1]) : s }
  var q = String(query || "").trim()
  var name = tr(scope.title)
  return {
    id: "scope-query:" + scope.id,
    type: "scope-item",
    kind: "scope-query",
    title: inRoot ? tr("Search %1", [name]) : (q ? tr("Search %1 for “%2”", [name, q]) : tr("Open %1", [name])),
    subtitle: inRoot ? q : "",
    keywords: [],
    typeLabel: inRoot ? "Search" : scope.title,
    scopeId: scope.id,
    value: q,
    openTitle: scope.openTitle,
    scopeActions: scope.actions,
    glyph: scope.icon,
    iconName: scope.icon ? "" : scope.iconName,
    rootSearch: { when: "never" }
  }
}

// A query scope's saved searches, from the visits the launcher records.
function historyCandidates(scope, visits, t) {
  var prefix = itemId(scope.id, "")
  var out = []
  for (var key in visits || {}) {
    if (key.indexOf(prefix) !== 0 || key.length === prefix.length) continue
    var value = key.slice(prefix.length)
    var c = itemCandidate(scope, { title: value, value: value, subtitle: "" }, t)
    c.saved = true
    out.push(c)
  }
  return out
}

// Ids of a scope's saved searches beyond MAX_HISTORY, least recent first.
function historyOverflow(scopeId, visits, max) {
  var prefix = itemId(scopeId, "")
  var keys = Object.keys(visits || {}).filter(function(k) { return k.indexOf(prefix) === 0 })
  var limit = max === undefined ? MAX_HISTORY : max
  if (keys.length <= limit) return []
  keys.sort(function(a, b) { return (visits[a].openedAt || 0) - (visits[b].openedAt || 0) })
  return keys.slice(0, keys.length - limit)
}

// OpenSearch suggestions, ["query", ["one", "two"]], or DuckDuckGo's
// [{"phrase": "one"}]; at most MAX_SUGGESTIONS strings.
function parseSuggestions(raw) {
  var parsed
  try { parsed = JSON.parse(raw) } catch (e) { return [] }
  var list = Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1] : (Array.isArray(parsed) ? parsed : [])
  var out = []
  for (var i = 0; i < list.length && out.length < MAX_SUGGESTIONS; i++) {
    var value = typeof list[i] === "string" ? list[i] : (isPlainObject(list[i]) && typeof list[i].phrase === "string" ? list[i].phrase : "")
    value = value.replace(/[\r\n\t]+/g, " ").trim()
    if (value && value.length <= MAX_TEXT && out.indexOf(value) < 0) out.push(value)
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    BUILTINS: BUILTINS,
    MAX_ITEMS: MAX_ITEMS,
    LAYOUTS: LAYOUTS,
    SSH_HOST_PATTERN: SSH_HOST_PATTERN,
    STEAM_APPID_PATTERN: STEAM_APPID_PATTERN,
    isGrid: isGrid,
    isShown: isShown,
    loadsEarly: loadsEarly,
    imageUrl: imageUrl,
    isNativeCommand: isNativeCommand,
    normalize: normalize,
    parseFile: parseFile,
    merge: merge,
    matchKeyword: matchKeyword,
    parseOutput: parseOutput,
    itemId: itemId,
    scopeCandidate: scopeCandidate,
    itemCandidate: itemCandidate,
    rootItemCandidate: rootItemCandidate,
    valueAllowed: valueAllowed,
    fill: fill,
    fillText: fillText,
    isQuery: isQuery,
    queryCandidate: queryCandidate,
    historyCandidates: historyCandidates,
    historyOverflow: historyOverflow,
    parseSuggestions: parseSuggestions,
    MAX_HISTORY: MAX_HISTORY
  }
}
