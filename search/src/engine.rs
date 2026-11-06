use crate::backend::searchbits;
use crate::backend::searchmatch::{HIT_SPAN, Letter, Matcher, NAME, SHADOW_TYPO, State};
use crate::backend::searchtypo::Scratch;
use serde::{Deserialize, Deserializer, Serialize};

pub(crate) const MAX_ENTRIES: usize = 20_000;
pub(crate) const MAX_FIELD_BYTES: usize = 16_384;
pub(crate) const MAX_FIELDS: usize = 1_024;
pub(crate) const MAX_QUERY_CHARS: usize = 256;

// Input: {"title":"Firefox","subtitle":"Browser","alternateTitles":[],"keywords":[],"bundleId":"org.mozilla.firefox"}.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    title: String,
    #[serde(default, deserialize_with = "present_string")]
    subtitle: Option<String>,
    #[serde(default)]
    alternate_titles: Vec<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default, deserialize_with = "present_string")]
    bundle_id: Option<String>,
}

// An absent optional string is valid; a present null is a shape error.
fn present_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

// A searchable field and its letter mask (`searchbits::mask`), computed once at
// load so a query can skip fields that lack its letters without scoring them.
struct Field {
    text: String,
    bits: u64,
}

impl Field {
    fn new(text: String) -> Self {
        let bits = searchbits::mask(text.as_bytes());
        Self { text, bits }
    }
}

struct Candidate {
    title: Field,
    subtitle: Option<Field>,
    alternate_titles: Vec<Field>,
    keywords: Vec<Field>,
    bundle_id: Option<Field>,
}

impl Entry {
    fn validate(&self, index: usize) -> Result<(), String> {
        let fields = 1
            + usize::from(self.subtitle.is_some())
            + self.alternate_titles.len()
            + self.keywords.len()
            + usize::from(self.bundle_id.is_some());
        if fields > MAX_FIELDS {
            return Err(format!("entries[{index}] exceeds {MAX_FIELDS} text fields"));
        }
        let check = |field: &str, text: &str| {
            if text.len() > MAX_FIELD_BYTES {
                Err(format!(
                    "entries[{index}].{field} exceeds {MAX_FIELD_BYTES} bytes"
                ))
            } else {
                Ok(())
            }
        };
        check("title", &self.title)?;
        if let Some(text) = &self.subtitle {
            check("subtitle", text)?;
        }
        if let Some(text) = &self.bundle_id {
            check("bundleId", text)?;
        }
        for (at, text) in self.alternate_titles.iter().enumerate() {
            check(&format!("alternateTitles[{at}]"), text)?;
        }
        for (at, text) in self.keywords.iter().enumerate() {
            check(&format!("keywords[{at}]"), text)?;
        }
        Ok(())
    }

    fn prepare(self) -> Candidate {
        let mut keywords = self.keywords;
        let subtitle = self.subtitle.filter(|text| !text.is_empty());
        if let Some(text) = &subtitle {
            keywords.push(format!("{} {text}", self.title));
            keywords.push(format!("{text} {}", self.title));
        }
        let subtitle = subtitle.filter(|text| text.to_lowercase() != self.title.to_lowercase());
        Candidate {
            title: Field::new(self.title),
            subtitle: subtitle.map(Field::new),
            alternate_titles: self.alternate_titles.into_iter().map(Field::new).collect(),
            keywords: keywords.into_iter().map(Field::new).collect(),
            bundle_id: self.bundle_id.map(Field::new),
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Sensitivity {
    Low,
    #[default]
    Medium,
    High,
}

#[derive(Debug, Serialize)]
pub(crate) struct Hit {
    pub index: usize,
    pub title: Option<i32>,
    pub alternate: Option<i32>,
    pub subtitle: Option<i32>,
    pub keyword: Option<i32>,
}

struct Scorer {
    matcher: Matcher,
    letters: Vec<Letter>,
    state: State,
    edits: Scratch,
    sensitivity: Sensitivity,
}

impl Scorer {
    fn new(query: &str, sensitivity: Sensitivity) -> Self {
        let matcher = Matcher::new(query);
        let state = State::new(matcher.needle.len());
        Self {
            matcher,
            letters: Vec::new(),
            state,
            edits: Scratch::default(),
            sensitivity,
        }
    }

    fn score(&mut self, text: &str) -> Option<i32> {
        self.matcher
            .name_bytes(
                text.as_bytes(),
                &mut self.letters,
                &mut self.state,
                &mut self.edits,
            )
            .filter(|score| {
                *score > SHADOW_TYPO
                    && (self.sensitivity != Sensitivity::High || *score >= NAME - HIT_SPAN)
            })
    }
}

impl Scorer {
    // The matcher's letter-presence filter: a field missing more query letters
    // than the edit budget allows (or any digit or punctuation of the query)
    // can't score, so it is skipped without running the matcher. Non-ASCII
    // text or queries always pass (searchbits::UNKNOWN), so results are the
    // same as scoring every field.
    fn score_field(&mut self, field: &Field) -> Option<i32> {
        if !searchbits::possible(self.matcher.bits, field.bits, self.matcher.budget) {
            return None;
        }
        self.score(&field.text)
    }
}

#[derive(Default)]
pub(crate) struct Catalog {
    entries: Option<Vec<Candidate>>,
}

impl Catalog {
    pub(crate) fn load(&mut self, entries: Vec<Entry>) -> Result<usize, String> {
        if entries.len() > MAX_ENTRIES {
            return Err(format!("entries exceeds {MAX_ENTRIES} candidates"));
        }
        for (index, entry) in entries.iter().enumerate() {
            entry.validate(index)?;
        }
        let count = entries.len();
        self.entries = Some(entries.into_iter().map(Entry::prepare).collect());
        Ok(count)
    }

    pub(crate) fn search(&self, query: &str, sensitivity: Sensitivity) -> Result<Vec<Hit>, String> {
        let entries = self
            .entries
            .as_ref()
            .ok_or("search requires a successful load first")?;
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(format!("query exceeds {MAX_QUERY_CHARS} characters"));
        }
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut scorer = Scorer::new(query, sensitivity);
        let mut hits = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let title = scorer.score_field(&entry.title);
            let alternate = entry
                .alternate_titles
                .iter()
                .filter_map(|field| scorer.score_field(field))
                .max();
            let subtitle = entry
                .subtitle
                .as_ref()
                .and_then(|field| scorer.score_field(field));
            let mut keyword = entry
                .keywords
                .iter()
                .filter_map(|field| scorer.score_field(field))
                .max();
            if query.contains('.')
                && let Some(bundle_id) = &entry.bundle_id
            {
                keyword = keyword.max(scorer.score_field(bundle_id));
            }
            if title.is_some() || alternate.is_some() || subtitle.is_some() || keyword.is_some() {
                hits.push(Hit {
                    index,
                    title,
                    alternate,
                    subtitle,
                    keyword,
                });
            }
        }
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::searchmatch::{EXACT, PREFIX, TYPO, WORD};
    use serde_json::json;

    fn catalog(entries: serde_json::Value) -> Catalog {
        let mut catalog = Catalog::default();
        catalog
            .load(serde_json::from_value(entries).unwrap())
            .unwrap();
        catalog
    }

    #[test]
    fn letter_filter_never_drops_a_field_the_matcher_would_score() {
        // The prefilter must be a pure shortcut: every field the matcher
        // scores (at any sensitivity) passes searchbits::possible.
        let texts = [
            "Firefox",
            "Mozilla Firefox",
            "first-response",
            "Terminal",
            "GNOME Terminal",
            "Café Crème",
            "Файл",
            "Zoom 5.0",
            "C++ IDE",
            "org.gnome.Nautilus",
            "my_app-2",
            "CamelCaseTool",
            "VS Code",
            "a/b/c path",
            "Plus+Minus",
            "x.y.z",
            "Bluetooth Settings",
        ];
        let queries = [
            "f",
            "fi",
            "fire",
            "fierfox",
            "firefoc",
            "frfx",
            "term",
            "temrinal",
            "gnome term",
            "cafe",
            "café",
            "фл",
            "zoom 5",
            "zoom 6",
            "c++",
            "c+",
            "org.gnome",
            "nautilsu",
            "my_app",
            "myapp2",
            "camel tool",
            "vs",
            "vscode",
            "a/b",
            "b/c",
            "plus+",
            "x.y",
            "blue",
            "bluetoth",
            "settngs",
            "5.0",
            "IDE",
            "ZZZ",
            "q",
            "tool",
        ];
        for query in queries {
            for sensitivity in [Sensitivity::Low, Sensitivity::Medium, Sensitivity::High] {
                let mut scorer = Scorer::new(query, sensitivity);
                for text in texts {
                    let field = Field::new(text.to_string());
                    let scored = scorer.score(text);
                    assert_eq!(scorer.score_field(&field), scored, "{query:?} on {text:?}");
                }
            }
        }
    }

    #[test]
    fn name_tiers_and_loaded_order_are_preserved() {
        let catalog = catalog(json!([
            {"title":"Fire"}, {"title":"Firefox"}, {"title":"Mozilla Fire"},
            {"title":"first-response"}, {"title":"zzzz"}
        ]));
        let hits = catalog.search("fire", Sensitivity::Medium).unwrap();
        assert_eq!(
            hits.iter().map(|hit| hit.index).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        assert_eq!(hits[0].title, Some(EXACT));
        assert_eq!(hits[1].title, Some(PREFIX));
        assert_eq!(hits[2].title, Some(WORD));
        assert!((NAME - HIT_SPAN..=NAME + HIT_SPAN).contains(&hits[3].title.unwrap()));
    }

    #[test]
    fn typo_scores_survive_low_and_medium_but_not_high() {
        let catalog = catalog(json!([{ "title":"Firefox" }]));
        for query in ["firefoc", "fierfox"] {
            for sensitivity in [Sensitivity::Low, Sensitivity::Medium] {
                assert_eq!(
                    catalog.search(query, sensitivity).unwrap()[0].title,
                    Some(TYPO - 1000)
                );
            }
            assert!(catalog.search(query, Sensitivity::High).unwrap().is_empty());
        }
        assert!(
            !catalog
                .search("frfx", Sensitivity::High)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn shadow_typos_are_never_returned() {
        let mut scorer = Scorer::new("firre", Sensitivity::Medium);
        let raw = scorer.matcher.name_bytes(
            b"Firefox",
            &mut scorer.letters,
            &mut scorer.state,
            &mut scorer.edits,
        );
        assert!(raw.is_some_and(|score| score <= SHADOW_TYPO));
        assert!(scorer.score("Firefox").is_none());
        let catalog = catalog(json!([
            { "title":"Firefox", "alternateTitles":["Firefox"], "keywords":["Firefox"] },
            { "title":"zzzz", "subtitle":"Firefox" }
        ]));
        assert!(
            catalog
                .search("firre", Sensitivity::Low)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn combined_keywords_keep_real_subsequences_when_title_is_only_a_shadow() {
        let catalog = catalog(json!([{ "title":"Firefox", "subtitle":"Firefox Tool" }]));
        let hits = catalog.search("firre", Sensitivity::High).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, None);
        assert_eq!(hits[0].subtitle, None);
        assert!((NAME - HIT_SPAN..=NAME + HIT_SPAN).contains(&hits[0].keyword.unwrap()));
    }

    #[test]
    fn unicode_folding_and_long_query_fallback_work_without_transliteration() {
        let long = "é".repeat(65);
        let catalog = catalog(json!([{ "title":"Файл" }, { "title":"Café" }, { "title":long }]));
        assert_eq!(
            catalog.search("фАЙЛ", Sensitivity::High).unwrap()[0].title,
            Some(EXACT)
        );
        assert!(
            (NAME - HIT_SPAN..=NAME + HIT_SPAN).contains(
                &catalog.search("фл", Sensitivity::High).unwrap()[0]
                    .title
                    .unwrap()
            )
        );
        assert_eq!(
            catalog.search("café", Sensitivity::High).unwrap()[0].title,
            Some(EXACT)
        );
        assert!(
            catalog
                .search("cafe", Sensitivity::High)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            catalog.search(&"é".repeat(65), Sensitivity::High).unwrap()[0].title,
            Some(EXACT)
        );
    }

    #[test]
    fn channel_maxima_combinations_and_bundle_gate_are_independent() {
        let catalog = catalog(json!([{ "title":"Alpha", "subtitle":"Beta",
            "alternateTitles":["Alpha Tool", "Alpha"], "keywords":["Beta Alpha Tool", "Beta Alpha"],
            "bundleId":"org.unique.app" }]));
        let hits = catalog.search("alpha", Sensitivity::Medium).unwrap();
        assert_eq!(hits[0].title, Some(EXACT));
        assert_eq!(hits[0].alternate, Some(EXACT));
        assert_eq!(hits[0].subtitle, None);
        assert_eq!(
            catalog.search("beta", Sensitivity::Medium).unwrap()[0].subtitle,
            Some(EXACT)
        );
        assert_eq!(
            catalog.search("alpha beta", Sensitivity::High).unwrap()[0].keyword,
            Some(EXACT)
        );
        assert_eq!(
            catalog.search("beta alpha", Sensitivity::High).unwrap()[0].keyword,
            Some(EXACT)
        );
        assert!(
            catalog
                .search("unique", Sensitivity::High)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            catalog.search("org.unique.app", Sensitivity::High).unwrap()[0].keyword,
            Some(EXACT)
        );
    }

    #[test]
    fn repeated_subtitle_is_suppressed_using_unicode_case_folding() {
        let catalog = catalog(json!([{ "title":"CAFÉ", "subtitle":"café" }]));
        let hits = catalog.search("café", Sensitivity::High).unwrap();
        assert_eq!(hits[0].title, Some(EXACT));
        assert_eq!(hits[0].subtitle, None);
    }

    #[test]
    fn query_limit_counts_characters_and_field_limit_counts_bytes() {
        let catalog = catalog(json!([{ "title":"é".repeat(MAX_FIELD_BYTES / 2) }]));
        assert_eq!(
            catalog
                .search(&"é".repeat(MAX_QUERY_CHARS), Sensitivity::Medium)
                .unwrap()[0]
                .title,
            Some(PREFIX)
        );
        assert!(
            catalog
                .search(&"é".repeat(MAX_QUERY_CHARS + 1), Sensitivity::Medium)
                .is_err()
        );
        let mut old = Catalog::default();
        assert!(
            old.load(
                serde_json::from_value(json!([{ "title":"é".repeat(MAX_FIELD_BYTES / 2 + 1) }]))
                    .unwrap()
            )
            .is_err()
        );
    }
}
