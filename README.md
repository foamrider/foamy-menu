# Foamy Menu

An Omacast-based launcher for Omarchy with Foamy's configurable Arch icon.
Search apps and Omarchy actions, use aliases and favorites, open the action
panel, and calculate directly in the launcher. Scopes such as the built-in SSH
scope turn a keyword into a tag in the search field and list their own items.
Search ranking learns from use. The launcher follows the current Omarchy theme
and language (English and Norwegian).

![The Foamy Menu launcher listing Omarchy commands and search scopes](preview.png)

The implementation is adopted from [Omacast](https://github.com/typecraft-dev/oma-cast),
snapshot `98bd0bb1cd1adf787afc704ff31f951d3c938708` (2026-11-02).
It lives in this repository and does not require the Omacast plugin.
Upstream MIT attribution is retained in [LICENSE-OMACAST](LICENSE-OMACAST).
The bundled flea-search helper retains its license and provenance in `search/`.

## Install and use

Requires Omarchy Quattro with Quickshell and the stock menu components.
Search uses the bundled helper (`bin/x86_64/` and `bin/aarch64/foamy-menu-search`,
static binaries, no Rust needed). It starts with the first search and keeps
running; it receives the app and command list once, then one query per
keystroke, and skips fields that cannot match before scoring them. On other
CPUs, or when the helper exits or takes over a second to answer, the menu
uses its built-in matcher for the rest of the shell session. The same binary
lists the SSH scope's hosts (`foamy-menu-search ssh-hosts`, one short run each
time the scope loads); on a CPU without it, the SSH scope says the helper isn't
available.

```sh
omarchy plugin add https://github.com/foamrider/foamy-menu.git --enable
omarchy restart shell
```

The Arch bar button and the normal Super+Space menu shortcut open the launcher.
Right-clicking the bar button opens the default terminal.

- Enter opens the selected result; Shift+Enter opens a new application window.
- Ctrl+K opens actions; Ctrl+Shift+F toggles a favorite; Ctrl+, opens the settings.
- Arrow keys navigate; Esc goes back or closes; Shift+Esc returns to root.
- **Apps** opens an icon grid of every application inside the launcher, A–Z,
  with the search field on top. Typing narrows and ranks the grid; arrow keys
  move in two dimensions; Esc clears the search, then goes back.
- Type `ssh` and press Tab to search your SSH hosts; Enter connects.
  `g rust async` + Tab searches Google (`ddg` for DuckDuckGo). See
  [Scopes](#scopes) for adding your own.
- Type `2 + 3 * 4`, `20% of 50`, `5 ft to cm`, or `10 usd to eur` to calculate.
  The answer shows large on the right with the expression above it, written as
  Omarchy's language writes numbers and dates (`2 469 135,782`, `mandag 9.
  november 2026`). Enter copies it as shown; Ctrl+Shift+C copies the plain form
  (`2469135.782`); Ctrl+Enter pastes. Calculator History lists saved results.
- Typing follows the language too: with a decimal comma, `2,5 * 2` and
  `2 469 135,782 / 2` work and `;` separates function arguments
  (`max(1; 2)`). Norwegian words work alongside English: `5 fot til cm`,
  `20 % av 50`, `3 dager fra nå`, `tid i tokyo`, `12,50 kr til usd`.
- Dates: `om 3 dager` / `in 3 days`, `3 dager siden`, `i dag + 2 uker`,
  `neste fredag`, `i morgen`, `24. des`, `dager til jul` (Christmas Eve),
  `uker til 17. mai`, `dager siden nyttår`, `dec 24 - today`. Months can be
  short (`des`, `okt`, `dec.`), and with a day-first language `24.12` and
  `24.12.2026` are dates. A date written without a year counts to its next
  occurrence with `til`/`until` and from its last one with `siden`/`since`.
  A bare weekday, month or holiday stays a search; add a day, `neste` or
  `+ 0 dager` to get a date.
- Aliases, disabled commands, search history, unit/date/time-zone conversions,
  compact mode and zoom are inherited from Omacast.

These are the implemented upstream features. Raycast extensions, a settings
window, snippets and a dedicated clipboard history view are not implemented.

## Settings

Open **Foamy Menu Settings** with **Ctrl+,** or by searching "settings":

- Enter flips a switch or picks the next choice; ← and → step choices and
  numbers.
- Enter on a number or text (width, icon, font) edits it in the search field;
  Enter saves, Esc cancels. Empty means the default.
- Typing filters the list. Ctrl+K offers **Reset to Default** and **Copy
  Setting Command** (the `omarchy bar set` line, for your dotfiles).
- **Open Scopes Folder** and **Clear Saved Web Searches** sit at the end.

Settings are the `foamy.menu` entry in `~/.config/omarchy/shell.json`, as for
every Omarchy shell plugin: `manifest.json` declares them
(`barWidget.defaults` and `barWidget.schema`). The settings view writes there
through the shell (`updateEntryInline`, or `omarchy bar set` when the shell
does not allow it); you can also use `omarchy bar set` (`--json` for
`true`/`false` and numbers) or edit the file. Changes apply without a
restart. A missing or invalid value uses the default. `logLevel` is only in
`shell.json`.

```sh
omarchy bar set foamy.menu webSearchHistory true --json
omarchy bar set foamy.menu windowMode compact
omarchy bar get foamy.menu webSearchHistory
```

| Key | Default | Values | Meaning |
|---|---|---|---|
| `width` | `360` | 0–4096 | Minimum menu width (0 = default) |
| `icon` | Arch logo (`󰣇`) | string | Bar icon |
| `iconFont` | `""` | string | Icon font (empty = bar font) |
| `windowMode` | `"expanded"` | `expanded` / `compact` | Window: expanded, or compact (only the search field until you type) |
| `escapeKeyBehavior` | `"pop-back-or-close"` | `pop-back-or-close` / `close-and-pop-to-root` | Esc: go back one level, or close and start over |
| `popToRootTimeout` | `90` | 0–3600 | Seconds a closed launcher keeps its place (0 = always start over) |
| `navigationBindings` | `"emacs"` | `emacs` / `vim-motions` | Move keys besides the arrows: Ctrl+N/P (emacs) or Ctrl+J/K (vim-motions) |
| `rootSearchSensitivity` | `"medium"` | `low` / `medium` / `high` | How loosely search matches typos |
| `keepVisibleOnFocusLoss` | `false` | boolean | Stay open when clicking outside |
| `sshScope` | `true` | boolean | SSH scope (ssh + Tab) |
| `webSearchHistory` | `false` | boolean | Save web searches and list them as Recent Searches |
| `webSearchSuggestions` | `false` | boolean | Show search suggestions while typing (sends what you type to the engine) |
| `currencyRates` | `true` | boolean | Download exchange rates for currency conversion |
| `clockFormat` | `"auto"` | `auto` / `12h` / `24h` | Clock in time calculations (auto follows the system) |
| `remToPxRate` | `16` | 1–1000 | Pixels per rem in unit conversions |
| `workHoursPerDay` | `8` | 1–24 | Hours in a work day in time conversions |
| `logLevel` | `"info"` | `trace` / `debug` / `info` / `warning` / `error` / `fatal` | Log level |

`icon` and `iconFont` style the bar button and the launcher header (an empty
font uses Omarchy's). `width` is a minimum: the launcher keeps its 750-unit
layout and stays inside the screen; stock menus keep their own width rules.
Zoom (Ctrl +/−), favorites, aliases, ranking and history are not settings:
they are kept in `~/.local/share/foamy-menu/db/`.

## Scopes

A scope is a keyword that becomes a tag in the search field, and swaps the
list for the scope's own items. Enter one in either of two ways:

- Type its keyword and press **Tab**: `ssh` + Tab. Text after the keyword
  carries in as the scope's search, so `ssh prod` + Tab opens SSH searching
  for "prod".
- Select the scope's row in the root search (it ranks, and takes favorites
  and aliases, like any command) and press **Tab** or **Enter**.

Backspace on an empty search, Esc or a click on the tag leaves the scope.
Items are searched only inside their scope, never in the root search. Recently
used items come first; the rest follow in the source's order.

### SSH (built in)

Lists every concrete `Host` in `~/.ssh/config` and the files it `Include`s
(patterns such as `*.internal` are skipped), with `user@hostname:port` from
the host's own blocks, read the way ssh reads them: keywords in any case,
`Key value` or `Key=value`, quotes and `#` comments; the first value of each
setting wins; `Include` is read where it stands (globs, relative paths under
`~/.ssh`, `~/`), each file once, so cycles are harmless. `Match` blocks and
pattern blocks such as `Host *` are not applied. Files are read with bounds
(1 MiB each, 256 files, Include depth 16) and only when they resolve to a
regular file; `FOAMY_SSH_CONFIG` names another config (for tests). Enter opens
the default terminal through `omarchy-launch-tui --app-id=TUI.tile` and runs
`ssh <host>`; if ssh fails, the window stays open until a key is pressed.
Ctrl+K offers **Copy SSH Command**, **Copy Host Name** and **Open in Files
(SFTP)**. Host names must be plain ssh destinations (letters, digits and
`_.:@%+-`, not starting with `-`). Turn the scope off with
`omarchy bar set foamy.menu sshScope false --json`.

### Web search (built in)

**Google** (`g`) and **DuckDuckGo** (`ddg`) are query scopes: they have no
list, the typed text is the item. `g rust async` + Tab, or `g` + Tab and then
typing, shows **Search Google for “rust async”**; Enter opens it in the
browser (`omarchy-launch-browser`). Enter with nothing typed opens the
engine's home page. Ctrl+K offers **Copy Search URL**.

Any text typed in the root search also ends with **Use “…” with…** rows, one
per query scope: Enter searches right away, Tab enters the scope with the
text.

Two extras fill the list. Both are **off** until you turn them on, for every
built-in engine at once:

```sh
omarchy bar set foamy.menu webSearchHistory true --json
omarchy bar set foamy.menu webSearchSuggestions true --json
```

- `webSearchHistory`: your searches in that engine are saved and listed under
  **Recent Searches**, ranked by use and narrowed by what you type. They stay
  in Foamy's own data (`~/.local/share/foamy-menu/db/frecency.json`), at most
  100 per scope. Ctrl+D deletes one; Ctrl+Shift+D clears the scope's history.
  With history off nothing is saved.
- `webSearchSuggestions`: the engine's autocomplete is listed under **Suggestions** as you
  type. This sends what you type to the engine (after a short pause, one
  request at a time); nothing is sent while it is off.

A scope file can set one engine differently, e.g. `{"id": "google",
"suggest": false}` in `~/.config/foamy-menu/scopes/google.json`.

### Your own scopes

Each scope is one JSON file in `~/.config/foamy-menu/scopes/` (created at
startup, owner-only). Files are watched: saving one applies it without a
restart. Scope files hold definitions; switching the built-ins on and off
is a [setting](#settings). A file whose `id` matches a built-in overrides only
the fields it sets, so this keeps the SSH scope but changes its keyword and
terminal:

```json
{"id": "ssh", "keyword": "s", "open": ["ghostty", "-e", "ssh", "{value}"]}
```

A new scope, for example tmux sessions in `~/.config/foamy-menu/scopes/tmux.json`:

```json
{
  "title": "Tmux",
  "subtitle": "Attach to a running session",
  "keyword": "tm",
  "itemsTitle": "Sessions",
  "placeholder": "Search sessions…",
  "source": {"type": "command", "command": ["tmux", "list-sessions", "-F", "#S"]},
  "open": ["omarchy-launch-tui", "tmux", "attach", "-t", "{value}"],
  "openTitle": "Attach",
  "actions": [{"title": "Copy Attach Command", "copy": "tmux attach -t {value}"}]
}
```

or a fixed list of bookmarks:

```json
{
  "id": "bookmarks", "title": "Bookmarks", "keyword": "bm",
  "source": {"type": "list", "items": [
    {"title": "Omarchy", "value": "https://omarchy.org"},
    "https://github.com"
  ]},
  "open": ["omarchy-launch-browser", "{value}"]
}
```

| Field | Default | Meaning |
|---|---|---|
| `id` | file name | Lowercase letters, digits and `-`; matches a built-in to override it |
| `enabled` | `true` | `false` hides the scope |
| `title` | required | The scope's name: its row, tag and footer |
| `subtitle` | `""` | Shown beside the row in the root search |
| `keyword` | `id` | Typed before Tab; no spaces; unique among enabled scopes |
| `icon` / `iconName` | search glyph | A font glyph, or a freedesktop icon name |
| `itemsTitle` | `"Items"` | Heading over the items when recent ones are shown first |
| `placeholder` | `"Search <title>…"` | The search field's hint inside the scope |
| `emptyText` | `"Nothing here yet"` | Shown when the source has no items |
| `source` | required | `{"type": "command", "command": [argv], "timeout": ms}`, `{"type": "list", "items": [...]}` or `{"type": "query"}` |
| `open` | required | argv run on Enter |
| `openTitle` | `"Open"` (`"Search"` for query) | Enter's name in the footer and action panel |
| `home` | none | Query scopes: argv run on Enter with nothing typed |
| `history` | `false` | Query scopes: save searches, list them as Recent Searches |
| `suggest` | `false` | Query scopes: list the engine's suggestions while typing |
| `suggestUrl` | none | Required for `suggest`: an https URL with `{query}` that returns OpenSearch suggestions (`["q", ["one", "two"]]`) |
| `valuePattern` | none | Regular expression a value must match before it is used |
| `actions` | `[]` | Ctrl+K extras: `{"title", "copy": "text"}` or `{"title", "open": [argv]}` |

A command source prints one item per line, `title<TAB>value<TAB>subtitle`
(value defaults to the title). It runs when the scope is entered, with a
10-second default timeout (`timeout` 100–60000 ms); the previous list stays
on screen while it refreshes, and a failed run keeps it. At most 5000 items.

A query scope is one more search engine, for example the Arch Wiki:

```json
{
  "id": "archwiki", "title": "Arch Wiki", "keyword": "aw",
  "source": {"type": "query"},
  "open": ["omarchy-launch-browser", "https://wiki.archlinux.org/index.php?search={query}"],
  "home": ["omarchy-launch-browser", "https://wiki.archlinux.org"]
}
```

Commands are argv arrays and never pass through a shell. `{value}` (the
item's value, or a query scope's typed text), `{query}` (the same,
URL-encoded) and `{plugin}` (this plugin's directory) are replaced inside
single arguments, so a value with spaces or `;` stays one argument; `{value}`
cannot be the program itself. Use `valuePattern` when a program would read a
value starting with `-` as an option. A scope runs with your permissions, like
a desktop entry: only add commands you trust. Invalid files are skipped and
logged (`journalctl --user -t omarchy-shell | grep scopes`).

## Language

The launcher follows **Omarchy → Setup → Language** on Omarchy 4.5, without a
restart. English and Norwegian are included; other languages fall back to
English. Omarchy's own menu items use Omarchy's catalogs
(`default/i18n/<code>/menu.json`), so they match the stock menu, and the
English names stay searchable ("apps" still finds "Apper"). The calculator
reads and writes numbers and dates as the language does, names time units in
it, and understands Norwegian words as well as English; symbols (cm, kg, USD)
and the plain copy stay as they are. Omarchy 4.0 shows English.

Catalogs are `i18n/<code>.json`, keyed by the English text. Another language
is one file next to `no.json`; `tests/i18n.test.js` checks that every key has
an entry with the same `%1` holes. Strings go through foamy-kit's
`FoamyI18n` (`kit/`, synced from foamy-kit; do not edit it here).

## Menu routes

Foamy still owns the `omarchy.menu` replacement route. Root opens the new
launcher; named routes, input dialogs and selection dialogs use the installed
stock menu. **Stock Omarchy Menu** opens the original root menu. User menu
entries remain in `~/.config/omarchy/extensions/omarchy-menu.jsonc`.

The stock adapter uses private Omarchy menu internals for the window/card and
application library. The runtime tests check these against the installed host.

## Side-by-side Omacast

The original `typecraft.omacast` can be enabled alongside `foamy.menu`.
Use Omacast's Alt+Space binding for comparison. Foamy uses IPC/global shortcut
name `foamy-menu`, layer namespace `foamy-menu`, and separate XDG directories:

- Settings: the `foamy.menu` entry in `~/.config/omarchy/shell.json`
- Scopes: `~/.config/foamy-menu/scopes/*.json`
- Favorites, ranking, saved web searches (when on) and calculator history: `~/.local/share/foamy-menu/db/`
- Cache: `~/.cache/foamy-menu/`
- Logs/state: `~/.local/state/foamy-menu/`

Foamy does not migrate, read or change Omacast's data. Both launchers use the
same installed application library and Omarchy actions.

Currency conversion downloads ECB rates from `api.frankfurter.dev` when the
cached rates are over 12 hours old (30-minute retry after failure).
`omarchy bar set foamy.menu currencyRates false --json` turns this off. Other calculations
work offline. History stays local, with owner-only directories and files.

## CLI and development

```sh
bin/foamy-menu show               # also: toggle, hide, ping, isOpen, run <id> (omarchy-shell foamy-menu …)
bin/foamy-menu call calculator.calculate '{"query":"2+2"}'
omarchy bar set foamy.menu windowMode compact
bin/build-search                  # rebuild the bundled helper (developers; see below)
./test.sh                          # JS tests and runtime checks on the installed 4.5 shell
python3 -I tests/launcher.py --shots /tmp/foamy-menu-shots
omarchy plugin validate .
```

The search helper is committed for x86_64 and aarch64 and falls back to the
built-in matcher when it is missing for the CPU or fails. After changing
`search/`, rebuild it with `bin/build-search` (also `foamy-menu build-search`):
it runs foamy-kit's `tools/build-native.sh` (`FOAMY_KIT`, default `../foamy-kit`),
which builds static musl binaries for both arches reproducibly with the pinned
toolchain (`rust-toolchain.toml`, rustup with the musl targets), installs
`bin/<arch>/foamy-menu-search` and updates `search/native.pin`. Cargo output goes
to `~/.cache/foamy-native/foamy-menu`, never into the plugin folder, which the
shell watches. `bin/build-search --test` runs rustfmt, clippy and the cargo tests;
`--verify` rebuilds from scratch and compares bytes. Commit the binaries and the
pin with the source. The helper tests (`cargo test --test protocol` in `search/`,
`node --test tests/*.test.js`) run against another build when `FOAMY_HELPER` holds
a JSON argv prefix with an absolute path, e.g.
`FOAMY_HELPER="[\"$PWD/bin/aarch64/foamy-menu-search\"]"` (qemu-user binfmt).
`tests/ssh-hosts.test.js` runs `foamy-menu-search ssh-hosts` next to the retired
Bash lister (`tests/fixtures/foamy-ssh-hosts.sh`, a test fixture only) over
fixture homes and requires the same bytes, or the documented ssh-correct
difference where the script misread `ssh_config`.

No Node runtime is needed by the plugin; Node is used only for tests. Core logic
lives in `core/`, I/O in `services/`, and the launcher UI in `ui/`. `Menu.qml` routes between `Launcher.qml` and
`StockMenu.qml`; `BarWidget.qml` retains Foamy's bar styling. Scopes are
`core/Scopes.js` (definitions, merging, parsing) and `services/ScopeSource.qml`
(files and commands); the SSH scope lists hosts with
`foamy-menu-search ssh-hosts` (`search/src/ssh_hosts.rs`) and connects with
`bin/foamy-ssh-connect`.

`tests/runtime.py` exercises the stock adapter. `tests/launcher.py` exercises
the new launcher, action panel, calculator, Apps grid, scopes (a fake
`~/.ssh/config` read by the bundled helper, a user scope file, Enter through a
stubbed `omarchy-launch-tui`), keyboard navigation, theme/width layouts and
route handoffs in an isolated offscreen shell with stub commands. It runs the
dark layout in English and the light layout in Norwegian. `preview.png` is
`root.png` from the English dark run of
`python3 -I tests/launcher.py --shots DIR`.
The tests use the foamy-kit harness (`FOAMY_KIT`, default `~/GitHub/Personal/foamy-kit`).
They run on Omarchy 4.5: `FOAMY_HOST_45` (a shell directory), else
`$OMARCHY_TEST_ROOT/shell`, else the installed `/usr/share/omarchy/shell`.
`--host 4.0` and `--host both` run 4.0 only when `FOAMY_HOST_40` names a 4.0
shell and print a SKIP line otherwise. These are harness labels, not version detection.

After source edits, restart the shell to clear Quickshell's QML cache.
No upstream installation or migration scripts are included in Foamy's CLI.

## Remove

```sh
omarchy plugin remove foamy.menu
omarchy restart shell
```

Omarchy restores its stock menu. Foamy's history and settings are retained.
Removing Foamy does not remove the separate Omacast installation.

## License

[MIT](LICENSE), with [Omacast](LICENSE-OMACAST) and
[Omarchy](LICENSE-OMARCHY) MIT notices for adopted code.
