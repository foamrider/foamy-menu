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
// Ranker.js's alignment (its dynamic program). Alignments it can score in one
// pass give lower bounds on the best score: the query found whole in the
// text, and for longer queries the letters at their first places in order
// (`leftmost`) or at places that prefer adjacent letters and word starts
// (`seeking`). For longer queries, word starts, adjacent letter pairs and
// stretches of them give an upper bound (`ceiling`). Only a field that no
// bound decides runs the alignment, which fills at most one cell per query
// unit and text unit: no more cells than the matcher's own name DP over the
// same field.

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
// Below this many rows the alignment costs about as much as the bounds that
// take a pass over the text for each field.
const CEILING_ROWS: usize = 8;
// "No alignment ends here". A cell at or below VALID is stored as NONE, so
// sums of two of them stay far from overflow.
const NONE: i32 = i32::MIN / 4;
const VALID: i32 = NONE / 2;

// Greek final and other small sigma. Lowercasing a whole text gives "ς" for a
// word's last "Σ" ("ΟΣ" gives "ος"); the matcher lowercases each letter on its
// own ("οσ"). It is the only letter that lowercases by context, and Ranker.js
// folds it after every lowercasing, as this does.
const FINAL_SIGMA: u16 = 0x03C2;
const SIGMA: u16 = 0x03C3;

/// Appends `text` lowercased as UTF-16 units, the final sigma folded.
fn extend_lower(units: &mut Vec<u16>, text: &str) {
    let fold = |unit| if unit == FINAL_SIGMA { SIGMA } else { unit };
    units.extend(text.to_lowercase().encode_utf16().map(fold));
}

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
    // How many stretches have each number of columns, and how many of
    // those without word starts (`ceiling`).
    stretches: Vec<usize>,
    unstarted: Vec<usize>,
    // Each row's first place in order (`in_order`) and last place (`seeking`).
    places: Vec<usize>,
    latest: Vec<usize>,
    // The original text's UTF-16 units, for camelCase word starts.
    original: Vec<u16>,
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
        let mut units = Vec::new();
        extend_lower(&mut units, query);
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
            extend_lower(&mut self.units, text);
        }
        self.separated = self.units.iter().any(|&unit| separator(unit));
    }

    /// The gains of `text`, which `lower` has lowercased into `units`.
    fn gains(&mut self, text: &str) {
        // Word starts inside a word (camelCase) come from the original text by
        // the lowercased text's index, as in Ranker.js `normalize`, and the
        // rest from the lowercased text.
        self.original.clear();
        if text.is_ascii() {
            self.original.extend(text.bytes().map(u16::from));
        } else {
            self.original.extend(text.encode_utf16());
        }
        let (units, original) = (&self.units, &self.original);
        let gain = |at: usize| {
            if at == 0 {
                return 4;
            }
            let camel = original.get(at).is_some_and(|&unit| ascii_upper(unit))
                && ascii_lower_or_digit(original[at - 1]);
            if camel || separator(units[at - 1]) {
                3
            } else {
                2
            }
        };
        self.gain.clear();
        self.gain.extend((0..units.len()).map(gain));
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
        let long = plain && rows.len() >= CEILING_ROWS;
        if long && threshold(level, self.leftmost(), length) {
            return true;
        }
        // Found whole, every row places a cell, so nothing more is skipped.
        if self
            .whole(rows)
            .is_some_and(|score| threshold(level, score, length))
        {
            return true;
        }
        if long {
            if !threshold(level, self.ceiling(query, rows), length) {
                return false;
            }
            if self
                .seeking(rows)
                .is_some_and(|score| threshold(level, score, length))
            {
                return true;
            }
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
    /// It keeps each letter row's place (`leftmost`).
    fn in_order(&mut self, query: &Query, rows: &[u16], plain: bool) -> bool {
        self.places.clear();
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
                Some(at) => {
                    self.places.push(from + at);
                    from += at + 1;
                }
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

    /// A lower bound on the best score for rows without separators: the rows
    /// at their first places in order, the path `in_order` (Ranker.js's quick
    /// rejection) walks. Any rows without separators at places in order are
    /// an alignment (each place comes at or after its row's first place and
    /// leaves room for the rows after it), so the best one scores at least as
    /// much.
    fn leftmost(&self) -> i32 {
        let gaps = self.places.windows(2).filter(|at| at[0] + 1 != at[1]);
        let gains: i32 = self.places.iter().map(|&at| self.gain[at]).sum();
        gains - gaps.count() as i32
    }

    /// Two more lower bounds for rows without separators, for texts where
    /// the first places leave many gaps (lone letters before runs of them or
    /// before word starts); the better one. The rows at their last places
    /// (the latest that leave room for the rows after them). And a row that
    /// cannot follow the one before it without a gap takes the next place
    /// that is a word start or that the row after it can follow without a
    /// gap, if one comes by its last place, else its next place. The search
    /// for such places reads at most twice the text per field; past that,
    /// rows take their next places. `None` when the rows are not in order.
    fn seeking(&mut self, rows: &[u16]) -> Option<i32> {
        let (t, gain) = (&self.units, &self.gain);
        // Each row's last place: the rows placed from the end, each as late
        // as it goes.
        self.latest.clear();
        self.latest.resize(rows.len(), 0);
        let mut end = t.len();
        for (row, &unit) in rows.iter().enumerate().rev() {
            end = t[..end].iter().rposition(|&u| u == unit)?;
            self.latest[row] = end;
        }
        let gaps = self.latest.windows(2).filter(|at| at[0] + 1 != at[1]);
        let latest = self.latest.iter().map(|&at| gain[at]).sum::<i32>() - gaps.count() as i32;
        let mut allowance = 2 * t.len();
        let (mut score, mut next) = (0, 0);
        for (row, &unit) in rows.iter().enumerate() {
            // The row before sits at or before its last place, so `next` is
            // at or before this row's last place.
            let last = self.latest[row];
            let at = if row > 0 && t[next] == unit {
                next
            } else {
                let first = next + t[next..=last].iter().position(|&u| u == unit)?;
                let after = rows.get(row + 1);
                let good = |at: usize| {
                    t[at] == unit
                        && (gain[at] > 2 || after.is_some_and(|a| t.get(at + 1) == Some(a)))
                };
                let span = (last + 1 - first).min(allowance);
                let found = (first..first + span).find(|&at| good(at));
                allowance -= found.map_or(span, |at| at + 1 - first);
                found.unwrap_or(first)
            };
            score += gain[at] - i32::from(row > 0 && at != next);
            next = at + 1;
        }
        Some(score.max(latest))
    }

    /// An upper bound on the best score for rows without separators (the
    /// query's letters): two per letter, plus one for each word start a
    /// letter takes (two for the text's start), less one per gap. A letter
    /// follows the one before it without a gap only where the text holds
    /// that pair, each time at a later column. So the gaps are at least the
    /// query's pairs the text never has, and at least the letters less one
    /// less the columns where the text holds some query pair.
    ///
    /// And a run of letters without a gap lies inside one stretch of the
    /// text, where each adjacent pair is a query pair, and holds no more
    /// letters than the stretch has columns. So there are at least as many
    /// runs as the fewest stretches whose columns hold every letter. Counted
    /// by stretch, every stretch the letters touch but the first costs a gap
    /// and gives back at most its own word starts: a stretch with word starts
    /// gives at most one fewer than it has, and the others cost one each, as
    /// few as hold the letters the first ones cannot.
    fn ceiling(&mut self, query: &Query, rows: &[u16]) -> i32 {
        let (t, gain) = (&self.units, &self.gain);
        let takes = |unit: u16| unit >= 128 || query.ascii & (1u128 << unit) != 0;
        // A word start after the text's first column that a letter can take.
        let start = |at: usize| usize::from(gain[at] == 3 && takes(t[at]));
        // `pairs` marks the query pairs the text holds; a pair with a
        // non-ASCII unit counts as present.
        self.pairs.resize(128 * 128 / 64, 0);
        let (pairs, stretches, unstarted) =
            (&mut self.pairs, &mut self.stretches, &mut self.unstarted);
        for histogram in [&mut *stretches, &mut *unstarted] {
            histogram.clear();
            histogram.resize(t.len() + 1, 0);
        }
        let (mut taken, mut starts) = (0, 0);
        // The stretch so far: its columns and its word starts.
        let (mut columns, mut inner) = (1, 0);
        // The stretches with word starts: their columns, and their word
        // starts less one each.
        let (mut started, mut returned) = (0, 0);
        // The stretch that holds the text's first column, once closed.
        let mut opening = None;
        for at in 1..=t.len() {
            let joined = at < t.len()
                && match pair(&t[at - 1..=at]) {
                    Some(bit) if has(&query.pairs, bit) => {
                        pairs[bit / 64] |= 1 << (bit % 64);
                        true
                    }
                    Some(_) => false,
                    None => true,
                };
            if joined {
                taken += 1;
                columns += 1;
                inner += start(at);
                continue;
            }
            stretches[columns] += 1;
            opening.get_or_insert((columns, inner));
            if inner > 0 {
                started += columns;
                returned += inner - 1;
            } else {
                unstarted[columns] += 1;
            }
            starts += inner;
            if at < t.len() {
                (columns, inner) = (1, start(at));
            }
        }
        let m = rows.len();
        let missing = rows
            .windows(2)
            .filter_map(pair)
            .filter(|&bit| !has(pairs, bit))
            .count();
        // Only query pairs were set: clear their words, not the whole table.
        for bit in rows.windows(2).filter_map(pair) {
            pairs[bit / 64] = 0;
        }
        let first = if t[0] == rows[0] { 2 } else { 0 };
        let gaps = missing
            .max((m - 1).saturating_sub(taken))
            .max(fewest(stretches, m).saturating_sub(1));
        let by_pairs = 2 * m as i32 + first + starts.min(m) as i32 - gaps as i32;
        // Without the text's first column; then, when a letter can take it,
        // with it, which touches the stretch that holds it.
        let costs = fewest(unstarted, m.saturating_sub(started));
        let mut by_stretches = 2 * m as i32 + 1 + returned as i32 - costs as i32;
        if let Some((columns, 0)) = opening.filter(|_| first > 0) {
            unstarted[columns] -= 1;
            let costs = 1 + fewest(unstarted, m.saturating_sub(started + columns));
            unstarted[columns] += 1;
            by_stretches =
                by_stretches.max(2 * m as i32 + first + 1 + returned as i32 - costs as i32);
        } else {
            // The first column's stretch has word starts and is counted.
            by_stretches += first;
        }
        by_pairs.min(by_stretches)
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

/// The fewest stretches that hold `letters`, from `histogram` (how many
/// stretches have each number of columns), longest first.
fn fewest(histogram: &[usize], letters: usize) -> usize {
    let (mut held, mut used) = (0, 0);
    for (columns, &count) in histogram.iter().enumerate().skip(1).rev() {
        if held >= letters {
            break;
        }
        // Most lengths have no stretch: skip them before dividing.
        if count == 0 {
            continue;
        }
        let taken = (letters - held).div_ceil(columns).min(count);
        held += taken * columns;
        used += taken;
    }
    used
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
    fn the_final_sigma_folds_to_sigma() {
        // Lowercasing the whole text gives "ος"; the matcher gives "οσ".
        for (text, query) in [("ΟΣ", "ΟΣ"), ("ΟΣ", "οσ"), ("ΟΣ", "ος"), ("ΟΣΟΣ", "οσοσ")]
        {
            for level in LEVELS {
                assert!(
                    Gate::new(query).passes(text, level),
                    "{query:?} in {text:?}"
                );
            }
        }
        assert_eq!(letters("Οδυσσευς", "σς"), Some((4, 0)));
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
        let runs = "aaaaab".repeat(83) + "123";
        let run_then_spread = "a".repeat(200) + &"ba".repeat(100);
        let short_runs = "aabab".repeat(100);
        let lone_then_runs = "ab".repeat(200) + &"aaaaab".repeat(60);
        let runs_between = "ab".repeat(100) + &"aaaaab".repeat(60) + &"ba".repeat(100);
        let lone_then_starts = "ab".repeat(200) + &" a".repeat(300);
        // [text, query, [low, medium, high]], each decided by a bound alone.
        let cases: [(&str, &str, [bool; 3]); 18] = [
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
            // Runs of five "a": the first places leave one gap per run, few
            // enough for medium; no run holds more than five letters, so
            // there are too many gaps for high.
            (&runs, &"a".repeat(32), [true, true, false]),
            (&runs, &"a".repeat(64), [true, true, false]),
            (&runs, &"a".repeat(256), [true, true, false]),
            // One run of 200, then one "a" per gap: 56 gaps.
            (&run_then_spread, &"a".repeat(256), [true, true, false]),
            // Runs of two and one: 155 gaps or more.
            (&short_runs, &"a".repeat(256), [true, false, false]),
            // The runs of two alone: 19 gaps.
            (&short_runs, &"a".repeat(40), [true, true, false]),
            // Lone letters before or around the runs: the first places take
            // the lone ones, a gap each; places where "aa" starts do not.
            (&lone_then_runs, &"a".repeat(256), [true, true, false]),
            (&runs_between, &"a".repeat(256), [true, true, false]),
            // Word starts after lone letters: 3 * 256 - 255 > 2 * 256.
            (&lone_then_starts, &"a".repeat(256), [true; 3]),
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

    #[test]
    fn bounds_agree_with_the_alignment_on_seeded_random_fields() {
        // A fixed linear congruential generator: the same fields every run.
        struct Seeded(u64);
        impl Seeded {
            fn below(&mut self, bound: usize) -> usize {
                self.0 = self
                    .0
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                (self.0 >> 33) as usize % bound
            }
            fn pick(&mut self, from: &[&str], length: usize) -> String {
                (0..length).map(|_| from[self.below(from.len())]).collect()
            }
        }
        let mut seeded = Seeded(0x2545_f491);
        // Short fields: separators, camelCase, non-ASCII and both sigmas.
        let text_units = ["a", "a", "b", "A", "B", " ", "-", "é", "Σ", "ς", "x"];
        let query_units = ["a", "a", "b", " ", "-", "é", "σ"];
        let mut cases = Vec::new();
        for _ in 0..4000 {
            let length = seeded.below(40);
            let text = seeded.pick(&text_units, length);
            let length = 1 + seeded.below(14);
            let query = seeded.pick(&query_units, length);
            cases.push((text, query));
        }
        // Long fields of runs, lone letters and word starts, and long
        // queries, which the bounds decide or leave to the alignment.
        let chunks = ["a", "aa", "aaaaa", "b", " a", "ab", "Ab", "aab"];
        for _ in 0..120 {
            let length = 40 + seeded.below(120);
            let text = seeded.pick(&chunks, length);
            let length = 8 + seeded.below(110);
            let query = seeded.pick(&["a", "a", "a", "a", "a", "b"], length);
            cases.push((text, query));
        }
        for (text, query) in cases {
            for level in LEVELS {
                assert_eq!(
                    Gate::new(&query).passes(&text, level),
                    aligned(&text, &query, level),
                    "{query:?} in {text:?}"
                );
            }
        }
    }
}
