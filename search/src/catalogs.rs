use crate::engine::{Catalog, Entry, Hit, Sensitivity};

// The catalog a request names when it has no `catalog` property.
pub(crate) const DEFAULT_CATALOG: &str = "root";
pub(crate) const MAX_CATALOGS: usize = 4;
pub(crate) const MAX_TOTAL_ENTRIES: usize = 40_000;
pub(crate) const MAX_CATALOG_NAME_BYTES: usize = 64;

// One loaded list, by the name the caller gave it.
struct Named {
    name: String,
    catalog: Catalog,
    entries: usize,
}

// The helper's lists. A load replaces one name's list atomically: a rejected
// load (bad name, a bound, an invalid entry) keeps every list as it was.
#[derive(Default)]
pub(crate) struct Catalogs {
    named: Vec<Named>,
}

fn check_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= MAX_CATALOG_NAME_BYTES
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(format!(
            "catalog must be 1 to {MAX_CATALOG_NAME_BYTES} ASCII letters, digits, '-', '_', '.' or ':'"
        ))
    }
}

impl Catalogs {
    pub(crate) fn load(&mut self, name: &str, entries: Vec<Entry>) -> Result<usize, String> {
        check_name(name)?;
        let at = self.named.iter().position(|named| named.name == name);
        if at.is_none() && self.named.len() >= MAX_CATALOGS {
            return Err(format!("catalogs exceeds {MAX_CATALOGS} names"));
        }
        let others: usize = self
            .named
            .iter()
            .filter(|named| named.name != name)
            .map(|named| named.entries)
            .sum();
        if others + entries.len() > MAX_TOTAL_ENTRIES {
            return Err(format!(
                "catalogs exceed {MAX_TOTAL_ENTRIES} candidates in total"
            ));
        }
        match at {
            Some(at) => {
                let named = &mut self.named[at];
                named.entries = named.catalog.load(entries)?;
                Ok(named.entries)
            }
            None => {
                let mut catalog = Catalog::default();
                let loaded = catalog.load(entries)?;
                self.named.push(Named {
                    name: name.to_owned(),
                    catalog,
                    entries: loaded,
                });
                Ok(loaded)
            }
        }
    }

    pub(crate) fn search(
        &self,
        name: &str,
        query: &str,
        sensitivity: Sensitivity,
    ) -> Result<Vec<Hit>, String> {
        check_name(name)?;
        self.named
            .iter()
            .find(|named| named.name == name)
            .ok_or_else(|| format!("search requires a successful load of catalog {name} first"))?
            .catalog
            .search(query, sensitivity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entries(count: usize, title: &str) -> Vec<Entry> {
        serde_json::from_value(json!(vec![json!({ "title": title }); count])).unwrap()
    }

    fn titles(catalogs: &Catalogs, name: &str, query: &str) -> usize {
        catalogs
            .search(name, query, Sensitivity::Medium)
            .unwrap()
            .len()
    }

    #[test]
    fn names_keep_their_own_lists_and_a_reload_replaces_only_its_own() {
        let mut catalogs = Catalogs::default();
        assert_eq!(catalogs.load("root", entries(2, "firefox")), Ok(2));
        assert_eq!(catalogs.load("view", entries(1, "github")), Ok(1));
        assert_eq!(titles(&catalogs, "root", "firefox"), 2);
        assert_eq!(titles(&catalogs, "view", "firefox"), 0);
        assert_eq!(catalogs.load("view", entries(3, "firefox")), Ok(3));
        assert_eq!(titles(&catalogs, "view", "firefox"), 3);
        assert_eq!(titles(&catalogs, "root", "firefox"), 2);
        assert!(
            catalogs
                .search("other", "firefox", Sensitivity::Medium)
                .unwrap_err()
                .contains("catalog other")
        );
    }

    #[test]
    fn names_are_bounded_in_count_and_shape() {
        let mut catalogs = Catalogs::default();
        for name in ["a", "b.c", "d:e", "F-_9"] {
            assert_eq!(catalogs.load(name, entries(1, "x")), Ok(1));
        }
        let error = catalogs.load("e", entries(1, "x")).unwrap_err();
        assert!(error.contains("4 names"), "{error}");
        // Replacing a loaded name is still allowed at the bound.
        assert_eq!(catalogs.load("a", entries(2, "x")), Ok(2));
        let long = "n".repeat(MAX_CATALOG_NAME_BYTES);
        for bad in ["", "with space", "slash/", "é", &format!("{long}n")] {
            assert!(catalogs.load(bad, entries(1, "x")).is_err(), "{bad:?}");
            assert!(catalogs.search(bad, "x", Sensitivity::Medium).is_err());
        }
        let mut fresh = Catalogs::default();
        assert_eq!(fresh.load(&long, entries(1, "x")), Ok(1));
    }

    #[test]
    fn total_entries_are_bounded_and_a_rejected_load_keeps_every_list() {
        let half = MAX_TOTAL_ENTRIES / 2;
        let mut catalogs = Catalogs::default();
        assert_eq!(catalogs.load("root", entries(half, "x")), Ok(half));
        assert_eq!(catalogs.load("view", entries(half, "y")), Ok(half));
        let error = catalogs.load("more", entries(1, "z")).unwrap_err();
        assert!(error.contains("40000 candidates in total"), "{error}");
        let error = catalogs.load("view", entries(half + 1, "z")).unwrap_err();
        assert!(error.contains("in total"), "{error}");
        assert_eq!(titles(&catalogs, "view", "y"), half);
        assert_eq!(titles(&catalogs, "view", "z"), 0);
        // An invalid entry keeps the old list too, and a new name is not added.
        let invalid: Vec<Entry> =
            serde_json::from_value(json!([{ "title": "x".repeat(16_385) }])).unwrap();
        assert!(catalogs.load("view", invalid).is_err());
        assert_eq!(titles(&catalogs, "view", "y"), half);
        let invalid: Vec<Entry> =
            serde_json::from_value(json!([{ "title": "x".repeat(16_385) }])).unwrap();
        assert_eq!(catalogs.load("view", Vec::new()), Ok(0));
        assert!(catalogs.load("new", invalid).is_err());
        assert!(catalogs.search("new", "x", Sensitivity::Medium).is_err());
        // A smaller reload frees room for another name.
        assert_eq!(catalogs.load("more", entries(half, "z")), Ok(half));
    }
}
