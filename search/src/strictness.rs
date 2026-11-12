// The search strictness levels' rule for letters found in order: the same
// score and thresholds as the built-in matcher (core/Ranker.js `fuzzyMatch`
// and `passesThreshold`), so the menu matches the same rows with or without
// the helper. Flea's own scores still rank the hits; this only decides
// whether a field matches at `medium` and `high`.
//
// Ranker.js works on UTF-16 code units and lowercases the whole text, so this
// does too: text and query are compared unit by unit, as the JavaScript does.

const SEPARATORS: [u16; 10] = [
    b'\t' as u16,
    b'\n' as u16,
    b' ' as u16,
    b'-' as u16,
    b'.' as u16,
    b'/' as u16,
    b'(' as u16,
    b')' as u16,
    b'[' as u16,
    b']' as u16,
];
const NONE: i64 = i64::MIN / 4;

fn separator(unit: u16) -> bool {
    SEPARATORS.contains(&unit)
}

fn ascii_lower_or_digit(unit: u16) -> bool {
    (u16::from(b'a')..=u16::from(b'z')).contains(&unit)
        || (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

fn ascii_upper(unit: u16) -> bool {
    (u16::from(b'A')..=u16::from(b'Z')).contains(&unit)
}

enum Match {
    Exact,
    // The alignment's score, and the query separators no text separator took.
    Letters { score: i64, skipped: usize },
}

#[derive(Clone, Copy)]
pub(crate) enum Level {
    Medium,
    High,
}

/// One query's gate; the buffers are reused for every field.
pub(crate) struct Gate {
    query: Vec<u16>,
    letters: usize,
    text: Vec<u16>,
    camel: Vec<bool>,
    previous: Vec<i64>,
    current: Vec<i64>,
}

impl Gate {
    pub(crate) fn new(query: &str) -> Self {
        let query: Vec<u16> = query.to_lowercase().encode_utf16().collect();
        let letters = query.iter().filter(|&&unit| !separator(unit)).count();
        Self {
            query,
            letters,
            text: Vec::new(),
            camel: Vec::new(),
            previous: Vec::new(),
            current: Vec::new(),
        }
    }

    /// Ranker.js `passesThreshold(fuzzyMatch(text, query), query.length, level)`.
    pub(crate) fn passes(&mut self, text: &str, level: Level) -> bool {
        let (score, skipped) = match self.score(text) {
            None => return false,
            Some(Match::Exact) => return true,
            Some(Match::Letters { score, skipped }) => (score, skipped),
        };
        let length = self.query.len() as i64 - skipped as i64;
        match level {
            // score >= 1.5 * (length - 2) + 4, doubled to stay in integers.
            Level::Medium => 2 * score >= 3 * length + 2,
            Level::High => score > 2 * length,
        }
    }

    /// Ranker.js `fuzzyMatch`; `None` is its "unmatched".
    fn score(&mut self, text: &str) -> Option<Match> {
        // Word starts inside a word (camelCase) come from the original text.
        self.camel.clear();
        let mut before = None;
        self.camel.extend(text.encode_utf16().map(|unit| {
            let start = before.is_some_and(ascii_lower_or_digit) && ascii_upper(unit);
            before = Some(unit);
            start
        }));
        // Most fields are ASCII: lowercase them without a temporary string.
        self.text.clear();
        if text.is_ascii() {
            let lower = text
                .bytes()
                .map(|byte| u16::from(byte.to_ascii_lowercase()));
            self.text.extend(lower);
        } else {
            self.text.extend(text.to_lowercase().encode_utf16());
        }
        let (t, q) = (&self.text, &self.query);
        if q.is_empty() {
            return None;
        }
        if t == q {
            return Some(Match::Exact);
        }
        let n = t.len();
        let letters = self.letters;
        if letters > n {
            return None;
        }

        // Ranker.js's quick rejection: the letters in order, each query
        // separator jumping past the next separator in the text.
        if letters > 2 {
            let mut from = 0;
            for &unit in q {
                if separator(unit) {
                    if let Some(at) = (from..n).find(|&at| separator(t[at])) {
                        from = at + 1;
                    }
                    continue;
                }
                from = (from..n).find(|&at| t[at] == unit)? + 1;
            }
        }

        let word_start = |at: usize| {
            self.camel.get(at).copied().unwrap_or(false) || (at > 0 && separator(t[at - 1]))
        };
        self.previous.resize(n, NONE);
        self.current.resize(n, NONE);
        // `matched` counts the query units placed so far (Ranker.js `p`) and
        // `floor` is the first column of the last placed row (`d`). A row only
        // writes, and the next row only reads, columns start..end of it, so
        // only that range is reset.
        let mut matched = 0usize;
        let mut floor: isize = -1;
        let mut skipped = 0usize;
        let mut placed = 0..0;
        for &unit in q {
            let unit_separator = separator(unit);
            let mut first = None;
            // Leave room for the query letters still to place.
            let remaining = letters as isize - 1 - matched as isize;
            let end = (n as isize).min(n as isize - remaining).max(0) as usize;
            // The best earlier cell more than one column back: a gap costs 1,
            // whatever its length, so a running maximum replaces Ranker.js's
            // inner loop over every earlier column.
            let mut gapped = NONE;
            let start = (floor + 1) as usize;
            if start < end {
                self.current[start..end].fill(NONE);
            }
            for (at, &here) in t.iter().enumerate().take(end).skip(start) {
                if matched > 0 && at > start {
                    gapped = gapped.max(self.previous[at - 2]);
                }
                let separator_match = unit_separator && separator(here);
                if here != unit && !separator_match {
                    continue;
                }
                let gain = if separator_match {
                    1
                } else if matched == 0 && at == 0 {
                    4
                } else if word_start(at) {
                    3
                } else {
                    2
                };
                let cell = if matched == 0 {
                    gain
                } else {
                    let adjacent = self.previous[at - 1];
                    let best = adjacent.max(if gapped == NONE { NONE } else { gapped - 1 });
                    if best == NONE {
                        continue;
                    }
                    best + gain
                };
                self.current[at] = cell;
                first.get_or_insert(at);
            }
            if let Some(first) = first {
                floor = first as isize;
                matched += 1;
                placed = start..end;
                std::mem::swap(&mut self.previous, &mut self.current);
            } else if unit_separator {
                skipped += 1;
            } else {
                return None;
            }
        }
        if matched == 0 {
            return None;
        }
        let best = self.previous[placed].iter().copied().max().unwrap_or(NONE);
        (best != NONE).then_some(Match::Letters {
            score: best,
            skipped,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn letters(text: &str, query: &str) -> Option<(i64, usize)> {
        match Gate::new(query).score(text)? {
            Match::Exact => None,
            Match::Letters { score, skipped } => Some((score, skipped)),
        }
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
        assert!(matches!(
            Gate::new("firefox").score("Firefox"),
            Some(Match::Exact)
        ));
        for (text, query) in [("abc", "cba"), ("Files", "fir"), ("ab", "abc"), ("x", "")] {
            assert!(
                Gate::new(query).score(text).is_none(),
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
        assert!(gate.passes("Firefox", Level::High)); // 8
        // A skipped query separator does not count toward the length.
        let mut gate = Gate::new("fire ");
        assert!(gate.passes("Firefox", Level::High)); // 10 > 8
        assert!(Gate::new("firefox").passes("FIREFOX", Level::High));
        assert!(!Gate::new("zz").passes("Firefox", Level::Medium));
    }

    #[test]
    fn spread_letters_pass_only_below_medium() {
        // l…i…v…i…n over four words of the SSH scope's Norwegian subtitle.
        let text = "Koble til en vert i ~/.ssh/config";
        assert_eq!(letters(text, "livin"), Some((8, 0)));
        let mut gate = Gate::new("livin");
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
}
