
var SUGGESTIONS_LIMIT = 6

var BUILTINS = [
  {
    id: "builtin:settings",
    title: "Foamy Menu Settings",
    subtitle: "Foamy Menu",
    glyph: "\uf013",                     // nf-fa-cog
    keywords: ["settings", "preferences", "config", "configure", "foamy"],
    run: { push: { kind: "settings", title: "Foamy Menu Settings" } },
    rootSearch: { when: "always" }
  },
  {
    id: "builtin:omarchy-menu",
    title: "Stock Omarchy Menu",
    subtitle: "Open the original Omarchy menu",
    keywords: ["menu", "omarchy"],
    run: { summon: "omarchy.menu", payload: "{\"menu\":\"root\"}" },
    rootSearch: { when: "always" }
  },
  {
    id: "builtin:calculator-history",
    title: "Calculator History",
    subtitle: "Calculator",
    glyph: "\uf1da",                     // nf-fa-history
    keywords: ["calculator", "calc", "math", "history", "conversions"],
    run: { push: { kind: "calculator-history", title: "Calculator History" } },
    rootSearch: { when: "always" }
  }
]

function words(value) {
  return String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._:/\\-]+/g, " ").trim()
}

function appCandidate(entry) {
  var desktopId = String(entry.id || "")
  var keywords = []
  if (entry.genericName) keywords.push(String(entry.genericName))
  try {
    if (entry.keywords && entry.keywords.length) for (var i = 0; i < entry.keywords.length; i++) if (entry.keywords[i]) keywords.push(String(entry.keywords[i]))
  } catch (e) {}
  return {
    id: "app:" + desktopId,
    type: "application",
    kind: "app",
    title: String(entry.name || desktopId),
    subtitle: "",
    keywords: keywords,
    bundleId: desktopId,
    typeLabel: "Application",
    appId: desktopId,
    windowKeys: appWindowKeys(entry),
    iconName: String(entry.icon || ""),
    rootSearch: { when: "always" }
  }
}

// host+path of a web app URL, the shape both sides of the match reduce to.
// The trailing slash is dropped rather than forced: web apps disagree on it.
function webappKey(url) {
  return "webapp:" + String(url).replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "").toLowerCase()
}

// Keys a Hyprland window class can match for one desktop entry. No single
// one covers everything: StartupWMClass is the declared answer but often
// wrong or absent, the desktop id covers files named after their class, and
// web apps declare no class at all, so their URL is rebuilt from Exec.
function appWindowKeys(entry) {
  var keys = []
  function add(key) { if (key && keys.indexOf(key) < 0) keys.push(key) }
  add(String(entry.id || "").toLowerCase())
  add(String(entry.startupClass || "").toLowerCase())
  var exec = String(entry.execString || "")
  if (!exec && entry.command && entry.command.length) exec = Array.prototype.join.call(entry.command, " ")
  if (/--app=|webapp/.test(exec)) {
    var url = exec.match(/https?:\/\/[^\s"']+/)
    if (url) add(webappKey(url[0]))
  }
  return keys
}

// Keys for one window class. Chromium-based browsers build a web app's class
// off its URL and the profile directory: chrome-web.whatsapp.com__-Default ->
// web.whatsapp.com. The profile is whatever the user launched with ("Default",
// "Profile 1" -> Profile_1), so the last dash segment is dropped, not matched.
function windowClassKeys(windowClass) {
  var cls = String(windowClass || "").toLowerCase()
  var keys = [cls]
  var url = cls.replace(/^(brave|chrome|chromium)-/, "")
  if (url !== cls) keys.push(webappKey(url.replace(/-[^-]*$/, "").replace(/__/g, "/").replace(/_/g, "/")))
  return keys
}

// Address of the most recently focused window of an app, or "" when none is
// open. focusHistoryID 0 is the focused window, higher is older.
function findAppWindow(clients, keys) {
  if (!keys || !keys.length) return ""
  var best = null
  for (var i = 0; i < (clients || []).length; i++) {
    var c = clients[i]
    if (!c || !c.class || c.mapped === false) continue
    var matches = windowClassKeys(c.class).some(function(k) { return keys.indexOf(k) >= 0 })
    if (matches && (!best || c.focusHistoryID < best.focusHistoryID)) best = c
  }
  return best ? String(best.address) : ""
}

function menuCandidate(tree, item, guards, deps) {
  var crumbs = deps.OmarchyMenu.breadcrumb(tree, item.id)
  var keywords = item.aliases.map(words).filter(function(k) { return k })
  if (item.title && item.title !== item.label) keywords.push(item.title)
  if (item.description) keywords.push(item.description)
  return {
    id: "omarchy:" + item.id,
    type: "command",
    kind: item.kind === "action" ? "omarchy-action" : (item.kind === "link" ? "omarchy-link" : "omarchy-menu"),
    title: item.label,
    subtitle: crumbs.length > 0 ? crumbs.join(" › ") : "Omarchy",
    keywords: keywords,
    typeLabel: item.kind === "action" && item.provider !== "apps" ? "Command" : "Menu",
    menuId: item.id,
    action: item.action,
    target: item.target,
    provider: item.provider,
    glyph: item.icon,
    glyphFont: item.iconFont,
    checked: !!(item.isCurrent || (guards && guards.checked && guards.checked[item.id])),
    disabled: !!(guards && guards.disabled && guards.disabled[item.id]),
    rootSearch: { when: crumbs.length === 0 ? "always" : "searching" }
  }
}

// t translates the built-in's English title and subtitle; the English title
// stays searchable.
function builtinCandidate(def, t) {
  var tr = typeof t === "function" ? t : function(s) { return s }
  var title = tr(def.title)
  var keywords = (def.keywords || []).slice()
  if (title !== def.title) keywords.push(def.title)
  return {
    id: def.id,
    type: "command",
    kind: "builtin",
    title: title,
    subtitle: def.subtitle ? tr(def.subtitle) : "",
    keywords: keywords,
    typeLabel: "Command",
    glyph: def.glyph || "\ue900",
    glyphFont: def.glyph ? "" : "omarchy",
    run: def.run,
    rootSearch: def.rootSearch || { when: "always" }
  }
}

function menuCandidates(tree, guards, providerItems, deps) {
  var out = []
  for (var i = 0; i < tree.order.length; i++) {
    var item = tree.items[tree.order[i]]
    if (!deps.OmarchyMenu.isVisible(tree, guards, item.id)) continue
    out.push(menuCandidate(tree, item, guards, deps))
  }
  var extra = providerItems || {}
  for (var menuId in extra) {
    if (!tree.items[menuId] || !deps.OmarchyMenu.isVisible(tree, guards, menuId)) continue
    for (var j = 0; j < extra[menuId].length; j++) {
      var row = extra[menuId][j]
      var withTree = { items: tree.items, order: tree.order, children: tree.children }
      withTree.items = Object.create(tree.items)
      withTree.items[row.id] = row
      out.push(menuCandidate(withTree, row, guards, deps))
    }
  }
  return out
}

function decorate(candidate, ctx, deps) {
  var out = {}
  for (var k in candidate) out[k] = candidate[k]
  var settings = (ctx.commands && ctx.commands[candidate.id]) || {}
  var visits = (ctx.frecency && ctx.frecency[candidate.id]) || null
  out.alias = settings.alias ? String(settings.alias).toLowerCase() : ""
  out.favoriteOrder = typeof settings.favoriteOrder === "number" ? settings.favoriteOrder : null
  out.frecency = visits ? deps.Frecency.score(visits.anchor, ctx.nowMs / 1000) : 1
  out.openedAt = visits ? visits.openedAt : null
  out.searchTerms = visits && visits.searchTerms ? visits.searchTerms : []
  return out
}

function isEnabled(candidate, ctx) {
  var settings = ctx.commands && ctx.commands[candidate.id]
  return !(settings && settings.enabled === false)
}

function rankOptions(ctx) {
  return { sensitivity: ctx.sensitivity || "medium", nowMs: ctx.nowMs, fleaHits: ctx.fleaHits || null }
}

// "Use “…” with…": every query scope (web search), for the typed text.
function searchRows(query, ctx, deps) {
  return (ctx.searchScopes || []).map(function(scope) {
    return { candidate: deps.Scopes.queryCandidate(scope, query, ctx.t, true), record: null }
  })
}

// The inline Calculator row (SPEC §7.2 "Calculator" section) for a
// Calculator.evaluate() result. Not a stored candidate: its actions re-run
// the query.
var CALCULATOR_ID = "calculator:result"

function calculatorCandidate(calc) {
  return {
    id: CALCULATOR_ID, type: "command", kind: "calculator",
    title: calc.result, subtitle: calc.input, typeLabel: "Calculator",
    calcKind: calc.kind, calcInput: calc.input, calcResult: calc.result, calcPlain: calc.plain,
    calcContext: calc.context || "", calcContextValues: calc.contextValues || [],
    rootSearch: { when: "searching" }
  }
}

// One saved calculation in Calculator History.
function historyCandidate(entry, nowMs) {
  return {
    id: "calculator-history:" + entry.id, type: "command", kind: "calculator-history",
    title: entry.result, subtitle: entry.query, typeLabel: relativeParts(entry.createdAt, nowMs)[0], typeLabelValues: relativeParts(entry.createdAt, nowMs)[1],
    glyph: "\uf1ec", historyId: entry.id, rootSearch: { when: "always" }   // nf-fa-calculator
  }
}

// [English template, values]: the UI translates the template and fills %1.
function relativeParts(ms, nowMs) {
  var s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return ["Just now", []]
  if (s < 3600) return ["%1 min ago", [Math.floor(s / 60)]]
  if (s < 86400) return ["%1 h ago", [Math.floor(s / 3600)]]
  var d = Math.floor(s / 86400)
  return d === 1 ? ["Yesterday", []] : ["%1 days ago", [d]]
}

function relativeTime(ms, nowMs) {
  var parts = relativeParts(ms, nowMs)
  return parts[0].replace("%1", parts[1][0])
}

// Calculator History (ref 04 App. A calculator.history): newest first,
// filtered by the query, split into Today and Earlier. [I]
function historySections(history, query, nowMs, filter) {
  var list = filter(history, query)
  if (list.length === 0) return []
  var midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0)
  var todays = [], older = []
  for (var i = 0; i < list.length; i++) (list[i].createdAt >= midnight.getTime() ? todays : older).push({ candidate: historyCandidate(list[i], nowMs), record: null })
  var out = []
  if (todays.length) out.push({ id: "history-today", title: "Today", rows: todays })
  if (older.length) out.push({ id: "history-older", title: "Earlier", rows: older })
  return out
}

// The root dropdown (Ctrl+P, ref 04 §2.2 toggleFilter). Raycast's root has
// no dropdown; this one narrows root search by type. [D]
var FILTERS = [
  { id: "all", title: "All" },
  { id: "applications", title: "Applications" },
  { id: "commands", title: "Commands" }
]

function passesFilter(candidate, filter) {
  if (!filter || filter === "all") return true
  return (candidate.type === "application") === (filter === "applications")
}

function rootSections(candidates, query, ctx, deps) {
  var q = String(query || "").trim()
  var filtered = ctx.filter && ctx.filter !== "all"
  var decorated = []
  for (var i = 0; i < candidates.length; i++) {
    if (!isEnabled(candidates[i], ctx) || !passesFilter(candidates[i], ctx.filter)) continue
    decorated.push(decorate(candidates[i], ctx, deps))
  }
  var opts = rankOptions(ctx)

  if (q) {
    var searchable = decorated.filter(function(c) { return c.rootSearch.when !== "empty" })
    var results = deps.Ranker.rank(searchable, q, opts)
    var sections = []
    if (ctx.calculation && !filtered) sections.push({ id: "calculator", title: "Calculator", rows: [{ candidate: calculatorCandidate(ctx.calculation), record: null }] })
    if (results.length > 0) sections.push({ id: "results", title: "Results", rows: results })
    var searches = filtered ? [] : searchRows(q, ctx, deps)
    if (searches.length) sections.push({ id: "fallback-commands", title: "Use “%1” with…", titleValues: [q], rows: searches })
    return sections
  }

  var shown = decorated.filter(function(c) { return c.rootSearch.when !== "searching" || c.favoriteOrder !== null })
  var taken = {}
  var favorites = shown.filter(function(c) { return c.favoriteOrder !== null })
    .sort(function(a, b) { return a.favoriteOrder - b.favoriteOrder })
  favorites.forEach(function(c) { taken[c.id] = true })

  var suggestions = deps.Ranker.rank(decorated.filter(function(c) { return !taken[c.id] && c.frecency > 1 }), "", opts)
    .slice(0, SUGGESTIONS_LIMIT)
  suggestions.forEach(function(r) { taken[r.candidate.id] = true })

  var rest = shown.filter(function(c) { return !taken[c.id] })
  var commands = deps.Ranker.rank(rest.filter(function(c) { return c.type !== "application" }), "", opts)
  var apps = deps.Ranker.rank(rest.filter(function(c) { return c.type === "application" }), "", opts)

  var out = []
  if (favorites.length) out.push({ id: "favorites", title: "Favorites", rows: favorites.map(function(c) { return { candidate: c, record: null } }) })
  if (suggestions.length) out.push({ id: "suggestions", title: "Suggestions", rows: suggestions })
  if (commands.length) out.push({ id: "commands", title: "Commands", rows: commands })
  if (apps.length) out.push({ id: "apps", title: "Applications", rows: apps })
  return out
}

function submenuSections(candidates, menuId, query, ctx, deps) {
  var prefix = "omarchy:" + menuId + "."
  var q = String(query || "").trim()
  var inside = []
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i]
    if (c.id.indexOf(prefix) !== 0 || !isEnabled(c, ctx)) continue
    var rest = c.id.slice(prefix.length)
    if (!q && rest.indexOf(".") >= 0) continue
    inside.push(decorate(c, ctx, deps))
  }
  if (!q) return inside.length ? [{ id: "menu", title: "", rows: inside.map(function(c) { c.subtitle = ""; return { candidate: c, record: null } }) }] : []
  var ranked = deps.Ranker.rank(inside, q, rankOptions(ctx))
  return ranked.length ? [{ id: "results", title: "Results", rows: ranked }] : []
}

// The Apps grid (the stock menu's `apps` provider item, shown inline):
// every enabled application, A–Z until a query narrows and ranks them.
function appGridSections(candidates, query, ctx, deps) {
  var q = String(query || "").trim()
  var apps = []
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i]
    if (c.type === "application" && isEnabled(c, ctx)) apps.push(decorate(c, ctx, deps))
  }
  var rows
  if (q) rows = deps.Ranker.rank(apps, q, rankOptions(ctx))
  else rows = apps.sort(function(a, b) {
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id)
  }).map(function(c) { return { candidate: c, record: null } })
  return rows.length ? [{ id: "apps", title: "", rows: rows }] : []
}

function isAppGridItem(candidate) {
  return !!candidate && candidate.kind === "omarchy-action" && candidate.provider === "apps"
}

// Inside a scope: recently used items first, then all of them in the
// source's order; a query ranks them instead. Items never reach root search.
function scopeSections(itemCandidates, query, ctx, deps, itemsTitle) {
  var q = String(query || "").trim()
  var decorated = itemCandidates.map(function(c) { return decorate(c, ctx, deps) })
  if (q) {
    var ranked = deps.Ranker.rank(decorated, q, rankOptions(ctx))
    return ranked.length ? [{ id: "results", title: "Results", rows: ranked }] : []
  }
  var recent = deps.Ranker.rank(decorated.filter(function(c) { return c.frecency > 1 }), "", rankOptions(ctx))
    .slice(0, SUGGESTIONS_LIMIT)
  var taken = {}
  recent.forEach(function(r) { taken[r.candidate.id] = true })
  var rest = decorated.filter(function(c) { return !taken[c.id] }).map(function(c) { return { candidate: c, record: null } })
  var out = []
  if (recent.length) out.push({ id: "recent", title: "Recent", rows: recent })
  if (rest.length) out.push({ id: "items", title: recent.length ? (itemsTitle || "Items") : "", rows: rest })
  return out
}

// Inside a query scope: the typed text first, then saved searches (when the
// scope keeps them) and the engine's suggestions (when it asks for them).
function querySections(scope, query, saved, suggestions, ctx, deps) {
  var q = String(query || "").trim()
  var out = []
  if (q || scope.home) out.push({ id: "query", title: "", rows: [{ candidate: deps.Scopes.queryCandidate(scope, q, ctx.t, false), record: null }] })
  var taken = {}
  taken[q.toLowerCase()] = true
  if (scope.history && saved.length) {
    var decorated = saved.map(function(c) { return decorate(c, ctx, deps) })
    var ranked = deps.Ranker.rank(decorated, q, rankOptions(ctx))
      .filter(function(r) { return !taken[r.candidate.value.toLowerCase()] })
      .slice(0, MAX_SAVED_SHOWN)
    ranked.forEach(function(r) { taken[r.candidate.value.toLowerCase()] = true })
    if (ranked.length) out.push({ id: "history", title: "Recent Searches", rows: ranked })
  }
  if (scope.suggest && q && suggestions.length) {
    var rows = suggestions.filter(function(s) { return !taken[s.toLowerCase()] }).map(function(s) {
      return { candidate: decorate(deps.Scopes.itemCandidate(scope, { title: s, value: s, subtitle: "" }, ctx.t), ctx, deps), record: null }
    })
    if (rows.length) out.push({ id: "suggestions", title: "Suggestions", rows: rows })
  }
  return out
}

var MAX_SAVED_SHOWN = 8

// A setting as a row: its value shows where other rows show their type.
function settingCandidate(f, value, t, deps) {
  var tr = typeof t === "function" ? t : function(s) { return s }
  var shown = deps.Settings.display(f, value)
  var title = tr(f.title)
  return {
    id: "setting:" + f.key,
    type: "command",
    kind: "setting",
    title: title,
    subtitle: "",
    keywords: [f.key, f.title, f.section].concat(title !== f.title ? [tr(f.section)] : []),
    typeLabel: shown[0],
    typeLabelValues: shown[1],
    settingKey: f.key,
    settingType: f.type,
    isDefault: JSON.stringify(value) === JSON.stringify(f.defaultValue),
    rootSearch: { when: "never" }
  }
}

// The two rows under the settings: the scopes folder and saved web searches.
var SETTINGS_ACTIONS = [
  { id: "settings-action:open-scopes", title: "Open Scopes Folder", glyph: "\uf07c", keywords: ["scopes", "folder", "files"] },
  { id: "settings-action:clear-searches", title: "Clear Saved Web Searches", glyph: "\uf1f8", keywords: ["history", "clear", "web", "search"] }
]

function settingsActionCandidate(a, t) {
  var tr = typeof t === "function" ? t : function(s) { return s }
  return { id: a.id, type: "command", kind: "settings-action", title: tr(a.title), subtitle: "", keywords: a.keywords.concat([a.title]),
           typeLabel: "Command", glyph: a.glyph, rootSearch: { when: "never" } }
}

// The settings view: one section per Settings.SECTIONS, in field order; a
// query ranks every row instead. Hidden fields stay in shell.json only.
function settingsSections(values, query, ctx, deps) {
  var q = String(query || "").trim()
  var rows = []
  var bySection = {}
  var fields = deps.Settings.fields
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i]
    if (f.hidden) continue
    var c = settingCandidate(f, values[f.key], ctx.t, deps)
    rows.push(c)
    ;(bySection[f.section] = bySection[f.section] || []).push(c)
  }
  var extras = SETTINGS_ACTIONS.map(function(a) { return settingsActionCandidate(a, ctx.t) })
  if (q) {
    var ranked = deps.Ranker.rank(rows.concat(extras), q, rankOptions(ctx))
    return ranked.length ? [{ id: "results", title: "Results", rows: ranked }] : []
  }
  var out = []
  for (var s = 0; s < deps.Settings.SECTIONS.length; s++) {
    var name = deps.Settings.SECTIONS[s]
    if (bySection[name]) out.push({ id: "settings-" + s, title: name, rows: bySection[name].map(function(c) { return { candidate: c, record: null } }) })
  }
  out.push({ id: "settings-more", title: "More", rows: extras.map(function(c) { return { candidate: c, record: null } }) })
  return out
}

function actionsFor(candidate) {
  if (candidate.kind === "setting") {
    var type = candidate.settingType
    var number = type === "integer" || type === "number"
    var forSetting = [{ id: "open", title: type === "boolean" ? "Toggle" : type === "enum" ? "Next Option" : "Edit", shortcut: "↵", section: "primary", icon: "" }]
    if (type === "enum") forSetting.push({ id: "setting-previous", title: "Previous Option", shortcut: "←", section: "primary", icon: "" })
    if (number) {
      forSetting.push({ id: "setting-next", title: "Increase", shortcut: "→", section: "primary", icon: "" })
      forSetting.push({ id: "setting-previous", title: "Decrease", shortcut: "←", section: "primary", icon: "" })
    }
    if (type === "enum") forSetting.push({ id: "setting-next", title: "Next Option", shortcut: "→", section: "primary", icon: "" })
    if (type === "boolean") forSetting.push({ id: "setting-next", title: "Toggle", shortcut: "→", section: "primary", icon: "" })
    forSetting.push({ id: "copy-setting-command", title: "Copy Setting Command", shortcut: "Ctrl Shift C", section: "copy", icon: "" })
    if (!candidate.isDefault) forSetting.push({ id: "reset-setting", title: "Reset to Default", shortcut: "", section: "delete", icon: "" })
    return forSetting
  }
  if (candidate.kind === "settings-action") return [{ id: "open", title: "Run", shortcut: "↵", section: "primary", icon: "" }]
  if (candidate.kind === "scope-item" || candidate.kind === "scope-query") {
    var inScope = [{ id: "open", title: candidate.openTitle || "Open", shortcut: "↵", section: "primary", icon: "" }]
    var extra = candidate.scopeActions || []
    for (var a = 0; a < extra.length; a++)
      inScope.push({ id: "scope-action:" + a, title: extra[a].title, shortcut: "", section: extra[a].copy !== undefined ? "copy" : "primary", icon: "" })
    if (candidate.saved) {
      inScope.push({ id: "delete-history", title: "Delete from History", shortcut: "Ctrl D", section: "delete", icon: "" })
      inScope.push({ id: "clear-history", title: "Clear Search History", shortcut: "Ctrl Shift D", section: "delete", icon: "" })
    } else if (candidate.kind === "scope-item" && candidate.frecency > 1) {
      inScope.push({ id: "reset-ranking", title: "Reset Ranking", shortcut: "", section: "configure", icon: "" })
    }
    return inScope
  }
  if (candidate.kind === "calculator" || candidate.kind === "calculator-history") {
    // ↵ copies, Ctrl ↵ pastes (SPEC §8 Calculator) [O]; delete keys are
    // the Windows `clear` shortcuts (ref 04 §2.8).
    var calc = [
      { id: "copy-answer", title: "Copy Answer", shortcut: "↵", section: "primary", icon: "" },
      { id: "paste-answer", title: "Paste Answer", shortcut: "Ctrl ↵", section: "primary", icon: "" },
      { id: "copy-plain", title: "Copy Plain Answer", shortcut: "Ctrl Shift C", section: "copy", icon: "" },
      { id: "copy-question-answer", title: "Copy Question and Answer", shortcut: "", section: "copy", icon: "" }
    ]
    if (candidate.kind === "calculator") {
      calc.push({ id: "open-history", title: "Open Calculator History", shortcut: "", section: "configure", icon: "" })
    } else {
      calc.push({ id: "delete-entry", title: "Delete Entry", shortcut: "Ctrl D", section: "delete", icon: "" })
      calc.push({ id: "delete-all-entries", title: "Delete All Entries", shortcut: "Ctrl Shift D", section: "delete", icon: "" })
    }
    return calc
  }
  var primary
  var list = []
  switch (candidate.kind) {
    case "app": primary = { id: "open", title: "Open Application", icon: "\uf35d" }; break
    case "omarchy-action": primary = { id: "open", title: "Run", icon: "\uf04b" }; break
    case "omarchy-menu":
    case "omarchy-link": primary = { id: "open", title: "Open Menu", icon: "\uf054" }; break
    case "scope": primary = { id: "open", title: "Open Scope", icon: "\uf002" }; break
    default: primary = { id: "open", title: "Open Command", icon: "\uf054" }
  }
  primary.shortcut = "↵"
  primary.section = "primary"
  list.push(primary)

  if (candidate.kind && candidate.kind.indexOf("omarchy-") === 0)
    list.push({ id: "open-in-omarchy-menu", title: "Open in Omarchy Menu", shortcut: "Ctrl ↵", section: "primary", icon: "\ue900" })

  if (candidate.kind === "app") list.push({ id: "open-new", title: "Open New Window", shortcut: "Shift ↵", section: "primary", icon: "" })
  if (candidate.kind === "app") list.push({ id: "copy-id", title: "Copy Desktop ID", shortcut: "Ctrl Shift C", section: "copy", icon: "\uf0c5" })
  if (candidate.kind === "omarchy-action") list.push({ id: "copy-command", title: "Copy Command", shortcut: "Ctrl Shift C", section: "copy", icon: "\uf0c5" })

  if (candidate.favoriteOrder === null || candidate.favoriteOrder === undefined) {
    list.push({ id: "favorite-add", title: "Add to Favorites", shortcut: "Ctrl Shift F", section: "favorites", icon: "\uf005" })
  } else {
    list.push({ id: "favorite-remove", title: "Remove from Favorites", shortcut: "Ctrl Shift F", section: "favorites", icon: "\uf006" })
    list.push({ id: "favorite-up", title: "Move Up in Favorites", shortcut: "Ctrl Alt ↑", section: "favorites", icon: "\uf062" })
    list.push({ id: "favorite-down", title: "Move Down in Favorites", shortcut: "Ctrl Alt ↓", section: "favorites", icon: "\uf063" })
  }
  list.push({ id: "set-alias", title: candidate.alias ? "Change Alias" : "Set Alias", shortcut: "", section: "configure", icon: "\uf02b" })
  if (candidate.alias) list.push({ id: "remove-alias", title: "Remove Alias", shortcut: "", section: "configure", icon: "\uf02b" })
  if (candidate.frecency > 1) list.push({ id: "reset-ranking", title: "Reset Ranking", shortcut: "", section: "configure", icon: "\uf0e2" })
  list.push({ id: "disable", title: "Disable Command", shortcut: "Alt Shift D", section: "delete", icon: "\uf05e" })
  return list
}

function reorderFavorites(commands, id, action) {
  var favs = []
  for (var key in commands) if (typeof commands[key].favoriteOrder === "number") favs.push({ id: key, order: commands[key].favoriteOrder })
  favs.sort(function(a, b) { return a.order - b.order })
  var ids = favs.map(function(f) { return f.id })
  var at = ids.indexOf(id)
  if (action === "favorite-add" && at < 0) ids.push(id)
  else if (action === "favorite-remove" && at >= 0) ids.splice(at, 1)
  else if (action === "favorite-up" && at > 0) { ids.splice(at, 1); ids.splice(at - 1, 0, id) }
  else if (action === "favorite-down" && at >= 0 && at < ids.length - 1) { ids.splice(at, 1); ids.splice(at + 1, 0, id) }
  var out = {}
  for (var i = 0; i < favs.length; i++) out[favs[i].id] = null
  for (var j = 0; j < ids.length; j++) out[ids[j]] = j
  return out
}

// Destructive commands ask first, as Raycast's System commands do ("Are
// you sure you want to shut down?", ref 04 §1) [O]. Omarchy's own scripts
// don't confirm.
var CONFIRMATIONS = {
  "omarchy:system.shutdown": { title: "Shut Down", message: "Are you sure you want to shut down?", primary: "Shut Down" },
  "omarchy:system.reboot": { title: "Restart", message: "Are you sure you want to restart?", primary: "Restart" },
  "omarchy:system.logout": { title: "Log Out", message: "Are you sure you want to log out?", primary: "Log Out" }
}

function confirmationFor(id, action) {
  var c = action === "open" ? CONFIRMATIONS[id] : null
  if (id === "settings-action:clear-searches" && action === "open") c = { title: "Clear Saved Web Searches", message: "This removes every saved search in every web search scope.", primary: "Clear" }
  if (action === "clear-history") c = { title: "Clear Search History", message: "This removes every saved search in this scope.", primary: "Clear" }
  if (action === "delete-all-entries") c = { title: "Delete All Entries", message: "This removes every calculation from Calculator History.", primary: "Delete All" }
  return c ? { title: c.title, message: c.message, primary: c.primary, destructive: true } : null
}

// The About panel (Ctrl+Shift+K, ref 04 §2.5 toggleAboutPanel): what a row
// is and where it comes from, as label/value pairs. [I]
function aboutFor(c, nowMs) {
  var rows = []
  // values: the value is an English template to translate and fill.
  function add(label, value, values) {
    if (value !== undefined && value !== null && String(value) !== "") rows.push(values ? { label: label, value: String(value), values: values } : { label: label, value: String(value) })
  }
  if (c.kind === "calculator") {
    add("Question", c.calcInput)
    add("Answer", c.calcResult)
    if (c.calcPlain && c.calcPlain !== c.calcResult) add("Plain", c.calcPlain)
    return rows
  }
  if (c.kind === "calculator-history") {
    add("Question", c.subtitle)
    add("Answer", c.title)
    add("Saved", c.typeLabel, c.typeLabelValues || [])
    return rows
  }
  add("Title", c.title)
  add("Type", c.typeLabel)
  if (c.kind !== "scope-query") add("Location", c.subtitle)
  add("ID", c.id)
  if (c.kind === "app") add("Desktop Entry", c.appId + ".desktop")
  if (c.kind === "omarchy-action") add("Command", c.action)
  if (c.kind === "omarchy-link") add("Opens", c.target)
  if (c.kind === "scope-item") add("Value", c.value)
  if (c.kind === "scope-query") add("Query", c.value)
  if (c.kind === "scope") add("Keyword", c.scopeKeyword)
  add("Keywords", (c.keywords || []).join(", "))
  add("Alias", c.alias)
  if (typeof c.favoriteOrder === "number") add("Favorite", "#" + (c.favoriteOrder + 1))
  if (c.openedAt) add("Last Opened", relativeParts(c.openedAt, nowMs)[0], relativeParts(c.openedAt, nowMs)[1])
  if (c.frecency > 1) add("Frecency", Math.round(c.frecency * 10) / 10)
  return rows
}

if (typeof module !== "undefined") {
  module.exports = {
    SUGGESTIONS_LIMIT: SUGGESTIONS_LIMIT,
    BUILTINS: BUILTINS,
    FILTERS: FILTERS,
    confirmationFor: confirmationFor,
    aboutFor: aboutFor,
    appCandidate: appCandidate,
    appWindowKeys: appWindowKeys,
    windowClassKeys: windowClassKeys,
    findAppWindow: findAppWindow,
    menuCandidate: menuCandidate,
    menuCandidates: menuCandidates,
    builtinCandidate: builtinCandidate,
    CALCULATOR_ID: CALCULATOR_ID,
    calculatorCandidate: calculatorCandidate,
    historyCandidate: historyCandidate,
    historySections: historySections,
    decorate: decorate,
    rootSections: rootSections,
    submenuSections: submenuSections,
    appGridSections: appGridSections,
    scopeSections: scopeSections,
    isAppGridItem: isAppGridItem,
    actionsFor: actionsFor,
    reorderFavorites: reorderFavorites,
    querySections: querySections,
    settingsSections: settingsSections,
    settingCandidate: settingCandidate,
    SETTINGS_ACTIONS: SETTINGS_ACTIONS
  }
}
