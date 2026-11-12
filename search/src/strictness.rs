// The search strictness levels' rule for letters found in order: the same
// score and thresholds as the built-in matcher (core/Ranker.js `fuzzyMatch`
// and `passesThreshold`), so the menu matches the same rows with or without
// the helper. Flea's own scores still rank the hits; this only decides
// whether a field matches.
//
// Ranker.js works on UTF-16 code units and lowercases the whole text, so this
// does too: text and query are compared unit by unit, as the JavaScript does.
//
// Cost. `passes` first tries bounds that decide most fields without
// Ranker.js's alignment (its dynamic program): the query found whole in the
// text gives a lower bound on the best score, and for longer queries word
// starts and adjacent letter pairs give an upper bound. Only a field that
// neither bound decides
// runs the alignment, which fills at most one cell per query unit and text
// unit: no more cells than the matcher's own name DP over the same field.

// Ranker.js SEPARATORS ("\t\n -./()[]"), as bits of the ASCII units.
const SEPARATORS: u128 = 1 << b'\t'
    | 1 << b'\n'
    | 1 << b' '
    | 1 << b'-'
    | 1 << b'.'
    | 1 << b'/'
    | 1 << b'('
    | 1 << b')'
    | 1 << b'['
    | 1 << b']';
// Below this many rows the alignment costs about as much as the upper bound.
const CEILING_ROWS: usize = 8;
// "No alignment ends here". A cell at or below VALID is stored as NONE, so
// sums of two of them stay far from overflow.
const NONE: i32 = i32::MIN / 4;
const VALID: i32 = NONE / 2;

fn separator(unit: u16) -> bool {
    unit < 128 && SEPARATORS & (1 << unit) != 0
}

fn ascii_lower_or_digit(unit: u16) -> bool {
    (u16::from(b'a')..=u16::from(b'z')).contains(&unit)
        || (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

fn ascii_upper(unit: u16) -> bool {
    (u16::from(b'A')..=u16::from(b'Z')).contains(&unit)
}

/// The query without Ranker.js's separators, or `None` when it has none.
pub(crate) fn without_separators(query: &str) -> Option<String> {
    let text_separator = |c: char| c.is_ascii() && separator(c as u16);
    query
        .contains(text_separator)
        .then(|| query.chars().filter(|&c| !text_separator(c)).collect())
}

#[derive(Clone, Copy)]
pub(crate) enum Level {
    Low,
    Medium,
    High,
}

/// Ranker.js `passesThreshold` for a letter match of `score` over `length`
/// (the query length less its skipped separators).
fn threshold(level: Level, score: i32, length: usize) -> bool {
    let (score, length) = (i64::from(score), length as i64);
    match level {
        Level::Low => true,
        // score >= 1.5 * (length - 2) + 4, doubled to stay in integers.
        Level::Medium => 2 * score >= 3 * length + 2,
        Level::High => score > 2 * length,
    }
}

struct Query {
    units: Vec<u16>,
    // The units without the separators, and how many separators there were.
    letters: Vec<u16>,
    separators: usize,
    // The ASCII letters as bits; a text unit outside the set takes no row.
    ascii: u128,
    // The adjacent ASCII letter pairs, 128 x 128 bits (`pair`).
    pairs: Vec<u64>,
}

/// An adjacent pair's bit in a 128 x 128 table; `None` for a non-ASCII unit.
fn pair(units: &[u16]) -> Option<usize> {
    match *units {
        [a @ 0..128, b @ 0..128] => Some(usize::from(a) * 128 + usize::from(b)),
        _ => None,
    }
}

fn has(table: &[u64], bit: usize) -> bool {
    table[bit / 64] & (1 << (bit % 64)) != 0
}

/// One field's buffers, reused for every field.
#[derive(Default)]
struct Text {
    units: Vec<u16>,
    // Whether `units` holds a separator.
    separated: bool,
    // A letter's gain at each column: 4 at the first, 3 at a word start
    // (camelCase or after a separator), else 2.
    gain: Vec<i32>,
    previous: Vec<i32>,
    current: Vec<i32>,
    // The adjacent ASCII unit pairs, 128 x 128 bits.
    pairs: Vec<u64>,
    #[cfg(test)]
    cells: usize,
}

/// One query's gate.
pub(crate) struct Gate {
    query: Query,
    text: Text,
}

impl Gate {
    pub(crate) fn new(query: &str) -> Self {
        let units: Vec<u16> = query.to_lowercase().encode_utf16().collect();
        let letters: Vec<u16> = units.iter().copied().filter(|&u| !separator(u)).collect();
        let ascii = letters
            .iter()
            .filter(|&&unit| unit < 128)
            .fold(0, |set, &unit| set | 1u128 << unit);
        let mut pairs = vec![0; 128 * 128 / 64];
        for bit in letters.windows(2).filter_map(pair) {
            pairs[bit / 64] |= 1 << (bit % 64);
        }
        Self {
            query: Query {
                separators: units.len() - letters.len(),
                units,
                letters,
                ascii,
                pairs,
            },
            text: Text::default(),
        }
    }

    /// The alignment cells filled so far, for the cost tests.
    #[cfg(test)]
    pub(crate) fn cells(&self) -> usize {
        self.text.cells
    }

    /// Ranker.js `passesThreshold(fuzzyMatch(text, query), query.length, level)`.
    pub(crate) fn passes(&mut self, text: &str, level: Level) -> bool {
        let (query, field) = (&self.query, &mut self.text);
        field.lower(text);
        if query.units.is_empty() {
            return false;
        }
        if field.units == query.units {
            return true;
        }
        if query.letters.len() > field.units.len() {
            return false;
        }
        // A query separator takes a text separator or nothing. Over a text
        // without separators every separator row is skipped, exactly as if
        // the query had none, so the rows are the letters alone.
        if field.separated {
            field.decide(query, text, &query.units, 0, level)
        } else {
            field.decide(query, text, &query.letters, query.separators, level)
        }
    }
}

impl Text {
    fn lower(&mut self, text: &str) {
        // Most fields are ASCII: lowercase them without a temporary string.
        self.units.clear();
        if text.is_ascii() {
            let lower = text
                .bytes()
                .map(|byte| u16::from(byte.to_ascii_lowercase()));
            self.units.extend(lower);
        } else {
            self.units.extend(text.to_lowercase().encode_utf16());
        }
        self.separated = self.units.iter().any(|&unit| separator(unit));
    }

    /// The gains of `text`, which `lower` has lowercased into `units`.
    fn gains(&mut self, text: &str) {
        // Word starts inside a word (camelCase) come from the original text by
        // the lowercased text's index, as in Ranker.js `normalize`, and the
        // rest from the lowercased text.
        let mut before = None;
        let mut camel = text.encode_utf16().map(|unit| {
            let start = before.is_some_and(ascii_lower_or_digit) && ascii_upper(unit);
            before = Some(unit);
            start
        });
        self.gain.clear();
        let mut previous = None;
        for &unit in &self.units {
            let start = camel.next().unwrap_or(false) || previous.is_some_and(separator);
            self.gain.push(match (previous, start) {
                (None, _) => 4,
                (_, true) => 3,
                _ => 2,
            });
            previous = Some(unit);
        }
    }

    fn decide(
        &mut self,
        query: &Query,
        text: &str,
        rows: &[u16],
        preskipped: usize,
        level: Level,
    ) -> bool {
        let plain = !rows.iter().any(|&unit| separator(unit));
        if rows.is_empty() || !self.in_order(query, rows, plain) {
            return false;
        }
        // Letters in order always align, so they match below medium.
        if plain && matches!(level, Level::Low) {
            return true;
        }
        self.gains(text);
        let length = query.units.len() - preskipped;
        // Found whole, every row places a cell, so nothing more is skipped.
        if self
            .whole(rows)
            .is_some_and(|score| threshold(level, score, length))
        {
            return true;
        }
        if plain
            && rows.len() >= CEILING_ROWS
            && !threshold(level, self.ceiling(query, rows), length)
        {
            return false;
        }
        match self.align(query, rows) {
            Some((score, skipped)) => threshold(level, score, length - skipped),
            None => false,
        }
    }

    /// Ranker.js's quick rejection, which it runs for more than two letters:
    /// the letters in order, each query separator jumping past the next text
    /// separator. Without separators it is "the letters in order", which the
    /// alignment needs anyway, so it then runs for every length.
    fn in_order(&self, query: &Query, rows: &[u16], plain: bool) -> bool {
        if !plain && query.letters.len() <= 2 {
            return true;
        }
        let t = &self.units;
        let mut from = 0;
        for &unit in rows {
            if separator(unit) {
                if let Some(at) = t[from..].iter().position(|&u| separator(u)) {
                    from += at + 1;
                }
                continue;
            }
            match t[from..].iter().position(|&u| u == unit) {
                Some(at) => from += at + 1,
                None => return false,
            }
        }
        true
    }

    /// A lower bound on the best score: the rows found whole in the text, at
    /// the first place and at the first word start after it. The alignment
    /// takes that path or a better one.
    fn whole(&self, rows: &[u16]) -> Option<i32> {
        let (t, gain, m) = (&self.units, &self.gain, rows.len());
        let last = t.len().checked_sub(m)?;
        let found = |at: usize| t[at] == rows[0] && t[at..at + m] == *rows;
        let score = |at: usize| {
            rows.iter()
                .zip(&gain[at..])
                .map(|(&unit, &gain)| if separator(unit) { 1 } else { gain })
                .sum::<i32>()
        };
        let first = (0..=last).find(|&at| found(at))?;
        // Past a first place inside a word, only word starts can score more.
        let later = (gain[first] == 2)
            .then(|| (first + 1..=last).find(|&at| gain[at] > 2 && found(at)))
            .flatten();
        Some(score(first).max(later.map_or(0, score)))
    }

    /// An upper bound on the best score for rows without separators (the
    /// query's letters): two per letter, plus one for each word start a
    /// letter could take (two for the text's start), less one per gap. A
    /// letter follows the one before it without a gap only where the text
    /// holds that pair, each time at a later column, so the gaps are at least
    /// the query's pairs the text never has, and at least the letters less
    /// one less the columns where the text holds some query pair.
    fn ceiling(&mut self, query: &Query, rows: &[u16]) -> i32 {
        let t = &self.units;
        let takes = |unit: u16| unit >= 128 || query.ascii & (1u128 << unit) != 0;
        let starts = self.gain[1..]
            .iter()
            .zip(&t[1..])
            .filter(|&(&gain, &unit)| gain == 3 && takes(unit))
            .count()
            .min(rows.len());
        let bonus = if t[0] == rows[0] { 2 } else { 0 } + starts as i32;
        // A pair with a non-ASCII unit counts as present.
        self.pairs.resize(128 * 128 / 64, 0);
        let mut taken = 0;
        for units in t.windows(2) {
            match pair(units) {
                Some(bit) => {
                    self.pairs[bit / 64] |= 1 << (bit % 64);
                    taken += usize::from(has(&query.pairs, bit));
                }
                None => taken += 1,
            }
        }
        let missing = rows
            .windows(2)
            .filter_map(pair)
            .filter(|&bit| !has(&self.pairs, bit))
            .count();
        // Clear only the words this text set: cheaper than the whole table.
        for bit in t.windows(2).filter_map(pair) {
            self.pairs[bit / 64] = 0;
        }
        let gaps = missing.max((rows.len() - 1).saturating_sub(taken));
        2 * rows.len() as i32 + bonus - gaps as i32
    }

    /// Ranker.js `fuzzyMatch`'s alignment: the best score and the query
    /// separators no text separator took, or `None` for "unmatched".
    fn align(&mut self, query: &Query, rows: &[u16]) -> Option<(i32, usize)> {
        let n = self.units.len();
        let letters = query.letters.len() as isize;
        self.previous.resize(n, NONE);
        self.current.resize(n, NONE);
        // `matched` counts the rows placed so far (Ranker.js `p`) and `floor`
        // is the first column of the last placed row (`d`). A row only
        // writes, and the next row only reads, columns start..end of it.
        let mut matched = 0isize;
        let mut floor: isize = -1;
        let mut skipped = 0usize;
        let mut placed = 0..0;
        for &unit in rows {
            // Leave room for the query letters still to place.
            let remaining = (letters - 1 - matched).max(0);
            let end = (n as isize - remaining).max(0) as usize;
            let start = (floor + 1) as usize;
            let first = if start < end {
                #[cfg(test)]
                {
                    self.cells += end - start;
                }
                let (t, gain, first_row) = (&self.units, &self.gain, matched == 0);
                if separator(unit) {
                    let cell = |at: usize| if separator(t[at]) { 1 } else { NONE };
                    row(
                        &self.previous,
                        &mut self.current,
                        start..end,
                        first_row,
                        cell,
                    )
                } else {
                    let cell = |at: usize| if t[at] == unit { gain[at] } else { NONE };
                    row(
                        &self.previous,
                        &mut self.current,
                        start..end,
                        first_row,
                        cell,
                    )
                }
            } else {
                None
            };
            if let Some(first) = first {
                floor = first as isize;
                matched += 1;
                placed = start..end;
                std::mem::swap(&mut self.previous, &mut self.current);
            } else if separator(unit) {
                skipped += 1;
            } else {
                return None;
            }
        }
        let best = self.previous[placed].iter().copied().max()?;
        (best > VALID).then_some((best, skipped))
    }
}

/// One alignment row over `columns`: a cell is its gain plus the best cell
/// of the previous row one column back, or more than one column back less one
/// (a gap costs 1 whatever its length, so a running maximum replaces
/// Ranker.js's loop over every earlier column). Returns the first column
/// with a cell.
#[inline(always)]
fn row(
    previous: &[i32],
    current: &mut [i32],
    columns: std::ops::Range<usize>,
    first_row: bool,
    cell: impl Fn(usize) -> i32,
) -> Option<usize> {
    let start = columns.start;
    let current = &mut current[columns.clone()];
    if first_row {
        for (at, slot) in columns.zip(current.iter_mut()) {
            *slot = cell(at);
        }
    } else {
        // A placed row precedes this one, so start > 0.
        let adjacent = &previous[start - 1..columns.end - 1];
        let (mut gapped, mut back) = (NONE, NONE);
        for ((at, slot), &before) in columns.zip(current.iter_mut()).zip(adjacent) {
            gapped = gapped.max(back);
            back = before;
            let value = before.max(gapped - 1) + cell(at);
            *slot = if value > VALID { value } else { NONE };
        }
    }
    current
        .iter()
        .position(|&value| value > VALID)
        .map(|at| start + at)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEVELS: [Level; 3] = [Level::Low, Level::Medium, Level::High];

    // The alignment alone over the whole query, as Ranker.js runs it.
    fn letters(text: &str, query: &str) -> Option<(i32, usize)> {
        let mut gate = Gate::new(query);
        {
            gate.text.lower(text);
            gate.text.gains(text);
        }
        gate.text.align(&gate.query, &gate.query.units)
    }

    // `passes` without its bounds or the separator-free shortcut.
    fn aligned(text: &str, query: &str, level: Level) -> bool {
        let mut gate = Gate::new(query);
        {
            gate.text.lower(text);
            gate.text.gains(text);
        }
        if gate.text.units == gate.query.units {
            return true;
        }
        let length = gate.query.units.len();
        gate.text.in_order(&gate.query, &gate.query.units, false)
            && gate
                .text
                .align(&gate.query, &gate.query.units)
                .is_some_and(|(score, skipped)| threshold(level, score, length - skipped))
    }

    #[test]
    fn scores_match_the_ranker_golden_values() {
        // The same cases and numbers as tests/ranker.test.js.
        for (text, query, score) in [
            ("Firefox", "fir", 8),
            ("Firefox", "fx", 5),
            ("LibreOffice Writer", "lw", 6),
            ("LibreOffice Writer", "lo", 6),
            ("Visual Studio Code", "vsc", 8),
            ("foo-bar", "f-b", 7),
            ("Font Viewer", "fir", 6),
            ("LibreOffice Writer", "fir", 5),
        ] {
            assert_eq!(
                letters(text, query),
                Some((score, 0)),
                "{query:?} in {text:?}"
            );
        }
        assert_eq!(letters("Firefox", "fire "), Some((10, 1)));
        assert!(Gate::new("firefox").passes("Firefox", Level::High));
        for (text, query) in [("abc", "cba"), ("Files", "fir"), ("ab", "abc"), ("x", "")] {
            assert!(
                !Gate::new(query).passes(text, Level::Low),
                "{query:?} in {text:?}"
            );
        }
    }

    #[test]
    fn thresholds_sit_at_the_ranker_boundaries() {
        // "fir" (length 3): medium needs 5.5, high more than 6.
        let mut gate = Gate::new("fir");
        assert!(gate.passes("Font Viewer", Level::Medium)); // 6
        assert!(!gate.passes("Font Viewer", Level::High));
        assert!(!gate.passes("LibreOffice Writer", Level::Medium)); // 5
        assert!(gate.passes("LibreOffice Writer", Level::Low));
        assert!(gate.passes("Firefox", Level::High)); // 8
        // A skipped query separator does not count toward the length.
        let mut gate = Gate::new("fire ");
        assert!(gate.passes("Firefox", Level::High)); // 10 > 8
        assert!(Gate::new("firefox").passes("FIREFOX", Level::High));
        assert!(!Gate::new("zz").passes("Firefox", Level::Low));
    }

    #[test]
    fn spread_letters_pass_only_below_medium() {
        // l…i…v…i…n over four words of the SSH scope's Norwegian subtitle.
        let text = "Koble til en vert i ~/.ssh/config";
        assert_eq!(letters(text, "livin"), Some((8, 0)));
        let mut gate = Gate::new("livin");
        assert!(gate.passes(text, Level::Low));
        assert!(!gate.passes(text, Level::Medium));
        assert!(!gate.passes(text, Level::High));
        assert!(gate.passes("Living Room", Level::High));
    }

    #[test]
    fn camel_case_and_separators_start_words() {
        assert_eq!(letters("LibreOffice", "o"), Some((3, 0)));
        assert_eq!(letters("Libreoffice", "o"), Some((2, 0)));
        // Ranker.js's separators: "_" is not one, "(" is.
        assert_eq!(letters("my_app", "a"), Some((2, 0)));
        assert_eq!(letters("my(app", "a"), Some((3, 0)));
        // A query separator takes any text separator.
        assert_eq!(
            letters("gnome-terminal", "gnome t"),
            Some((4 + 2 * 4 + 1 + 3, 0))
        );
    }

    #[test]
    fn query_separators_take_any_text_separator_or_none() {
        // A text without separators skips every query separator.
        assert_eq!(letters("Tastaturoppsett", "tast opp"), Some((15, 1)));
        assert!(Gate::new("tast opp").passes("Tastaturoppsett", Level::High)); // 15 > 2 * 7
        assert!(Gate::new("gnome-t").passes("GNOME Terminal", Level::High)); // 16 > 14
        assert!(Gate::new("v.s").passes("Visual Studio Code", Level::High)); // 7 > 6
        // Separators alone take a text separator, below medium only.
        let mut gate = Gate::new("-");
        assert!(gate.passes("a b", Level::Low));
        assert!(!gate.passes("a b", Level::Medium));
        assert!(!gate.passes("ab", Level::Low));
    }

    #[test]
    fn bounds_decide_without_the_alignment_and_agree_with_it() {
        let spread = "ab".repeat(300);
        let late = "b".to_owned() + &"a".repeat(450);
        let long = "a".repeat(450);
        let spaced = "a".to_owned() + &" a".repeat(127);
        let paired = "a".to_owned() + &"ab".repeat(300) + "aa";
        // [text, query, [low, medium, high]], each decided by a bound alone.
        let cases: [(&str, &str, [bool; 3]); 9] = [
            // A prefix or a word start passes every level.
            ("Firefox", "fire", [true; 3]),
            ("Mozilla Firefox", "fire", [true; 3]),
            (&long, &"a".repeat(256), [true; 3]),
            // Whole inside a word: medium, and high only with word starts.
            ("bfirefoxes", "firefoxe", [true, true, false]),
            (&late, &"a".repeat(256), [true, true, false]),
            // No adjacent "aa": a gap after every letter (4 + 255 = 259).
            (&spread, &"a".repeat(256), [true, false, false]),
            // "aa" at two columns only: 253 gaps or more.
            (&paired, &"a".repeat(256), [true, false, false]),
            (&paired, &"a".repeat(40), [true, false, false]),
            // The separators skipped, the letters a prefix.
            (&long, &spaced, [true; 3]),
        ];
        for (text, query, expected) in cases {
            for (level, expected) in LEVELS.into_iter().zip(expected) {
                let mut gate = Gate::new(query);
                assert_eq!(gate.passes(text, level), expected, "{query:?} in {text:?}");
                assert_eq!(
                    gate.text.cells, 0,
                    "{query:?} in {text:?} ran the alignment"
                );
                assert_eq!(
                    aligned(text, query, level),
                    expected,
                    "{query:?} in {text:?} aligned"
                );
            }
        }
    }

    #[test]
    fn bounds_and_shortcuts_agree_with_the_alignment() {
        // Word starts, forced gaps, pairs across separators, camelCase,
        // non-ASCII units, short queries and separator queries.
        let texts = [
            "abXab",
            "aXbXc",
            "a b c",
            "xaybzc",
            "foo bar",
            "aa",
            "Ærlig talt",
            "my_app",
            "LibreOffice Writer",
            "GNOME Terminal",
            "Tastaturoppsett",
            "a-b-c",
            "ab",
            "İstanbul",
            "aabaab",
            "aaXaaXaa",
            "aabaabaabaabaab",
            "abababababababab",
            "a ab aab aaab aaaab",
            "xFirefoxFirefox",
        ];
        let queries = [
            "abab",
            "abc",
            "fb",
            "aa",
            "a",
            "ab",
            "ætal",
            "app",
            "lw",
            "wri",
            "gnome t",
            "gnome-t",
            "tast opp",
            "a c",
            "-",
            "a-",
            "b c",
            "ist",
            "i\u{307}s",
            "o",
            "aaaa",
            "aaaaa",
            "aaaaaaaa",
            "aabaabaa",
            "abababab",
            "aaaaaaaaab",
            "firefoxf",
            "a a a a a a a a",
        ];
        for text in texts {
            for query in queries {
                for level in LEVELS {
                    assert_eq!(
                        Gate::new(query).passes(text, level),
                        aligned(text, query, level),
                        "{query:?} in {text:?}"
                    );
                }
            }
        }
    }
}
