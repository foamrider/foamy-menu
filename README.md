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
`bar.layout.left`, `center`, or `right`:

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

Settings update through Omarchy's normal shell configuration reload. Left-click
opens the menu; right-click opens the default terminal. Menu entry customization
continues to use `~/.config/omarchy/extensions/omarchy-menu.jsonc`.

## Compatibility

The wrapper loads Omarchy's packaged `AppLibrary.qml` for the menu because the
host plugin facade can lose its application-library reference during reloads.
Width settings are watched directly in `shell.json` for the same reason.
Application discovery and launch logic still come entirely from Omarchy.

The width adapter locates the stock menu's `PanelWindow` and `BorderSurface`, and
uses its `cardWidth` and `dmenuActive` properties. These are internal Omarchy QML
interfaces. Menu entry additions/removals require no Foamy update; a structural
change to those interfaces may require one. If the card cannot be located, the
plugin logs an error and leaves the stock layout in place. Reload/restart the
shell after updating Omarchy to load its new code.

## Validate

Run `omarchy plugin validate .` and `qmllint -I "$OMARCHY_PATH/shell" Menu.qml BarWidget.qml`.
Run `./test.sh` in a graphical session for integration checks. It briefly opens
preview menus in a separate Quickshell instance and uses only temporary fixtures.

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
