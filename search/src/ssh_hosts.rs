//! `foamy-menu-search ssh-hosts`: the built-in SSH scope's items.
//!
//! Prints every concrete `Host` in `~/.ssh/config` (or `$FOAMY_SSH_CONFIG`)
//! and the files it `Include`s, one per line as
//! `host<TAB>host<TAB>user@hostname:port`, sorted case-insensitively. Prints
//! nothing when there is no readable config.
//!
//! The config is read the way ssh(1) reads it (readconf.c):
//!
//! - A line is a keyword (case-insensitive) and arguments, separated by
//!   whitespace and/or one `=`; arguments are split like ssh's `argv_split`
//!   (double and single quotes, `\` escapes, `#` at the start of an argument
//!   ends the line). Lines ssh rejects (an unterminated quote, a keyword
//!   without an argument) are skipped.
//! - `Host` names with `*`, `?` or `!` are patterns, not hosts, and are not
//!   listed; neither are names with whitespace or control characters (not a
//!   host argument, and they would break the line format). `Match` starts a
//!   block that applies to no listed host.
//! - `HostName`, `User` and `Port` apply to the concrete names of the block
//!   they are in; the first value ssh would read wins. Blocks of patterns
//!   (`Host *`) and settings before the first `Host` are not applied: the
//!   subtitle shows what a host's own blocks say. A value with a control
//!   character (a tab kept by quotes) leaves the subtitle empty: it would
//!   break the line format.
//! - `Include` is read where it stands, as ssh does: its files come before
//!   the rest of the including file, and an included file's lines before its
//!   own first `Host`/`Match` belong to the including block. Relative paths
//!   are relative to `~/.ssh`; `~` and `~/` are `$HOME`; the argument is a
//!   glob(3) pattern (`*`, `?`, `[…]`, `\`; a leading `.` is only matched by
//!   a literal `.`), and its matches are read in byte order. `~user` is not
//!   expanded (no user database lookup); such an Include matches nothing.
//! - Each file is read at most once (by its canonical path), which also stops
//!   Include cycles; ssh would instead fail on them at depth 16. A file that
//!   is refused (too large, not a regular file) counts as read.
//!
//! Bounds: Include depth [`MAX_DEPTH`] (ssh's own limit) and
//! [`MAX_FILE_BYTES`] per file (a larger file is skipped); in all,
//! [`MAX_FILES`] files, [`MAX_TOTAL_BYTES`] read (the bytes read from a file
//! over its limit included), [`MAX_INCLUDE_PATTERNS`] Include arguments,
//! [`MAX_DIR_ENTRIES`] directory entries examined by globs and [`MAX_HOSTS`]
//! hosts. A config past one of these totals fails the listing: exit 1 with
//! the reason ([`Limit`]) on stderr and nothing printed, as the list would
//! miss the hosts after it. Symlinks are resolved once (`realpath`, as ssh
//! and the old script follow them) and the result must be a regular file,
//! read with `foamy_helper::fs::read_file_limited` (no symlinks, FIFOs,
//! devices or directories, so nothing can block the read).

use foamy_helper::fs::read_file_limited;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Include nesting below the main config (ssh's READCONF_MAX_DEPTH).
pub(crate) const MAX_DEPTH: usize = 16;
/// Config files read in one listing.
pub(crate) const MAX_FILES: usize = 256;
/// Bytes per config file; a larger file is skipped.
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Bytes read across all config files.
pub(crate) const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
/// Include arguments expanded in one listing.
pub(crate) const MAX_INCLUDE_PATTERNS: usize = 4_096;
/// Directory entries Include globs may examine in one listing.
pub(crate) const MAX_DIR_ENTRIES: usize = 16_384;
/// Distinct hosts in one listing.
pub(crate) const MAX_HOSTS: usize = 10_000;

/// The total a config goes past: the hosts after it would be missing, so
/// the listing fails with this reason instead of printing part of them.
#[derive(Debug, PartialEq)]
pub(crate) enum Limit {
    Files,
    Bytes,
    Includes,
    Entries,
    Hosts,
}

impl std::fmt::Display for Limit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Limit::Files => write!(
                f,
                "the SSH config and its Includes are more than {MAX_FILES} files"
            ),
            Limit::Bytes => write!(
                f,
                "the SSH config and its Includes hold more than {} MiB",
                MAX_TOTAL_BYTES / (1024 * 1024)
            ),
            Limit::Includes => write!(
                f,
                "the SSH config has more than {MAX_INCLUDE_PATTERNS} Include arguments"
            ),
            Limit::Entries => write!(
                f,
                "the SSH config's Include patterns look at more than {MAX_DIR_ENTRIES} directory entries"
            ),
            Limit::Hosts => write!(f, "the SSH config names more than {MAX_HOSTS} hosts"),
        }?;
        f.write_str("; not listing part of the hosts")
    }
}

#[derive(Default)]
struct Settings {
    hostname: Option<Vec<u8>>,
    user: Option<Vec<u8>>,
    port: Option<Vec<u8>>,
}

struct Walker<'a> {
    home: Option<&'a [u8]>,
    visited: HashSet<PathBuf>,
    bytes_left: u64,
    patterns_left: usize,
    entries_left: usize,
    order: Vec<Vec<u8>>,
    hosts: HashMap<Vec<u8>, Settings>,
}

/// The listing for `config`, with `home` for `~` and relative Includes.
pub(crate) fn list(config: &Path, home: Option<&Path>) -> Result<Vec<u8>, Limit> {
    let mut walker = Walker {
        home: home.map(|h| h.as_os_str().as_bytes()),
        visited: HashSet::new(),
        bytes_left: MAX_TOTAL_BYTES,
        patterns_left: MAX_INCLUDE_PATTERNS,
        entries_left: MAX_DIR_ENTRIES,
        order: Vec::new(),
        hosts: HashMap::new(),
    };
    walker.walk(config, 0, &[])?;
    Ok(walker.render())
}

/// The `ssh-hosts` subcommand: `$FOAMY_SSH_CONFIG`, else `$HOME/.ssh/config`.
pub(crate) fn main() -> ExitCode {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from);
    let config = match std::env::var_os("FOAMY_SSH_CONFIG").filter(|c| !c.is_empty()) {
        Some(config) => PathBuf::from(config),
        None => match &home {
            Some(home) => home.join(".ssh/config"),
            None => return ExitCode::SUCCESS,
        },
    };
    let output = match list(&config, home.as_deref()) {
        Ok(output) => output,
        Err(limit) => {
            eprintln!("foamy-menu-search: ssh-hosts: {limit}");
            return ExitCode::FAILURE;
        }
    };
    let mut stdout = io::stdout().lock();
    match stdout.write_all(&output).and_then(|()| stdout.flush()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("foamy-menu-search: ssh-hosts: {error}");
            ExitCode::FAILURE
        }
    }
}

impl Walker<'_> {
    fn walk(&mut self, path: &Path, depth: usize, inherited: &[Vec<u8>]) -> Result<(), Limit> {
        let Ok(real) = std::fs::canonicalize(path) else {
            return Ok(());
        };
        // Only a file not read yet can hold more hosts, so only it meets the
        // totals; one read before (an Include cycle) is not a new file.
        if self.visited.contains(&real) {
            return Ok(());
        }
        if self.visited.len() >= MAX_FILES {
            return Err(Limit::Files);
        }
        // With no bytes left, a read could only find the file over its limit.
        if self.bytes_left == 0 {
            return Err(Limit::Bytes);
        }
        // Remembered before the read, so a file that is refused (too large,
        // not a regular file) is not read again for every Include naming it.
        self.visited.insert(real.clone());
        let limit = MAX_FILE_BYTES.min(self.bytes_left);
        let data = match read_file_limited(&real, limit) {
            Ok(data) => data,
            Err(error) => {
                // InvalidData is the over-limit refusal, after limit + 1
                // bytes were read: they count toward MAX_TOTAL_BYTES too.
                if error.kind() == io::ErrorKind::InvalidData {
                    self.bytes_left = self.bytes_left.saturating_sub(limit + 1);
                    // Under MAX_FILE_BYTES the limit was the bytes left, so
                    // the file may be one to read: the total stopped it.
                    if limit < MAX_FILE_BYTES {
                        return Err(Limit::Bytes);
                    }
                }
                return Ok(());
            }
        };
        self.bytes_left -= data.len() as u64;
        // The names the current block applies to; an included file starts in
        // the including block, and that block resumes after the Include.
        let mut block = inherited.to_vec();
        for line in data.split(|&byte| byte == b'\n') {
            let Some((keyword, args)) = parse_line(line) else {
                continue;
            };
            match keyword.as_slice() {
                b"host" => {
                    block.clear();
                    for name in args {
                        if is_concrete(&name) {
                            self.add_host(&name)?;
                            block.push(name);
                        }
                    }
                }
                b"match" => block.clear(),
                b"hostname" | b"user" | b"port" => {
                    let value = args.into_iter().next().unwrap_or_default();
                    if value.is_empty() {
                        continue;
                    }
                    for name in &block {
                        let Some(settings) = self.hosts.get_mut(name) else {
                            continue;
                        };
                        let slot = match keyword.as_slice() {
                            b"hostname" => &mut settings.hostname,
                            b"user" => &mut settings.user,
                            _ => &mut settings.port,
                        };
                        slot.get_or_insert_with(|| value.clone());
                    }
                }
                b"include" if depth < MAX_DEPTH => {
                    for arg in args {
                        if self.patterns_left == 0 {
                            return Err(Limit::Includes);
                        }
                        self.patterns_left -= 1;
                        for file in self.expand(&arg)? {
                            self.walk(&file, depth + 1, &block)?;
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn add_host(&mut self, name: &[u8]) -> Result<(), Limit> {
        if self.hosts.contains_key(name) {
            return Ok(());
        }
        if self.hosts.len() >= MAX_HOSTS {
            return Err(Limit::Hosts);
        }
        self.order.push(name.to_vec());
        self.hosts.insert(name.to_vec(), Settings::default());
        Ok(())
    }

    /// The files an Include argument names, as ssh's glob(3) call finds them.
    fn expand(&mut self, arg: &[u8]) -> Result<Vec<PathBuf>, Limit> {
        let pattern = match arg {
            [] => return Ok(Vec::new()),
            [b'/', ..] => arg.to_vec(),
            [b'~'] => match self.home {
                Some(home) => home.to_vec(),
                None => return Ok(Vec::new()),
            },
            [b'~', b'/', rest @ ..] => match self.home {
                Some(home) => [home, b"/".as_slice(), rest].concat(),
                None => return Ok(Vec::new()),
            },
            // ~user: glob's GLOB_TILDE would ask the user database.
            [b'~', ..] => return Ok(Vec::new()),
            _ => match self.home {
                Some(home) => [home, b"/.ssh/".as_slice(), arg].concat(),
                None => return Ok(Vec::new()),
            },
        };
        self.glob(&pattern)
    }

    fn glob(&mut self, pattern: &[u8]) -> Result<Vec<PathBuf>, Limit> {
        let mut paths: Vec<Vec<u8>> = vec![if pattern.starts_with(b"/") {
            b"/".to_vec()
        } else {
            Vec::new()
        }];
        let components: Vec<&[u8]> = pattern
            .split(|&byte| byte == b'/')
            .filter(|component| !component.is_empty())
            .collect();
        if components.is_empty() {
            return Ok(Vec::new());
        }
        for component in components {
            let mut next = Vec::new();
            if has_magic(component) {
                let compiled: Vec<char> = String::from_utf8_lossy(component).chars().collect();
                for dir in &paths {
                    let listed = if dir.is_empty() {
                        b".".as_slice()
                    } else {
                        dir.as_slice()
                    };
                    let Ok(entries) = std::fs::read_dir(OsStr::from_bytes(listed)) else {
                        continue;
                    };
                    for entry in entries {
                        if self.entries_left == 0 {
                            return Err(Limit::Entries);
                        }
                        self.entries_left -= 1;
                        let Ok(entry) = entry else { continue };
                        let name = entry.file_name();
                        if name_matches(&compiled, name.as_bytes()) {
                            next.push(join(dir, name.as_bytes()));
                        }
                    }
                }
            } else {
                let literal = unescape(component);
                for dir in &paths {
                    next.push(join(dir, &literal));
                }
            }
            paths = next;
            if paths.is_empty() {
                return Ok(Vec::new());
            }
        }
        paths.retain(|path| std::fs::symlink_metadata(OsStr::from_bytes(path)).is_ok());
        paths.sort();
        paths.dedup();
        Ok(paths
            .into_iter()
            .map(|path| PathBuf::from(OsStr::from_bytes(&path)))
            .collect())
    }

    fn render(&self) -> Vec<u8> {
        let mut rows: Vec<(Vec<u8>, &[u8], Vec<u8>)> = self
            .order
            .iter()
            .map(|name| {
                let settings = &self.hosts[name];
                (
                    name.to_ascii_uppercase(),
                    name.as_slice(),
                    subtitle(name, settings),
                )
            })
            .collect();
        // As `LC_ALL=C sort -f -t TAB -k1,1`: case-folded, then by bytes.
        rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
        let mut output = Vec::new();
        for (_, name, subtitle) in rows {
            output.extend_from_slice(name);
            output.push(b'\t');
            output.extend_from_slice(name);
            output.push(b'\t');
            output.extend_from_slice(&subtitle);
            output.push(b'\n');
        }
        output
    }
}

/// `user@hostname:port`: the user with the HostName (or the host itself),
/// then a port other than 22. Empty when a value holds a control character
/// (a quoted tab would add columns to the line).
fn subtitle(name: &[u8], settings: &Settings) -> Vec<u8> {
    let target = settings.hostname.as_deref().unwrap_or_default();
    let mut text = target.to_vec();
    if let Some(user) = &settings.user {
        text = [
            user.as_slice(),
            b"@".as_slice(),
            if target.is_empty() { name } else { target },
        ]
        .concat();
    }
    if let Some(port) = settings.port.as_deref().filter(|port| *port != b"22") {
        let base = if text.is_empty() {
            name
        } else {
            text.as_slice()
        };
        text = [base, b":".as_slice(), port].concat();
    }
    if text.iter().any(|&byte| byte < b' ' || byte == 0x7f) {
        return Vec::new();
    }
    text
}

fn is_concrete(name: &[u8]) -> bool {
    !name.is_empty()
        && !name
            .iter()
            .any(|&byte| matches!(byte, b'*' | b'?' | b'!') || byte <= b' ' || byte == 0x7f)
}

fn join(dir: &[u8], name: &[u8]) -> Vec<u8> {
    match dir {
        [] => name.to_vec(),
        [.., b'/'] => [dir, name].concat(),
        _ => [dir, b"/", name].concat(),
    }
}

const WHITESPACE: &[u8] = b" \t\r\n";

fn skip_whitespace(text: &[u8]) -> &[u8] {
    let start = text
        .iter()
        .position(|byte| !WHITESPACE.contains(byte))
        .unwrap_or(text.len());
    &text[start..]
}

/// One token of ssh's `strdelim`: up to whitespace, `"` or `=`; then the
/// rest after the whitespace and at most one `=`. `None` for an unmatched
/// quote; a rest of `None` when the token ends the line.
fn strdelim(text: &[u8]) -> Option<(Vec<u8>, Option<&[u8]>)> {
    let Some(at) = text.iter().position(|byte| b" \t\r\n\"=".contains(byte)) else {
        return Some((text.to_vec(), None));
    };
    if text[at] == b'"' {
        let quoted = &text[at + 1..];
        let close = quoted.iter().position(|&byte| byte == b'"')?;
        let token = [&text[..at], &quoted[..close]].concat();
        return Some((token, Some(skip_whitespace(&quoted[close + 1..]))));
    }
    let mut rest = skip_whitespace(&text[at + 1..]);
    if text[at] != b'=' && rest.first() == Some(&b'=') {
        rest = skip_whitespace(&rest[1..]);
    }
    Some((text[..at].to_vec(), Some(rest)))
}

/// ssh's `argv_split(…, terminate_on_comment)`; `None` for an unterminated quote.
fn argv_split(text: &[u8]) -> Option<Vec<Vec<u8>>> {
    let mut args = Vec::new();
    let mut i = 0;
    while i < text.len() {
        if matches!(text[i], b' ' | b'\t') {
            i += 1;
            continue;
        }
        if text[i] == b'#' {
            break;
        }
        let mut arg = Vec::new();
        let mut quote = 0u8;
        while i < text.len() {
            let byte = text[i];
            if byte == b'\\' {
                match text.get(i + 1) {
                    Some(&next @ (b'\'' | b'"' | b'\\')) => {
                        arg.push(next);
                        i += 1;
                    }
                    Some(b' ') if quote == 0 => {
                        arg.push(b' ');
                        i += 1;
                    }
                    _ => arg.push(byte),
                }
            } else if quote == 0 && matches!(byte, b' ' | b'\t') {
                break;
            } else if quote == 0 && matches!(byte, b'"' | b'\'') {
                quote = byte;
            } else if quote != 0 && byte == quote {
                quote = 0;
            } else {
                arg.push(byte);
            }
            i += 1;
        }
        if quote != 0 {
            return None;
        }
        args.push(arg);
    }
    Some(args)
}

/// A config line as ssh's `process_config_line` splits it: the lowercased
/// keyword and its arguments. `None` for blank lines, comments and lines ssh
/// rejects.
fn parse_line(line: &[u8]) -> Option<(Vec<u8>, Vec<Vec<u8>>)> {
    let end = line
        .iter()
        .rposition(|byte| !b" \t\r\n\x0c".contains(byte))
        .map_or(0, |last| last + 1);
    let line = &line[..end];
    if line.is_empty() {
        return None;
    }
    let (mut keyword, mut rest) = strdelim(line)?;
    if keyword.is_empty() {
        (keyword, rest) = strdelim(rest?)?;
    }
    if keyword.is_empty() || keyword[0] == b'#' {
        return None;
    }
    keyword.make_ascii_lowercase();
    let rest = skip_whitespace(rest?);
    if rest.is_empty() {
        return None;
    }
    Some((keyword, argv_split(rest)?))
}

/// Whether a path component is a glob pattern (glibc's `__glob_pattern_p`).
fn has_magic(component: &[u8]) -> bool {
    let mut open = false;
    let mut i = 0;
    while i < component.len() {
        match component[i] {
            b'*' | b'?' => return true,
            b'\\' => i += 1,
            b'[' => open = true,
            b']' if open => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

fn unescape(component: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(component.len());
    let mut i = 0;
    while i < component.len() {
        if component[i] == b'\\' && i + 1 < component.len() {
            i += 1;
        }
        out.push(component[i]);
        i += 1;
    }
    out
}

/// fnmatch(3) with FNM_PERIOD for one directory entry.
fn name_matches(pattern: &[char], name: &[u8]) -> bool {
    let name: Vec<char> = String::from_utf8_lossy(name).chars().collect();
    if name.first() == Some(&'.') && !matches!(pattern, ['.', ..] | ['\\', '.', ..]) {
        return false;
    }
    fnmatch(pattern, &name)
}

fn fnmatch(pattern: &[char], name: &[char]) -> bool {
    let (mut p, mut n) = (0, 0);
    // After a `*`: where the pattern resumes, and the next name position to try.
    let mut star: Option<(usize, usize)> = None;
    while n < name.len() {
        let step = match pattern.get(p) {
            Some('*') => {
                star = Some((p + 1, n));
                p += 1;
                continue;
            }
            Some('?') => Some(1),
            Some('[') => match bracket(&pattern[p..], name[n]) {
                Some((true, length)) => Some(length),
                Some((false, _)) => None,
                None => (name[n] == '[').then_some(1),
            },
            Some('\\') if p + 1 < pattern.len() => (pattern[p + 1] == name[n]).then_some(2),
            Some(&c) => (c == name[n]).then_some(1),
            None => None,
        };
        match (step, star) {
            (Some(length), _) => {
                p += length;
                n += 1;
            }
            (None, Some((resume, tried))) => {
                p = resume;
                n = tried + 1;
                star = Some((resume, tried + 1));
            }
            (None, None) => return false,
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

/// A bracket expression at the start of `pattern` against `c`: whether it
/// matches and its length; `None` when it is not closed (a literal `[`).
fn bracket(pattern: &[char], c: char) -> Option<(bool, usize)> {
    let mut i = 1;
    let negate = matches!(pattern.get(1), Some('!' | '^'));
    if negate {
        i += 1;
    }
    let mut matched = false;
    let mut first = true;
    loop {
        let ch = *pattern.get(i)?;
        if ch == ']' && !first {
            return Some((matched != negate, i + 1));
        }
        first = false;
        if ch == '[' && pattern.get(i + 1) == Some(&':') {
            let names = &pattern[i + 2..];
            if let Some(end) = names.windows(2).position(|w| w == [':', ']']) {
                let class: String = names[..end].iter().collect();
                matched |= in_class(&class, c);
                i += 2 + end + 2;
                continue;
            }
        }
        let mut low = ch;
        if ch == '\\' && i + 1 < pattern.len() {
            i += 1;
            low = pattern[i];
        }
        i += 1;
        if pattern.get(i) == Some(&'-') && pattern.get(i + 1).is_some_and(|&next| next != ']') {
            let mut high = pattern[i + 1];
            i += 2;
            if high == '\\' && i < pattern.len() {
                high = pattern[i];
                i += 1;
            }
            matched |= low <= c && c <= high;
        } else {
            matched |= low == c;
        }
    }
}

fn in_class(class: &str, c: char) -> bool {
    match class {
        "alnum" => c.is_ascii_alphanumeric(),
        "alpha" => c.is_ascii_alphabetic(),
        "blank" => c == ' ' || c == '\t',
        "cntrl" => c.is_ascii_control(),
        "digit" => c.is_ascii_digit(),
        "graph" => c.is_ascii_graphic(),
        "lower" => c.is_ascii_lowercase(),
        "print" => c.is_ascii_graphic() || c == ' ',
        "punct" => c.is_ascii_punctuation(),
        "space" => c.is_ascii_whitespace() || c == '\x0b',
        "upper" => c.is_ascii_uppercase(),
        "xdigit" => c.is_ascii_hexdigit(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Home(PathBuf);

    impl Home {
        fn new() -> Home {
            static N: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "foamy-menu-ssh-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(path.join(".ssh")).unwrap();
            Home(path)
        }

        fn write(&self, name: &str, text: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path
        }

        fn listing(&self) -> Result<String, Limit> {
            list(&self.0.join(".ssh/config"), Some(&self.0))
                .map(|bytes| String::from_utf8(bytes).unwrap())
        }

        fn list(&self) -> String {
            self.listing().unwrap()
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn line(text: &str) -> Option<(String, Vec<String>)> {
        let (keyword, args) = parse_line(text.as_bytes())?;
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
        Some((text(keyword), args.into_iter().map(text).collect()))
    }

    fn kv(keyword: &str, args: &[&str]) -> Option<(String, Vec<String>)> {
        Some((keyword.into(), args.iter().map(|&a| a.into()).collect()))
    }

    #[test]
    fn lines_split_like_ssh() {
        assert_eq!(line("Host web db"), kv("host", &["web", "db"]));
        assert_eq!(line("  HostName=10.0.0.4"), kv("hostname", &["10.0.0.4"]));
        assert_eq!(line("User = deploy\r"), kv("user", &["deploy"]));
        assert_eq!(line("Port\t=\t2222 "), kv("port", &["2222"]));
        assert_eq!(line("HOSTNAME x # note"), kv("hostname", &["x"]));
        assert_eq!(line("Host a#b"), kv("host", &["a#b"]));
        assert_eq!(
            line(r#"User "a b" 'c d' e\ f g\"h"#),
            kv("user", &["a b", "c d", "e f", "g\"h"])
        );
        assert_eq!(line(r#""Host" web"#), kv("host", &["web"]));
        assert_eq!(line("Host=web"), kv("host", &["web"]));
        assert_eq!(line("=Host web"), kv("host", &["web"]));
        assert_eq!(line("Host ==web"), kv("host", &["=web"]));
        // Comments, blank lines and lines ssh rejects.
        for skipped in [
            "",
            "   ",
            "# Host x",
            "  #Host x",
            "User",
            "User   ",
            "Host \"web",
            "Host 'web",
            "\"Host web",
        ] {
            assert_eq!(line(skipped), None, "{skipped:?}");
        }
    }

    #[test]
    fn globs_match_like_fnmatch() {
        let m = |pattern: &str, name: &str| {
            name_matches(&pattern.chars().collect::<Vec<_>>(), name.as_bytes())
        };
        assert!(m("*.conf", "a.conf"));
        assert!(!m("*.conf", "a.conf~"));
        assert!(!m("*", ".hidden"), "a leading dot needs a literal dot");
        assert!(!m("?hidden", ".hidden"));
        assert!(!m("[.]hidden", ".hidden"));
        assert!(m(".*", ".hidden"));
        assert!(m("a*b*c", "aXbYbZc"));
        assert!(!m("a*b*c", "aXbYbZ"));
        assert!(m("[a-c]x", "bx"));
        assert!(!m("[!a-c]x", "bx"));
        assert!(m("[^a-c]x", "dx"));
        assert!(m("[]]", "]"));
        assert!(m("[[:digit:]]*", "1.conf"));
        assert!(!m("[[:digit:]]*", "a.conf"));
        assert!(m("[ab", "[ab"), "an unclosed bracket is literal");
        assert!(m(r"\*", "*"));
        assert!(!m(r"\*", "x"));
        assert!(m("??", "æø"), "? is one character");
        assert!(has_magic(b"a*") && has_magic(b"[ab]") && !has_magic(b"[ab") && !has_magic(br"\*"));
    }

    #[test]
    fn bounds_hold() {
        let home = Home::new();
        // Include depth: the main file is depth 0; depth 16 is the last read.
        home.write(".ssh/config", "Include d1\n");
        for depth in 1..=MAX_DEPTH + 1 {
            home.write(
                &format!(".ssh/d{depth}"),
                &format!("Host h{depth}\nInclude d{}\n", depth + 1),
            );
        }
        let listed = home.list();
        assert!(listed.contains(&format!("h{MAX_DEPTH}\t")), "{listed}");
        assert!(
            !listed.contains(&format!("h{}\t", MAX_DEPTH + 1)),
            "{listed}"
        );
        // A file over the size cap is skipped whole.
        let big = format!("Host big\n{}", "#".repeat(MAX_FILE_BYTES as usize));
        home.write(".ssh/config", "Include big\nHost small\n");
        home.write(".ssh/big", &big);
        assert_eq!(home.list(), "small\tsmall\t\n");
    }

    #[test]
    fn a_config_past_a_total_fails_the_listing() {
        // Files: the config and MAX_FILES - 1 Includes are all read. Past
        // the bound, a file read before or a missing one is no new file.
        let home = Home::new();
        for i in 0..MAX_FILES - 1 {
            home.write(&format!(".ssh/many/{i:04}"), &format!("Host many-{i:04}\n"));
        }
        home.write(
            ".ssh/config",
            "Include many/*\nInclude config\nInclude missing\n",
        );
        assert_eq!(home.list().lines().count(), MAX_FILES - 1);
        home.write(".ssh/config", "Include many/*\nInclude one-more\n");
        home.write(".ssh/one-more", "Host one-more\n");
        assert_eq!(home.listing(), Err(Limit::Files));
        // Bytes: files that hold exactly MAX_TOTAL_BYTES in all are read
        // whole (each padded with a hole of zeros). A byte more in the last
        // one, which is under MAX_FILE_BYTES, or one more file, is past it.
        let home = Home::new();
        let resize = |path: &Path, size: u64| {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_len(size)
                .unwrap()
        };
        let config = home.write(".ssh/config", "Include part?\n");
        let mut left = MAX_TOTAL_BYTES - fs::metadata(&config).unwrap().len();
        let mut parts = 0;
        let mut last = (PathBuf::new(), 0);
        while left > 0 {
            let size = left.min(MAX_FILE_BYTES);
            let part = home.write(&format!(".ssh/part{parts}"), &format!("Host part{parts}\n"));
            resize(&part, size);
            last = (part, size);
            left -= size;
            parts += 1;
        }
        assert_eq!(home.list().lines().count(), parts);
        assert!(last.1 < MAX_FILE_BYTES);
        resize(&last.0, last.1 + 1);
        assert_eq!(home.listing(), Err(Limit::Bytes));
        resize(&last.0, last.1);
        home.write(&format!(".ssh/part{parts}"), "Host late\n");
        assert_eq!(home.listing(), Err(Limit::Bytes));
        // Include arguments: one file naming the same missing file over and over.
        let home = Home::new();
        let many = "Include nothing-here\n".repeat(MAX_INCLUDE_PATTERNS);
        home.write(".ssh/config", &format!("{many}Host early\n"));
        assert_eq!(home.list(), "early\tearly\t\n");
        home.write(".ssh/config", &format!("{many}Include late\nHost early\n"));
        assert_eq!(home.listing(), Err(Limit::Includes));
        // Directory entries a glob looks at, whether they match or not.
        let home = Home::new();
        for i in 0..MAX_DIR_ENTRIES - 1 {
            home.write(&format!(".ssh/many/{i:05}"), "");
        }
        home.write(".ssh/many/x", "Host x\n");
        home.write(".ssh/config", "Include many/x*\n");
        assert_eq!(home.list(), "x\tx\t\n");
        home.write(".ssh/many/one-more", "");
        assert_eq!(home.listing(), Err(Limit::Entries));
        // Hosts: a name seen before is no new host.
        let home = Home::new();
        let hosts = (0..MAX_HOSTS)
            .map(|i| format!("h{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        home.write(".ssh/config", &format!("Host {hosts}\nHost h0\n"));
        assert_eq!(home.list().lines().count(), MAX_HOSTS);
        home.write(".ssh/config", &format!("Host {hosts} one-more\n"));
        assert_eq!(home.listing(), Err(Limit::Hosts));
    }

    #[test]
    fn a_file_over_the_size_cap_is_read_once_and_counted() {
        let home = Home::new();
        let big = "#".repeat(MAX_FILE_BYTES as usize + 1);
        home.write(".ssh/big", &big);
        // However many Includes name it, it is one of the MAX_FILES files:
        // with the config, it leaves room for MAX_FILES - 2 more.
        for i in 0..MAX_FILES - 2 {
            home.write(&format!(".ssh/many/{i:04}"), &format!("Host many-{i:04}\n"));
        }
        home.write(
            ".ssh/config",
            "Include big\nInclude big\nInclude big\nInclude many/*\n",
        );
        assert_eq!(home.list().lines().count(), MAX_FILES - 2);
        // The bytes read from rejected files count toward MAX_TOTAL_BYTES:
        // eight of them use it up, so the listing fails and the file after
        // them is not read.
        let mut config = String::new();
        for i in 0..MAX_TOTAL_BYTES / MAX_FILE_BYTES {
            home.write(&format!(".ssh/big{i}"), &big);
            config.push_str(&format!("Include big{i}\n"));
        }
        let late = home.write(".ssh/late", "Host late\n");
        let top = home.write(
            ".ssh/config",
            &format!("Host early\n{config}Include late\n"),
        );
        // Reading a file moves its access time on from the epoch (relatime
        // still updates an access time older than the modification time).
        let epoch = std::time::SystemTime::UNIX_EPOCH;
        for path in [&top, &late] {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_accessed(epoch))
                .unwrap();
        }
        assert_eq!(home.listing(), Err(Limit::Bytes));
        let read = |path: &Path| fs::metadata(path).unwrap().accessed().unwrap() != epoch;
        assert!(
            read(&top),
            "the temporary file system must record access times"
        );
        assert!(!read(&late), "no byte of the file after the budget is read");
    }

    #[test]
    fn a_control_character_in_a_value_leaves_the_subtitle_empty() {
        let home = Home::new();
        // Quotes keep a tab in the value; ssh still reads the first value.
        home.write(
            ".ssh/config",
            "Host tab\n HostName \"h\t/usr/share/pixmaps/x.png\"\n HostName later\nHost cr\n User \"a\rb\"\nHost port\n Port \"2222\x01\"\nHost space\n HostName \"a b\"\n",
        );
        assert_eq!(
            home.list(),
            "cr\tcr\t\nport\tport\t\nspace\tspace\ta b\ntab\ttab\t\n"
        );
    }

    #[test]
    fn subtitles_and_sorting() {
        let home = Home::new();
        home.write(
            ".ssh/config",
            "Host b-port\n Port 2222\nHost a-user\n User me\nHost C-std\n Port 22\n HostName c\nHost c-low\nHost web Web\n User u\n HostName h\n Port 22000\nHost _x *.pat !neg ?q\nMatch host x\n User nobody\nHost \"two words\"\n",
        );
        // Case-folded first (C-STD after C-LOW; _ after letters), then bytes.
        assert_eq!(
            home.list(),
            "a-user\ta-user\tme@a-user\nb-port\tb-port\tb-port:2222\nc-low\tc-low\t\nC-std\tC-std\tc\nWeb\tWeb\tu@h:22000\nweb\tweb\tu@h:22000\n_x\t_x\t\n"
        );
    }
}
