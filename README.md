# Foamy Menu

Omarchy's stock menu with a configurable minimum width and bar icon. The plugin
loads the installed menu directly; it does not copy its model, entries, search,
application handling, or dialogs. Omarchy updates supply those implementations.

## Install

Requires Omarchy Quattro with the stock menu and application-library components,
plus a bar font containing your chosen icon (the default is the Arch glyph).

If another clone of `omarchy.menu` is enabled, disable that clone first. Keep one
menu replacement enabled.

```sh
omarchy plugin add https://github.com/foamrider/foamy-menu.git --enable
omarchy restart shell
```

Existing `omarchy menu summon` shortcuts still work. For local development, link
this checkout to `~/.config/omarchy/plugins/foamy.menu` and enable `foamy.menu`.

## Configure

Set these fields on the `foamy.menu` entry in `~/.config/omarchy/shell.json`, under
`bar.layout.left`, `center`, or `right`. Omarchy 4.5 also supports
`centerBegin`, `centerEnd`, and `tray`:

```json
{
  "id": "foamy.menu",
  "width": 360,
  "icon": "󰣇",
  "iconFont": ""
}
```

- `width`: minimum menu width in Omarchy's scaled units, from 0 to 4096. Default
  360; 0 uses stock width. Wider stock menus retain their size, and the menu stays
  within the screen. Script selection/input dialogs retain their requested width.
- `icon`: bar glyph or text. Default `󰣇`.
- `iconFont`: font family for the icon. Empty uses the bar font. To use the stock
  Omarchy logo, set `icon` to `"\ue900"` and `iconFont` to `"omarchy"`.

Settings update through Omarchy's normal shell configuration reload. A single
glyph is drawn with the stock bar icon button (the same slot and centring as
the stock menu icon); longer text gets a button that fits it. Left-click
toggles the menu; right-click opens the default terminal. Menu entry
customization continues to use `~/.config/omarchy/extensions/omarchy-menu.jsonc`.

## Compatibility

The menu itself is the installed stock menu, so it looks and behaves exactly
like Omarchy's own on 4.0.6 and 4.5 (keyboard, search, motion, language).
Foamy Menu only changes the card's minimum width and the bar icon.

The wrapper reuses the host application library. If a configuration reload
revokes that capability, it loads Omarchy's packaged `AppLibrary.qml` as a
fallback and releases it when the host capability is available again.
Width settings are watched directly in `shell.json` for the same reason.
Application discovery and launch logic still come entirely from Omarchy.

The bar icon toggles the menu in-process through the plugin's shell API
(Foamy Menu owns `omarchy.menu` while it is the enabled menu clone). If that
API is missing or declines, it runs the same `omarchy-shell shell toggle`
command as the stock icon.

The adapter forwards the stock menu's summon actions to the host API. On 4.5
that API lets a menu clone summon only itself, so the menu entries that open
other overlays (clipboard, speed tests, image picker, Wi-Fi QR) are declined
and the stock menu falls back to its command, `omarchy-shell shell summon …`.
They work, at the cost of one short process per use. Omarchy 4.0.6 always
uses the stock command dispatch.

### Private Omarchy internals

Foamy Menu depends on these parts of the installed shell, which are not a
public plugin API:

- `$OMARCHY_PATH/shell/plugins/menu/Menu.qml`, loaded by path, and its
  `open`/`close`/`refresh`/`ping` functions and `opened`, `shell` and
  `manifest` properties;
- the menu's card: a `BorderSurface` directly inside the menu's window
  (`PanelWindow` on 4.0.6, `OverlayWindow` on 4.5), whose `width` is
  overridden;
- the menu's `cardWidth` (the stock width, kept as the minimum) and
  `dmenuActive` (selection/input dialogs keep their requested width);
- `$OMARCHY_PATH/shell/services/AppLibrary.qml`, the fallback library.

Menu entry additions or removals need no Foamy update; a structural change to
those internals may. If the card can't be found, the plugin logs an error and
leaves the stock layout in place. `./test.sh` loads each host's real menu and
fails when any of these change, so run it against every new Omarchy release.
Reload or restart the shell after updating Omarchy to load its new code.

## Development

```sh
./test.sh                                   # 4.0.6 and 4.5
python3 -I tests/runtime.py --host 4.5 --shots /tmp/menu-shots
omarchy plugin validate .
qmllint -I /usr/share/omarchy/shell Menu.qml BarWidget.qml
```

`tests/runtime.py` runs the stock menu offscreen with the
[foamy-kit](https://github.com/foamrider/foamy-kit) harness (a checkout at
`~/GitHub/Personal/foamy-kit`, or `FOAMY_KIT`): temporary HOME and XDG
directories, no Wayland or Hyprland variables, and every `omarchy-*` command
on PATH stubbed, so it never touches the desktop or its shell. Hosts are
`/usr/share/omarchy/shell` (4.0.6) and `/tmp/omarchy-ref/v45/shell` (4.5);
`FOAMY_HOST_40` / `FOAMY_HOST_45` override them. Each run loads the host's own
menu with its window swapped for an offscreen one. It checks the width rules,
the application-library sharing and fallback, live settings, summon routing
(accepted, declined, revoked and older facades) and the bar button. It needs
`python` and `quickshell`.

## Remove

```sh
omarchy plugin remove foamy.menu
```

When removing an enabled replacement, Omarchy restores `omarchy.menu`. Restart
the shell with `omarchy restart shell` to reload the stock menu. Your application
entries and `omarchy-menu.jsonc` customizations remain unchanged.

Omarchy manages the plugin entry in `shell.json`. Packages and data outside
the plugin directory are retained unless you remove them separately.

## License

[MIT](LICENSE), with the [Omarchy notice](LICENSE-OMARCHY) for the derived bar widget.

Menu text is provided by the installed Omarchy menu and follows its language selection on 4.5.
