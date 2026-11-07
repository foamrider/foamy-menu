//! `foamy-menu-search steam-games`: the built-in Steam Games scope's items.
//!
//! Prints every installed Steam game, one per line as
//! `name<TAB>appid<TAB><TAB>icon<TAB>cover` (the subtitle is left empty),
//! sorted case-insensitively by name. `icon` and `cover` are absolute paths
//! to artwork Steam keeps on disk, or empty. Prints nothing when there is no
//! Steam installation.
//!
//! Where it looks:
//!
//! - The Steam root: `$FOAMY_STEAM_ROOT` (for tests), else the first of
//!   `~/.steam/steam` (Steam's own link to its root), `~/.local/share/Steam`
//!   and the Flatpak's `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`
//!   that has a `steamapps` folder.
//! - Libraries: the root and every `path` in
//!   `steamapps/libraryfolders.vdf` (text KeyValues; the pre-2021 form, where
//!   numbered keys hold the path, is read too). Each library's
//!   `steamapps/appmanifest_<appid>.acf` is one installed app: `AppState`
//!   gives `appid`, `name` and `StateFlags` (`0`/`1`, invalid or uninstalled,
//!   are skipped). An app listed in two libraries is shown once.
//! - What the app is: `appcache/appinfo.vdf` (binary KeyValues, versions
//!   27–29; 29 keys entries by a string table). Only the installed apps'
//!   entries are parsed; the rest are skipped by their size. `common/type`
//!   keeps games, applications, demos, betas and mods, dropping tools
//!   (Proton, the Steam Linux Runtime) and redistributables. An app without
//!   an entry is kept unless its name is one of those tools.
//! - Art, under `appcache/librarycache/<appid>/` (files at the top or one
//!   level down, in content-hash folders), or the older flat
//!   `librarycache/<appid>_<name>`:
//!   - cover: the newest `library_600x900_2x.jpg`, `library_600x900.jpg`,
//!     `library_capsule_2x.jpg` or `library_capsule.jpg` (portrait capsules);
//!   - icon: the client icon `steam/games/<common/clienticon>.ico` (several
//!     sizes up to 256 px), else the small `<common/icon>.jpg`, else any
//!     content-hash `.jpg` at the top of the app's folder, else `<appid>_icon.jpg`.
//!
//!   Hashes are 40 hex digits before they become a file name, and a path
//!   with a control character is left out (it would break the line format).
//!
//! Bounds: [`MAX_VDF_BYTES`] per text file (read with
//! `foamy_helper::fs::read_file_limited`: no symlinks, FIFOs or devices),
//! [`MAX_LIBRARIES`] libraries, [`MAX_DIR_ENTRIES`] directory entries per
//! folder, [`MAX_GAMES`] games, [`MAX_APPINFO_ENTRY`] bytes per appinfo entry,
//! [`MAX_STRING_TABLE`] bytes and [`MAX_STRINGS`] strings in its string table,
//! and nesting [`MAX_DEPTH`] in either KeyValues form.

use foamy_helper::fs::read_file_limited;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::SystemTime;

/// Bytes per text KeyValues file (libraryfolders.vdf, app manifests).
pub(crate) const MAX_VDF_BYTES: u64 = 1024 * 1024;
/// Library folders read, the root included.
pub(crate) const MAX_LIBRARIES: usize = 64;
/// Directory entries examined in one folder (steamapps, an art folder).
pub(crate) const MAX_DIR_ENTRIES: usize = 65_536;
/// Games listed (the scope keeps at most this many items).
pub(crate) const MAX_GAMES: usize = 5_000;
/// Bytes of one appinfo.vdf entry; a larger size ends the scan.
pub(crate) const MAX_APPINFO_ENTRY: u32 = 16 * 1024 * 1024;
/// Bytes of the appinfo.vdf v29 string table.
pub(crate) const MAX_STRING_TABLE: u64 = 64 * 1024 * 1024;
/// Strings in the appinfo.vdf v29 string table.
pub(crate) const MAX_STRINGS: u32 = 4_000_000;
/// Nesting of KeyValues objects.
pub(crate) const MAX_DEPTH: usize = 32;
/// Characters of a game name (the scope's limit for a title).
const MAX_NAME_CHARS: usize = 512;

/// `common/type` values listed; anything else (tool, config, dlc, …) is not.
const KEPT_TYPES: [&str; 5] = ["game", "application", "demo", "beta", "mod"];
/// Names of tools that are installed like games, for apps appinfo.vdf lacks.
const TOOL_PREFIXES: [&str; 4] = [
    "Proton ",
    "Steam Linux Runtime",
    "Steamworks Common Redistributables",
    "Steamworks Shared",
];
const COVER_NAMES: [&str; 4] = [
    "library_600x900_2x.jpg",
    "library_600x900.jpg",
    "library_capsule_2x.jpg",
    "library_capsule.jpg",
];

/// A KeyValues node, text or binary. Numbers in binary KeyValues are kept as
/// their decimal text; keys keep their case and are matched without it.
#[derive(Debug, PartialEq)]
pub(crate) enum Kv {
    Str(String),
    Obj(Vec<(String, Kv)>),
}

impl Kv {
    fn get(&self, key: &str) -> Option<&Kv> {
        match self {
            Kv::Obj(children) => children
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v),
            Kv::Str(_) => None,
        }
    }

    fn str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Kv::Str(s) => Some(s),
            Kv::Obj(_) => None,
        }
    }

    fn children(&self) -> &[(String, Kv)] {
        match self {
            Kv::Obj(children) => children,
            Kv::Str(_) => &[],
        }
    }
}

/// What appinfo.vdf says about one app (its `common` section).
#[derive(Debug, Default, PartialEq)]
pub(crate) struct AppInfo {
    pub(crate) kind: Option<String>,
    pub(crate) clienticon: Option<String>,
    pub(crate) icon: Option<String>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Game {
    pub(crate) appid: u32,
    pub(crate) name: String,
    pub(crate) icon: Option<PathBuf>,
    pub(crate) cover: Option<PathBuf>,
}

pub(crate) fn main() -> ExitCode {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from);
    let root = match std::env::var_os("FOAMY_STEAM_ROOT").filter(|r| !r.is_empty()) {
        Some(root) => Some(PathBuf::from(root)),
        None => home.as_deref().and_then(find_root),
    };
    let output = root.map(|root| format(&list(&root))).unwrap_or_default();
    let mut stdout = io::stdout().lock();
    match stdout.write_all(&output).and_then(|()| stdout.flush()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("foamy-menu-search: steam-games: {error}");
            ExitCode::FAILURE
        }
    }
}

/// The Steam root under a home folder: the first candidate with `steamapps`.
pub(crate) fn find_root(home: &Path) -> Option<PathBuf> {
    [
        ".steam/steam",
        ".local/share/Steam",
        ".var/app/com.valvesoftware.Steam/.local/share/Steam",
    ]
    .iter()
    .map(|rel| home.join(rel))
    .find(|root| root.join("steamapps").is_dir())
    .map(|root| fs::canonicalize(&root).unwrap_or(root))
}

/// Every installed game under a Steam root, sorted by name.
pub(crate) fn list(root: &Path) -> Vec<Game> {
    let mut seen = HashSet::new();
    let mut installed = Vec::new();
    for library in libraries(root) {
        for (appid, name) in manifests(&library) {
            if installed.len() >= MAX_GAMES {
                break;
            }
            if seen.insert(appid) {
                installed.push((appid, name));
            }
        }
    }
    let wanted: HashSet<u32> = installed.iter().map(|(appid, _)| *appid).collect();
    let infos = read_appinfo(&root.join("appcache/appinfo.vdf"), &wanted).unwrap_or_default();
    let cache = root.join("appcache/librarycache");
    let mut games: Vec<Game> = installed
        .into_iter()
        .filter(|(appid, name)| is_game(infos.get(appid), name))
        .map(|(appid, name)| {
            let info = infos.get(&appid);
            Game {
                appid,
                icon: find_icon(root, &cache, appid, info),
                cover: find_cover(&cache, appid),
                name,
            }
        })
        .collect();
    games.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.appid.cmp(&b.appid))
    });
    games
}

pub(crate) fn format(games: &[Game]) -> Vec<u8> {
    let mut out = Vec::new();
    let path = |p: &Option<PathBuf>| p.as_deref().and_then(Path::to_str).unwrap_or("").to_owned();
    for game in games {
        out.extend_from_slice(
            format!(
                "{}\t{}\t\t{}\t{}\n",
                game.name,
                game.appid,
                path(&game.icon),
                path(&game.cover)
            )
            .as_bytes(),
        );
    }
    out
}

fn is_game(info: Option<&AppInfo>, name: &str) -> bool {
    match info.and_then(|i| i.kind.as_deref()) {
        Some(kind) => KEPT_TYPES.iter().any(|k| kind.eq_ignore_ascii_case(k)),
        None => !TOOL_PREFIXES.iter().any(|p| name.starts_with(p)) && name != "Proton",
    }
}

// ------------------------------------------------------------ libraries

/// The root, then each library in libraryfolders.vdf, each folder once.
pub(crate) fn libraries(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.to_path_buf()];
    let mut seen: HashSet<PathBuf> = HashSet::new();
    seen.insert(fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()));
    let Ok(data) = read_file_limited(&root.join("steamapps/libraryfolders.vdf"), MAX_VDF_BYTES)
    else {
        return out;
    };
    let Some(top) = parse_text(&data) else {
        return out;
    };
    let Some(folders) = top.get("libraryfolders") else {
        return out;
    };
    for (key, value) in folders.children() {
        let path = match value {
            Kv::Obj(_) => value.str("path"),
            // Before 2021: "1" "/mnt/games/SteamLibrary".
            Kv::Str(path) if key.bytes().all(|b| b.is_ascii_digit()) => Some(path.as_str()),
            Kv::Str(_) => None,
        };
        let Some(path) = path.filter(|p| p.starts_with('/')) else {
            continue;
        };
        if out.len() >= MAX_LIBRARIES {
            break;
        }
        let path = PathBuf::from(path);
        if seen.insert(fs::canonicalize(&path).unwrap_or_else(|_| path.clone())) {
            out.push(path);
        }
    }
    out
}

/// `(appid, name)` of each app manifest in a library, by file name.
pub(crate) fn manifests(library: &Path) -> Vec<(u32, String)> {
    let Ok(dir) = fs::read_dir(library.join("steamapps")) else {
        return Vec::new();
    };
    let mut files: Vec<(u32, PathBuf)> = dir
        .take(MAX_DIR_ENTRIES)
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let appid = name.strip_prefix("appmanifest_")?.strip_suffix(".acf")?;
            Some((parse_appid(appid)?, entry.path()))
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|(appid, path)| {
            let data = read_file_limited(&path, MAX_VDF_BYTES).ok()?;
            let state = parse_text(&data)?;
            let state = state.get("AppState")?;
            if state.str("appid").and_then(parse_appid) != Some(appid) {
                return None;
            }
            if matches!(state.str("StateFlags"), Some("0" | "1")) {
                return None;
            }
            Some((appid, clean_name(state.str("name")?)?))
        })
        .collect()
}

fn parse_appid(text: &str) -> Option<u32> {
    if text.is_empty() || text.len() > 10 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok().filter(|&id| id != 0)
}

/// A name as one field: control characters become spaces, trimmed, capped.
fn clean_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let cleaned: String = cleaned.trim().chars().take(MAX_NAME_CHARS).collect();
    let cleaned = cleaned.trim_end().to_owned();
    (!cleaned.is_empty()).then_some(cleaned)
}

// ------------------------------------------------------------------ art

fn is_hash(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A path the line format can carry, to a regular file.
fn usable(path: PathBuf) -> Option<PathBuf> {
    let text = path.to_str()?;
    if text.chars().any(char::is_control) {
        return None;
    }
    fs::metadata(&path).ok()?.is_file().then_some(path)
}

fn modified(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn find_icon(root: &Path, cache: &Path, appid: u32, info: Option<&AppInfo>) -> Option<PathBuf> {
    let dir = cache.join(appid.to_string());
    let hash = |field: fn(&AppInfo) -> Option<&str>| info.and_then(field).filter(|h| is_hash(h));
    let client = hash(|i| i.clienticon.as_deref())
        .and_then(|h| usable(root.join("steam/games").join(format!("{h}.ico"))));
    let small = || hash(|i| i.icon.as_deref()).and_then(|h| usable(dir.join(format!("{h}.jpg"))));
    if let Some(path) = client.or_else(small) {
        return Some(path);
    }
    let mut hashed: Vec<PathBuf> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .take(MAX_DIR_ENTRIES)
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            name.to_str()
                .and_then(|n| n.strip_suffix(".jpg"))
                .is_some_and(is_hash)
        })
        .map(|entry| entry.path())
        .collect();
    hashed.sort();
    hashed
        .into_iter()
        .find_map(usable)
        .or_else(|| usable(cache.join(format!("{appid}_icon.jpg"))))
}

/// The newest portrait capsule; among equally new ones, the sharper name.
fn find_cover(cache: &Path, appid: u32) -> Option<PathBuf> {
    let dir = cache.join(appid.to_string());
    let mut folders = vec![dir.clone()];
    folders.extend(
        fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .take(MAX_DIR_ENTRIES)
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_str().is_some_and(is_hash))
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .map(|entry| entry.path()),
    );
    let mut candidates: Vec<(PathBuf, usize)> = Vec::new();
    for folder in &folders {
        for (rank, name) in COVER_NAMES.iter().enumerate() {
            if let Some(path) = usable(folder.join(name)) {
                candidates.push((path, rank));
            }
        }
    }
    if candidates.is_empty() {
        for (rank, name) in COVER_NAMES.iter().take(2).enumerate() {
            if let Some(path) = usable(cache.join(format!("{appid}_{name}"))) {
                candidates.push((path, rank));
            }
        }
    }
    candidates
        .into_iter()
        .max_by(|(a, rank_a), (b, rank_b)| {
            modified(a)
                .cmp(&modified(b))
                .then(rank_b.cmp(rank_a))
                .then(b.cmp(a))
        })
        .map(|(path, _)| path)
}

// ---------------------------------------------------- text KeyValues

#[derive(Debug, PartialEq)]
enum Token {
    Open,
    Close,
    Text(String),
}

fn tokenize(data: &[u8]) -> Vec<Token> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if b.is_ascii_whitespace() {
            i += 1;
        } else if data[i..].starts_with(b"//") {
            while i < data.len() && data[i] != b'\n' {
                i += 1;
            }
        } else if b == b'{' {
            out.push(Token::Open);
            i += 1;
        } else if b == b'}' {
            out.push(Token::Close);
            i += 1;
        } else if b == b'"' {
            let mut text = Vec::new();
            i += 1;
            while i < data.len() && data[i] != b'"' {
                if data[i] == b'\\' && i + 1 < data.len() {
                    i += 1;
                    text.push(match data[i] {
                        b'n' => b'\n',
                        b't' => b'\t',
                        other => other,
                    });
                } else {
                    text.push(data[i]);
                }
                i += 1;
            }
            i += 1;
            out.push(Token::Text(String::from_utf8_lossy(&text).into_owned()));
        } else {
            let start = i;
            while i < data.len()
                && !data[i].is_ascii_whitespace()
                && !matches!(data[i], b'{' | b'}' | b'"')
            {
                i += 1;
            }
            let text = String::from_utf8_lossy(&data[start..i]).into_owned();
            // A platform conditional after a value: [$WIN32], [!$X360].
            if !(text.starts_with('[') && text.ends_with(']')) {
                out.push(Token::Text(text));
            }
        }
    }
    out
}

/// Text KeyValues as one object of its top-level keys.
pub(crate) fn parse_text(data: &[u8]) -> Option<Kv> {
    let tokens = tokenize(data);
    let mut pos = 0;
    let children = parse_tokens(&tokens, &mut pos, 0)?;
    Some(Kv::Obj(children))
}

fn parse_tokens(tokens: &[Token], pos: &mut usize, depth: usize) -> Option<Vec<(String, Kv)>> {
    if depth > MAX_DEPTH {
        return None;
    }
    let mut out = Vec::new();
    loop {
        match tokens.get(*pos) {
            None => return (depth == 0).then_some(out),
            Some(Token::Close) => {
                *pos += 1;
                return (depth > 0).then_some(out);
            }
            Some(Token::Open) => return None,
            Some(Token::Text(key)) => {
                *pos += 1;
                match tokens.get(*pos)? {
                    Token::Open => {
                        *pos += 1;
                        out.push((key.clone(), Kv::Obj(parse_tokens(tokens, pos, depth + 1)?)));
                    }
                    Token::Text(value) => {
                        *pos += 1;
                        out.push((key.clone(), Kv::Str(value.clone())));
                    }
                    Token::Close => return None,
                }
            }
        }
    }
}

// --------------------------------------------------------- appinfo.vdf

const APPINFO_V27: u32 = 0x0756_4427;
const APPINFO_V28: u32 = 0x0756_4428;
const APPINFO_V29: u32 = 0x0756_4429;

fn u32_at(data: &[u8], pos: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(pos..pos + 4)?.try_into().ok()?))
}

fn read_u32<R: Read>(reader: &mut R) -> io::Result<u32> {
    let mut buf = [0; 4];
    reader.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

/// Opens a regular file without blocking on a FIFO or device.
fn open_regular(path: &Path) -> io::Result<File> {
    const O_NONBLOCK: i32 = 0o4000; // the same on x86-64 and AArch64
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    Ok(file)
}

/// The `common` section of each wanted app in appinfo.vdf.
pub(crate) fn read_appinfo(
    path: &Path,
    wanted: &HashSet<u32>,
) -> io::Result<HashMap<u32, AppInfo>> {
    let mut reader = BufReader::new(open_regular(path)?);
    let magic = read_u32(&mut reader)?;
    let _universe = read_u32(&mut reader)?;
    let strings = match magic {
        APPINFO_V27 | APPINFO_V28 => None,
        APPINFO_V29 => {
            let mut offset = [0; 8];
            reader.read_exact(&mut offset)?;
            let offset = u64::from_le_bytes(offset);
            let start = reader.stream_position()?;
            reader.seek(SeekFrom::Start(offset))?;
            let strings = read_string_table(&mut reader)?;
            reader.seek(SeekFrom::Start(start))?;
            Some(strings)
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unknown appinfo.vdf version",
            ));
        }
    };
    // Bytes between an entry's size and its KeyValues: info state, last
    // update, access token, SHA-1, change number, and (28+) the binary SHA-1.
    let header = if magic == APPINFO_V27 { 40 } else { 60 };
    let mut out = HashMap::new();
    while out.len() < wanted.len() {
        let appid = read_u32(&mut reader)?;
        if appid == 0 {
            break;
        }
        let size = read_u32(&mut reader)?;
        if size > MAX_APPINFO_ENTRY || (size as usize) < header {
            break;
        }
        if !wanted.contains(&appid) {
            reader.seek_relative(i64::from(size))?;
            continue;
        }
        let mut data = vec![0; size as usize];
        reader.read_exact(&mut data)?;
        let mut pos = header;
        if let Some(kv) = parse_binary(&data, &mut pos, strings.as_deref(), 0) {
            out.insert(appid, app_info(&Kv::Obj(kv)));
        }
    }
    Ok(out)
}

fn read_string_table<R: Read>(reader: &mut R) -> io::Result<Vec<String>> {
    let count = read_u32(reader)?;
    if count > MAX_STRINGS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "appinfo.vdf string table is too large",
        ));
    }
    let data = foamy_helper::io::read_limited(reader, MAX_STRING_TABLE)?;
    let strings: Vec<String> = data
        .split(|&b| b == 0)
        .take(count as usize)
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    Ok(strings)
}

fn app_info(kv: &Kv) -> AppInfo {
    let common = kv.get("appinfo").and_then(|a| a.get("common"));
    let field = |key: &str| common.and_then(|c| c.str(key)).map(str::to_owned);
    AppInfo {
        kind: field("type"),
        clienticon: field("clienticon"),
        icon: field("icon"),
    }
}

fn c_string(data: &[u8], pos: &mut usize) -> Option<String> {
    let len = data.get(*pos..)?.iter().position(|&b| b == 0)?;
    let text = String::from_utf8_lossy(&data[*pos..*pos + len]).into_owned();
    *pos += len + 1;
    Some(text)
}

/// Binary KeyValues up to the end of the current object (0x08).
fn parse_binary(
    data: &[u8],
    pos: &mut usize,
    strings: Option<&[String]>,
    depth: usize,
) -> Option<Vec<(String, Kv)>> {
    if depth > MAX_DEPTH {
        return None;
    }
    let mut out = Vec::new();
    loop {
        let kind = *data.get(*pos)?;
        *pos += 1;
        if kind == 0x08 || kind == 0x0b {
            return Some(out);
        }
        let key = match strings {
            Some(strings) => {
                let index = u32_at(data, *pos)? as usize;
                *pos += 4;
                strings.get(index)?.clone()
            }
            None => c_string(data, pos)?,
        };
        let value = match kind {
            0x00 => Kv::Obj(parse_binary(data, pos, strings, depth + 1)?),
            0x01 => Kv::Str(c_string(data, pos)?),
            0x02 | 0x03 | 0x04 | 0x06 => {
                let raw = u32_at(data, *pos)?;
                *pos += 4;
                Kv::Str(match kind {
                    0x02 => (raw as i32).to_string(),
                    0x03 => f32::from_bits(raw).to_string(),
                    _ => raw.to_string(),
                })
            }
            0x07 | 0x0a => {
                let raw = u64::from_le_bytes(data.get(*pos..*pos + 8)?.try_into().ok()?);
                *pos += 8;
                Kv::Str(if kind == 0x0a {
                    (raw as i64).to_string()
                } else {
                    raw.to_string()
                })
            }
            0x05 => {
                // UTF-16 text up to a 0 unit.
                let mut units = Vec::new();
                loop {
                    let unit = u16::from_le_bytes(data.get(*pos..*pos + 2)?.try_into().ok()?);
                    *pos += 2;
                    if unit == 0 {
                        break;
                    }
                    units.push(unit);
                }
                Kv::Str(String::from_utf16_lossy(&units))
            }
            _ => return None,
        };
        out.push((key, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    struct Root(PathBuf);

    impl Root {
        fn new() -> Root {
            static N: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "foamy-menu-steam-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(path.join("steamapps")).unwrap();
            Root(path)
        }

        fn write(&self, name: &str, data: impl AsRef<[u8]>) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, data).unwrap();
            path
        }

        fn manifest(&self, library: &str, appid: u32, name: &str) {
            let dir = if library.is_empty() {
                String::new()
            } else {
                format!("{library}/")
            };
            self.write(
                &format!("{dir}steamapps/appmanifest_{appid}.acf"),
                format!("\"AppState\"\n{{\n\t\"appid\"\t\t\"{appid}\"\n\t\"name\"\t\t\"{name}\"\n\t\"StateFlags\"\t\t\"4\"\n}}\n"),
            );
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Binary KeyValues for `appinfo/common/{key: value}`, v29 (keys as
    /// string-table indices) or v28 (keys inline).
    fn common_kv(fields: &[(&str, &str)], table: Option<&mut Vec<String>>) -> Vec<u8> {
        let mut table = table;
        let mut out = Vec::new();
        let mut key = |out: &mut Vec<u8>, k: &str| match table.as_deref_mut() {
            Some(t) => {
                let index = t.iter().position(|s| s == k).unwrap_or_else(|| {
                    t.push(k.into());
                    t.len() - 1
                });
                out.extend_from_slice(&(index as u32).to_le_bytes());
            }
            None => {
                out.extend_from_slice(k.as_bytes());
                out.push(0);
            }
        };
        out.push(0x00);
        key(&mut out, "appinfo");
        out.push(0x02);
        key(&mut out, "appid");
        out.extend_from_slice(&7u32.to_le_bytes());
        out.push(0x00);
        key(&mut out, "common");
        for (k, v) in fields {
            out.push(0x01);
            key(&mut out, k);
            out.extend_from_slice(v.as_bytes());
            out.push(0);
        }
        out.extend_from_slice(&[0x08, 0x08, 0x08]);
        out
    }

    fn appinfo(version: u32, apps: &[(u32, &[(&str, &str)])]) -> Vec<u8> {
        let mut table = Vec::new();
        let mut body = Vec::new();
        for (appid, fields) in apps {
            let kv = common_kv(fields, (version == APPINFO_V29).then_some(&mut table));
            let header = if version == APPINFO_V27 { 40 } else { 60 };
            body.extend_from_slice(&appid.to_le_bytes());
            body.extend_from_slice(&((header + kv.len()) as u32).to_le_bytes());
            body.extend(std::iter::repeat_n(0xaa, header));
            body.extend(kv);
        }
        body.extend_from_slice(&0u32.to_le_bytes());
        let mut out = Vec::new();
        out.extend_from_slice(&version.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        if version == APPINFO_V29 {
            let offset = 16 + body.len() as u64;
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend(body);
            out.extend_from_slice(&(table.len() as u32).to_le_bytes());
            for s in table {
                out.extend_from_slice(s.as_bytes());
                out.push(0);
            }
        } else {
            out.extend(body);
        }
        out
    }

    const HASH_A: &str = "2dfa1f3e740ae5300bf59e9a14066391dab4727a";
    const HASH_B: &str = "e033e23c29a192a17c16a7645a2b423ac64ff447";

    #[test]
    fn text_keyvalues_read_like_steam() {
        let kv = parse_text(
            br#"// comment
"libraryfolders" { "0" { "path" "/a \"b\"\\c" "apps" { "10" "1" } } "1" "/old" "x" "y" [$WIN32] }"#,
        )
        .unwrap();
        let folders = kv.get("LIBRARYFOLDERS").unwrap();
        assert_eq!(folders.get("0").unwrap().str("path"), Some("/a \"b\"\\c"));
        assert_eq!(folders.str("1"), Some("/old"));
        assert_eq!(folders.str("x"), Some("y"));
        assert_eq!(
            parse_text(br#""a" { "b" "c""#),
            None,
            "an unclosed object is rejected"
        );
        assert_eq!(parse_text(br#""a" "b" }"#), None);
        let deep = "\"k\" {".repeat(MAX_DEPTH + 2);
        assert_eq!(parse_text(deep.as_bytes()), None, "nesting is bounded");
    }

    #[test]
    fn appinfo_versions_27_to_29_give_type_and_icons() {
        let fields: &[(&str, &str)] = &[("type", "Game"), ("clienticon", HASH_A), ("icon", HASH_B)];
        let other: &[(&str, &str)] = &[("type", "Tool")];
        for version in [APPINFO_V27, APPINFO_V28, APPINFO_V29] {
            let root = Root::new();
            let path = root.write(
                "appinfo.vdf",
                appinfo(version, &[(5, other), (7, fields), (9, other)]),
            );
            let infos = read_appinfo(&path, &HashSet::from([7, 9])).unwrap();
            assert_eq!(
                infos.get(&7),
                Some(&AppInfo {
                    kind: Some("Game".into()),
                    clienticon: Some(HASH_A.into()),
                    icon: Some(HASH_B.into())
                }),
                "version {version:#x}"
            );
            assert_eq!(infos.get(&9).unwrap().kind.as_deref(), Some("Tool"));
            assert!(!infos.contains_key(&5), "unwanted entries are skipped");
        }
        let root = Root::new();
        let bad = root.write("bad.vdf", [0u8; 16]);
        assert!(read_appinfo(&bad, &HashSet::from([7])).is_err());
        let mut truncated = appinfo(APPINFO_V28, &[(7, fields)]);
        truncated.truncate(40);
        let truncated = root.write("truncated.vdf", truncated);
        assert!(read_appinfo(&truncated, &HashSet::from([7])).is_err());
    }

    #[test]
    fn binary_values_of_every_type_parse() {
        let mut data = vec![0x02];
        data.extend_from_slice(b"i\0");
        data.extend_from_slice(&(-3i32).to_le_bytes());
        data.push(0x07);
        data.extend_from_slice(b"u\0");
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        data.push(0x05);
        data.extend_from_slice(b"w\0");
        data.extend_from_slice(&[b'h', 0, b'i', 0, 0, 0]);
        data.push(0x08);
        let kv = Kv::Obj(parse_binary(&data, &mut 0, None, 0).unwrap());
        assert_eq!(kv.str("i"), Some("-3"));
        assert_eq!(kv.str("u"), Some("18446744073709551615"));
        assert_eq!(kv.str("w"), Some("hi"));
        assert_eq!(
            parse_binary(&[0x09, b'k', 0], &mut 0, None, 0),
            None,
            "unknown types stop the parse"
        );
        assert_eq!(
            parse_binary(&[0x01, b'k', 0, b'v'], &mut 0, None, 0),
            None,
            "truncated data too"
        );
    }

    #[test]
    fn games_from_every_library_with_art_and_without_tools() {
        let root = Root::new();
        let lib = root.0.join("lib2");
        root.write(
            "steamapps/libraryfolders.vdf",
            format!(
                "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n\t\"1\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n\t\"2\"\n\t{{\n\t\t\"path\"\t\t\"relative\"\n\t}}\n}}\n",
                root.0.display(),
                lib.display()
            ),
        );
        root.manifest("", 7, "zeta\tgame");
        root.manifest("", 1493710, "Proton Experimental");
        root.manifest("lib2", 9, "Alpha");
        root.manifest("lib2", 7, "Duplicate of zeta");
        root.manifest("lib2", 11, "Steam Linux Runtime 3.0 (sniper)");
        root.manifest("lib2", 12, "Beta Tool");
        root.write(
            "steamapps/appmanifest_13.acf",
            "\"AppState\" { \"appid\" \"13\" \"name\" \"Gone\" \"StateFlags\" \"1\" }",
        );
        root.write(
            "steamapps/appmanifest_14.acf",
            "\"AppState\" { \"appid\" \"99\" \"name\" \"Mismatch\" }",
        );
        root.write(
            "steamapps/appmanifest_x.acf",
            "\"AppState\" { \"appid\" \"15\" \"name\" \"Not a manifest name\" }",
        );
        let game: &[(&str, &str)] = &[("type", "game"), ("clienticon", HASH_A)];
        let tool: &[(&str, &str)] = &[("type", "Tool")];
        root.write(
            "appcache/appinfo.vdf",
            appinfo(APPINFO_V29, &[(7, game), (12, tool)]),
        );
        let ico = root.write(&format!("steam/games/{HASH_A}.ico"), b"ico");
        let small = root.write(&format!("appcache/librarycache/9/{HASH_B}.jpg"), b"jpg");
        let old = root.write("appcache/librarycache/7/library_600x900.jpg", b"old");
        let new = root.write(
            &format!("appcache/librarycache/7/{HASH_B}/library_capsule.jpg"),
            b"new",
        );
        File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(3600))
            .unwrap();
        let flat = root.write("appcache/librarycache/9_library_600x900.jpg", b"flat");

        let games = list(&root.0);
        assert_eq!(
            games,
            vec![
                Game {
                    appid: 9,
                    name: "Alpha".into(),
                    icon: Some(small),
                    cover: Some(flat)
                },
                Game {
                    appid: 7,
                    name: "zeta game".into(),
                    icon: Some(ico),
                    cover: Some(new)
                },
            ]
        );
        let text = String::from_utf8(format(&games)).unwrap();
        assert!(text.starts_with("Alpha\t9\t\t/"), "{text}");
        assert_eq!(text.lines().count(), 2);
    }

    #[test]
    fn a_missing_steam_lists_nothing() {
        let root = Root::new();
        fs::remove_dir_all(root.0.join("steamapps")).unwrap();
        assert!(list(&root.0).is_empty());
        assert_eq!(find_root(&root.0), None);
        fs::create_dir_all(root.0.join(".local/share/Steam/steamapps")).unwrap();
        assert_eq!(
            find_root(&root.0),
            Some(fs::canonicalize(root.0.join(".local/share/Steam")).unwrap())
        );
    }

    #[test]
    fn names_are_one_field() {
        assert_eq!(clean_name(" a\tb\nc "), Some("a b c".into()));
        assert_eq!(clean_name("\t"), None);
        assert_eq!(
            clean_name(&"x".repeat(600)).unwrap().chars().count(),
            MAX_NAME_CHARS
        );
        assert_eq!(parse_appid("007"), Some(7));
        assert_eq!(parse_appid("0"), None);
        assert_eq!(parse_appid("99999999999"), None);
    }
}
