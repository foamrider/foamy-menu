# Plan: add Todoist tasks from Foamy Menu (`td` + Tab)

> Temporary working document for branch `claude/todoist-quick-add`.
> **Delete this file before the branch is merged.** Move anything that must
> stay into README.md, the code or the pull request description.

## Goal

Type `td` + Tab in the launcher, write a task in Todoist's Quick Add syntax,
and press Enter to add it, without opening the Foamy Todoist popup. The
launcher shows a preview of the task while you type, suggests projects,
sections and labels, and shows the result after the add.

The feature uses the Foamy Todoist plugin (its helper, its keyring token and
its cache). It is off by default.

## Agreed decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Design | Preview card in the calculator's style (design A), plus coloured Quick Add tokens in the search field. |
| D2 | Enter | Adds the task and keeps the launcher open with an empty field, ready for the next task. A setting can make Enter close the launcher instead. |
| D3 | Entry | Only `td` + Tab (or the row + Tab/Enter), like scopes. The root search gets no "Add to Todoist" row. |
| D4 | Defaults | Same as Todoist's Quick Add: `#Project` and a date in the text are used; without them the task goes to the Inbox with no date. No default-project setting. |
| D5 | Availability | The setting is always shown, with a note that it needs Foamy Todoist. The `td` keyword and row are offered only when Foamy Todoist is installed. |
| D6 | Your own commands | Not now. Build the Todoist command as a built-in. User files can come later, when a second real use exists. |
| D7 | Shared code | Copy the tokenizer and suggestion matching into the menu for now (from foamy-todoist `Model.js`). |
| D8 | Lock waits | An add can wait up to 15 s for the helper's lock while the Todoist panel syncs. The spinner covers this; it is acceptable. |
| D9 | Notification | Foamy Todoist's helper can send a desktop notification for an add, with useful content and actions (see "Notification"). |
| D10 | Plan file | This file is removed before merge. |
| D11 | Name | The new kind is an **Input** (`source.type: "input"`, row type label "Input"). The existing "Command" (Omarchy menu rows, "Open/Copy/Disable Command", `source.type: "command"`) stays as it is. The settings section is named for the feature: "Todoist". |
| D12 | When to notify | Only when the launcher is closed when the answer arrives (close-on-add setting, Shift+Enter, or Esc during an add), for success, failure and unknown outcome alike. While the launcher is open, the card shows the result and no notification is sent. |
| D13 | Who notifies | Foamy Todoist's helper sends it. The helper has no translations, so the caller passes the translated texts in the request. |
| D14 | Date colouring | Date words are not coloured in the field and no date is computed locally: Todoist parses dates on its server, by account language. The card shows the date text as typed, and after the add the date Todoist set. |

## Design

Based on mockup A with coloured tokens. The launcher keeps its usual layout:
the search field with the scope tag, the list, the footer.

### Search field

- Tag: **Todoist** (with the Todoist mark), as scope tags look today.
- Placeholder: "Add a task…", then "Add another task…" after an add.
- Tokens in the text are coloured, except date words (D14): `#project` and `/section` (accent / purple),
  `@label` (teal), `p1`–`p4` (priority colour), `!reminder` (red),
  `{deadline}`, and ` // description` (muted). The launcher draws its own text
  (no editable Qt text input), so colouring means splitting the drawn text
  into runs. Colours come from the theme palette, not fixed values.

### Card (first row, like the calculator)

- Title large: the task text with the recognised tokens removed.
- Chips under it: date text as typed, `# Project`, `/ Section`, `@ label`,
  `⚑ P2`, `! reminder`, `{deadline}`. A `#project` that does not match a
  known project shows as a muted chip ("new or unknown project"): Todoist
  then keeps the text in the title, as Quick Add does.
- Hint line: "Todoist reads the date when the task is added" when the text
  has words that may be a date. No date is computed locally (Todoist's
  parser depends on the account language and settings; a wrong preview is
  worse than none).

### List under the card

- While the caret is in a `#`, `/`, `@` or `+` token: matching projects,
  sections (of the `#project` before it), labels or people, at most six, as
  in the Todoist panel. ↑/↓ pick; Tab inserts (`#Name` with spaces written
  `\ `). Enter always adds the task, it never inserts a suggestion.
- Otherwise: "Added from here" — tasks added during this shell session, newest
  first, at most 5, with project and the date Todoist set. Enter on one opens
  it in Todoist. This list is in memory only.

### Footer

`Todoist` on the left. Right: **Add Task ↵**, **Insert Tab** (only while a
suggestion list shows), **Actions Ctrl K**.

### States

| State | Card | Rows / actions |
|---|---|---|
| Empty field | "Type a task the way Todoist's Quick Add reads it" and the syntax chips | "Added from here" |
| Typing | Title and chips | Suggestions or "Added from here" |
| Adding | Title and spinner "Adding to Todoist…"; input locked | — |
| Added | "✓ Added" + title + chips from Todoist's reply (real date, project) | **Open in Todoist** (Ctrl+O); field empty |
| Refused (Todoist error) | Red: the translated helper error; text kept | — |
| Unknown outcome | "Todoist may have added it. Check Todoist before you add it again." Text kept | **Open Inbox in Todoist** |
| Rate limited | "Todoist asked to wait %1 s"; Enter blocked until then | — |
| Signed out | "Foamy Todoist is signed out" | **Open Foamy Todoist Settings** |
| Helper missing / wrong version / no helper for CPU | "Foamy Todoist needs an update" or "isn't available on this computer" | — |
| Foamy Todoist not installed | Not reachable: no `td` keyword, no row (D5) | — |

### Keys

| Key | Does |
|---|---|
| `td` + Tab | Enter Todoist (text after `td` carries in) |
| Enter | Add the task (D2: stay open; setting: close) |
| Shift+Enter | The other choice: add and close when Enter stays open, add and stay when Enter closes |
| Tab | Insert the selected suggestion |
| ↑ / ↓ | Move in suggestions or "Added from here" |
| Ctrl+K | Actions: Open in Todoist, Open Foamy Todoist, Copy text |
| Esc | Close suggestions; then clear the text; then leave the scope (launcher's normal rule) |
| Backspace on empty | Leave the scope |

## Settings (foamy-menu `manifest.json`, `core/Settings.js`)

| Key | Default | Section | Title |
|---|---|---|---|
| `todoistQuickAdd` | `false` | Todoist | "Add Todoist tasks (td)" |
| `todoistCloseOnAdd` | `false` | same | "After adding: Stay open / Close" |

The keyword can be changed with a scope file, as for built-ins:
`{"id": "todoist", "keyword": "t"}`.

## Architecture

### Who owns what

- **foamy-todoist** owns the token, the cache, the lock, the API and the
  notification. Its helper is the only process that talks to Todoist.
- **foamy-menu** owns the input, the preview, suggestions and the result
  card. It never reads the keyring or the cache file directly; it only runs
  the helper and reads its JSON replies.
- After a successful add, the menu calls
  `omarchy-shell foamy.todoist refresh` so the bar count and an open panel
  update. A failure of that call is logged, not shown.

### Finding the helper

The Todoist plugin is found next to the menu in Omarchy's plugin folder
(`~/.config/omarchy/plugins/foamy.todoist`). To check during implementation:
how Omarchy resolves the plugin folder (XDG config home, symlinks in a
development checkout), and that the menu's `pluginDir` keeps the plugin
folder path rather than the symlink target. The helper runs as
`bin/$HOSTTYPE/foamy-todoist-helper` through the kit's native wrapper, like
the menu's own helper; exit 126/127 means "no helper for this CPU".

### foamy-todoist changes (separate worktree and pull request)

1. **`names` command** (no network, under the lock, reads the cache):
   `{"ok":true,"contract":1,"state":"signed_in"|"signed_out","inbox_project_id",
   "projects":[{"id","name","parent_id","inbox","shared"}],
   "sections":[{"id","project_id","name"}],
   "labels":[{"name"}],"collaborators":[…],"project_collaborators":{…}}`.
   Bounded like `sync` (same caps); the menu reads at most a fixed number of
   bytes (to be measured, about 4 MiB) and refuses more.
2. **Short `add` reply** on request: `{"text":…,"reply":"task"}` returns only
   `{"ok":true,"contract":1,"added":"<id>","task":{"id","content","project_id",
   "section_id","priority","labels","due":{…}|null},"warning"?…}` instead of
   the full snapshot. The panel keeps using the full reply.
3. **`notify` command** (D12, D13), a separate run after the `add` reply,
   not a flag on `add`: the launcher can close (Esc) while the add is in
   flight, so only after the reply does the menu know whether a notification
   is needed. The menu runs it once per add, only when the launcher is
   closed at that moment. Request (no network, no lock):
   `{"kind":"added"|"failed"|"unknown","texts":{"title":…,"open":…,"detail":…},
   "task":{"id","content","project","due_string","labels"}|null,"text":…}`;
   every user-visible string is translated by the caller. The helper
   validates sizes and the task id, then runs `omarchy-notification-send`
   (fixed program, argv array, no shell):
   - app name "Todoist", the Todoist glyph or icon;
   - headline: "Added to Todoist", "Could not add the task" or "Todoist may
     have added the task" (from `texts.title`);
   - body (added): the task text in bold (markup-escaped: `&`, `<`, `>`),
     then `#Project · <due.string>` (Todoist's own due text, already in the
     account language, so no local date formatting is needed) and `@labels`
     when present. Body (failed / unknown): the typed text and
     `texts.detail` (the translated error, or "Check Todoist before you add
     it again");
   - click and action **Open in Todoist**: `omarchy-shell foamy.todoist
     openTask <id>` (new IPC, see 4), so the panel's configured open command
     is used; for failed / unknown, **Open Inbox in Todoist**
   (`openInbox`) instead;
   - a failure to notify is logged by the menu; the add result is not
     changed by it. Waits at most 2 s for the sender.
   Rich content supported today by foamy-notifications: up to three Omarchy
   action buttons and the bold/line-break markup subset.
4. **IPC `openTask <id>` and `openInbox`** on `foamy.todoist`: validate the
   id (`Model.validId`), build the `app.todoist.com` link and run the
   configured open command. Also used by the menu's "Open in Todoist" and
   "Open Inbox in Todoist".
5. **`contract` field** in `status`, `names` and `add` replies. The menu
   refuses a helper without a contract number it knows ("Foamy Todoist needs
   an update").
6. Rebuild both helper binaries, update `native/native.pin` and
   `THIRD_PARTY_NOTICES.md`; CI must rebuild and attest them at the release
   commit (marketplace binary provenance).

### foamy-menu changes (this worktree)

1. `core/Scopes.js`: new source type `input` (D11). Validation:
   not with `layout` grids, `rootSearch`, `rootSection`, `requireItems`,
   `history` or `suggest`. Only the built-in uses it for now (D6), so a user
   file with `"type": "input"` is refused with a clear log message.
2. Built-in `todoist` scope: keyword `td`, `enabled` from `todoistQuickAdd`
   and from "Foamy Todoist installed" (D5).
3. `core/TodoistInput.js` (new, pure JS): tokenizer (token kind, start, end,
   caret token), title without tokens, suggestion matching and insertion.
   Copied and adapted from foamy-todoist `Model.js` (`suggestions`,
   `projectBefore`, `matchNames`, `applySuggestion`, `names_project`), with a
   comment naming the source and its commit (D7).
4. `services/TodoistSource.qml` (new): runs the helper (`names` when the scope
   opens and after each add; `add` on Enter), one add at a time, a
   generation number so a reply for an old scope visit or an old text is
   dropped (the reply of an add still counts after the launcher closes: it
   decides the notification), `notify` when the launcher is closed as the
   reply arrives (D12), a 30 s deadline with the process group killed
   (`timeout --kill-after=2s 30s`, like the panel), bounded stdout.
5. `ui/ResultRow.qml` / `ui/LauncherWindow.qml`: the card row kind
   (`todoist-input`), chips, coloured field runs, footer hints, the
   Shift+Enter variant, Ctrl+O.
6. `core/Settings.js` + `manifest.json`: the two settings (defaults off /
   stay open).
7. `i18n/en.json`, `i18n/no.json`: every new string, plus the helper's error
   keys the menu shows (copied from foamy-todoist's catalog; the i18n test
   keeps them covered).
8. README: new section under Scopes, settings table, privacy (nothing is sent
   before Enter; the text goes to Todoist through Foamy Todoist's helper).

## Error handling

| Helper reply | Card | Text kept | Retry |
|---|---|---|---|
| `ok` | Added | no (field cleared) | — |
| `ok` + `warning` | Added, plus the muted warning | no | — |
| `SIGNED_OUT`, `INVALID_TOKEN` | Signed out | yes | after sign-in |
| `KEYRING_LOCKED`, `KEYRING_UNAVAILABLE` | The helper's message | yes | Enter again |
| `NETWORK`, `TIMEOUT`, `TLS_UNSUPPORTED`, `HTTP` | The helper's message | yes | Enter again |
| `UNKNOWN_OUTCOME` | "Todoist may have added it…" | yes | Enter again only after a second Enter confirms (no silent duplicate) |
| `RATE_LIMITED` | "Wait %1 s" | yes | Enter blocked until `retry_after` |
| `BUSY`, `LOCK_UNAVAILABLE` | The helper's message | yes | Enter again |
| Exit 126/127, no JSON, unknown contract | "Foamy Todoist needs an update" / "not available" | yes | — |
| Deadline (menu side) | Same as `UNKNOWN_OUTCOME` (the request may have gone out) | yes | as above |

## Bounds and performance

- No process per keystroke: tokenizing and matching run in JS on the
  `names` list, which loads once per scope visit.
- `names` output capped (to be measured) and parsed only when complete.
- At most one `add` in flight; Enter during an add does nothing.
- Text 1–500 characters (Todoist's limit, the helper checks it too).

## Tests and validation

foamy-todoist (`tests/validate.sh`, `kit/native/build-native.sh . --test`):

- Helper tests against the Todoist stand-in: `names` signed in / signed out /
  empty cache; short `add` reply; `notify` for each kind with a fake
  `omarchy-notification-send` on `PATH` (argv recorded, markup escaped,
  oversized or invalid request refused, a failing or hanging sender is an
  error within 2 s); no real notification in any test.
- IPC `openTask` with an invalid id is refused; `openInbox` builds the
  Inbox link.
- foamy-menu runtime test: `notify` runs only when the launcher closed
  before the reply (Esc during an add, close-on-add), never while it is open.

foamy-menu (`tests/validate.sh`):

- `TodoistInput.js` table tests: tokens, caret token, `\ ` escapes, `C#` and
  `email#1` are not projects, insertion, title without tokens.
- Scopes: `input` type validation, built-in hidden when disabled or when
  Foamy Todoist is missing.
- Runtime test (offscreen) with a fake helper: add success, `UNKNOWN_OUTCOME`
  (text kept, second Enter needed), signed out, stale reply after leaving the
  scope is dropped, Enter during an add ignored, close-on-add setting.
- i18n test covers the new keys in both languages.

Visual check (DESIGN.md rule 9): card, chips, coloured field, suggestions,
each state, light and dark theme, Norwegian strings, zoom levels, compact
window mode. Live desktop only with `FOAMY_TEST_DESKTOP=1`.

## Order of work

1. foamy-todoist: `contract`, `names`, short `add` reply, `notify`,
   `openTask` IPC, rebuilt binaries. Own worktree, branch and pull request.
2. foamy-menu: tokenizer and tests, scope type and built-in, source service,
   UI, settings, i18n, README.
3. Codex review for each pull request (`review-change` skill).
4. Release foamy-todoist first (with attested binaries); then foamy-menu,
   which refuses older helpers with "Foamy Todoist needs an update".
5. Delete this file before merging the foamy-menu branch.

## Risks

- **Cross-plugin contract.** foamy-menu depends on foamy-todoist's helper
  JSON. Mitigation: the `contract` number, and tests in both repositories
  against the same reply shapes.
- **Copied tokenizer drifts** from foamy-todoist (D7). Mitigation: comment
  naming the source; revisit sharing if a third copy appears.
- **Task text in argv** of `omarchy-notification-send` (visible in the
  process list for a moment). It is not a secret, but this is new: today the
  helper never puts task text on a command line.
