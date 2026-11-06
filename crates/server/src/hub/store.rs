//! The Hub database and its migrations, numbered on their own.
use super::SharedConnection;
use rusqlite::Connection;
use std::path::Path;

/// Each entry upgrades the schema by one version; never edit a shipped entry.
const MIGRATIONS: &[&str] = &[
    // 1: inbox and read state
    "CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        session_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        read_at TEXT
    );
    CREATE INDEX notifications_unread ON notifications(read_at, created_at);
    CREATE TABLE session_activity (
        session_id TEXT PRIMARY KEY,
        last_turn_at TEXT,
        last_turn_status TEXT,
        seen_at TEXT
    );",
    // 2: scheduled automations and their run log
    "CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL CHECK (kind IN ('script', 'agent')),
        cron TEXT NOT NULL,
        timezone TEXT,
        workspace_id TEXT,
        command TEXT,
        prompt TEXT,
        provider TEXT CHECK (provider IS NULL OR provider IN ('claude_code', 'codex')),
        endpoint_id TEXT,
        model TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'timeout')),
        exit_code INTEGER,
        output_tail TEXT NOT NULL DEFAULT '',
        session_id TEXT,
        trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual'))
    );
    CREATE INDEX automation_runs_by_automation ON automation_runs(automation_id, started_at);",
    // 3: file version history (contents are blobs under <state>/history/blobs)
    "CREATE TABLE file_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        blob TEXT NOT NULL,
        size INTEGER NOT NULL,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('you', 'agent', 'unknown')),
        session_id TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX file_versions_by_path ON file_versions(workspace_id, path, id);",
    // 4: publications
    "CREATE TABLE publications (
        slug TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('team', 'password', 'public')),
        password_hash TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('frozen', 'live')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        frozen_at TEXT,
        UNIQUE (workspace_id, path)
    );
    CREATE TABLE publication_secret (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        secret TEXT NOT NULL
    );",
    // 5: named spaces (saved Mesa layouts)
    "CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        layout TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (name)
    );",
    // 6: Web Push (the VAPID private key and each auth secret are stored sealed)
    "CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_ok_at TEXT,
        failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE push_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        vapid_public TEXT NOT NULL,
        vapid_private TEXT NOT NULL
    );",
    // 7: the fork's own settings (time zone, public link address, dictation)
    "CREATE TABLE hub_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );",
];

pub struct HubStore {
    connection: SharedConnection,
}

impl HubStore {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        Self::migrated(connection)
    }

    pub fn memory() -> Self {
        Self::migrated(Connection::open_in_memory().expect("in-memory sqlite"))
            .expect("hub migrations")
    }

    fn migrated(mut connection: Connection) -> rusqlite::Result<Self> {
        let version: usize =
            connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? as usize;
        if version > MIGRATIONS.len() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let tx = connection.transaction()?;
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(version) {
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        }
        tx.commit()?;
        Ok(Self {
            connection: SharedConnection::new(connection),
        })
    }

    pub fn with<T>(&self, operation: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let connection = self.connection.lock().expect("hub db");
        operation(&connection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_and_reopen() {
        let dir = std::env::temp_dir().join(format!("hub-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hub.db");
        HubStore::open(&path).unwrap();
        let store = HubStore::open(&path).unwrap();
        let version: i64 = store
            .with(|c| c.pragma_query_value(None, "user_version", |r| r.get(0)))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn publications_are_one_per_file_with_checked_values() {
        let store = HubStore::memory();
        store
            .with(|c| {
                let insert = |slug: &str, path: &str, visibility: &str, mode: &str| {
                    c.execute(
                        "INSERT INTO publications(slug, workspace_id, path, visibility, mode, created_at, updated_at)
                         VALUES (?1, 'w', ?2, ?3, ?4, 'now', 'now')",
                        rusqlite::params![slug, path, visibility, mode],
                    )
                };
                insert("a-1234", "a.html", "team", "frozen")?;
                assert!(insert("b-1234", "a.html", "public", "live").is_err(), "one per file");
                assert!(insert("a-1234", "b.html", "public", "live").is_err(), "slug taken");
                assert!(insert("c-1234", "c.html", "everyone", "live").is_err());
                assert!(insert("d-1234", "d.html", "public", "sometimes").is_err());
                c.execute("INSERT INTO publication_secret(id, secret) VALUES (1, 's')", [])?;
                assert!(c.execute("INSERT INTO publication_secret(id, secret) VALUES (2, 's')", []).is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn version_one_database_upgrades_to_automations() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(MIGRATIONS[0]).unwrap();
        connection.pragma_update(None, "user_version", 1i64).unwrap();
        connection
            .execute(
                "INSERT INTO notifications(kind, title, created_at) VALUES ('waiting', 'kept', 'now')",
                [],
            )
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let kept: String = c.query_row("SELECT title FROM notifications", [], |r| r.get(0))?;
                assert_eq!(kept, "kept");
                c.execute(
                    "INSERT INTO automations(id, name, kind, cron, enabled, created_at, updated_at)
                     VALUES ('a', 'n', 'script', '0 * * * *', 1, 'now', 'now')",
                    [],
                )?;
                c.execute(
                    "INSERT INTO automation_runs(automation_id, started_at, status, trigger)
                     VALUES ('a', 'now', 'running', 'manual')",
                    [],
                )?;
                assert!(
                    c.execute(
                        "INSERT INTO automations(id, name, kind, cron, enabled, created_at, updated_at)
                         VALUES ('b', 'n', 'other', '0 * * * *', 1, 'now', 'now')",
                        [],
                    )
                    .is_err()
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn version_four_database_upgrades_to_spaces() {
        let connection = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..4] {
            connection.execute_batch(sql).unwrap();
        }
        connection.pragma_update(None, "user_version", 4i64).unwrap();
        connection
            .execute(
                "INSERT INTO publications(slug, workspace_id, path, visibility, mode, created_at, updated_at)
                 VALUES ('kept-1234', 'w', 'a.html', 'team', 'live', 'now', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO notifications(kind, title, created_at) VALUES ('waiting', 'kept', 'now')", [])
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
                assert_eq!(version as usize, MIGRATIONS.len());
                let slug: String = c.query_row("SELECT slug FROM publications", [], |r| r.get(0))?;
                assert_eq!(slug, "kept-1234");
                let title: String = c.query_row("SELECT title FROM notifications", [], |r| r.get(0))?;
                assert_eq!(title, "kept");
                let insert = |id: &str, name: &str| {
                    c.execute(
                        "INSERT INTO spaces(id, name, layout, created_at, updated_at) VALUES (?1, ?2, '{}', 'now', 'now')",
                        [id, name],
                    )
                };
                insert("a", "Ads report")?;
                assert!(insert("b", "Ads report").is_err(), "names are unique");
                assert!(insert("c", "").is_err(), "empty name");
                assert!(insert("d", &"x".repeat(81)).is_err(), "name too long");
                insert("e", &"é".repeat(80))?;
                let position: i64 = c.query_row("SELECT position FROM spaces WHERE id='a'", [], |r| r.get(0))?;
                assert_eq!(position, 0);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn version_five_database_upgrades_to_push() {
        let connection = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..5] {
            connection.execute_batch(sql).unwrap();
        }
        connection.pragma_update(None, "user_version", 5i64).unwrap();
        connection
            .execute(
                "INSERT INTO spaces(id, name, layout, created_at, updated_at) VALUES ('kept', 'Ads report', '{}', 'now', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO notifications(kind, title, created_at) VALUES ('waiting', 'kept', 'now')", [])
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
                assert_eq!(version as usize, MIGRATIONS.len());
                let space: String = c.query_row("SELECT name FROM spaces", [], |r| r.get(0))?;
                assert_eq!(space, "Ads report");
                let title: String = c.query_row("SELECT title FROM notifications", [], |r| r.get(0))?;
                assert_eq!(title, "kept");
                let insert = |id: &str, endpoint: &str| {
                    c.execute(
                        "INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, 'p', 'a', 'now')",
                        [id, endpoint],
                    )
                };
                insert("a", "https://push.example/1")?;
                assert!(insert("b", "https://push.example/1").is_err(), "one row per endpoint");
                insert("b", "https://push.example/2")?;
                let (label, failures, last_ok): (String, i64, Option<String>) = c.query_row(
                    "SELECT label, failures, last_ok_at FROM push_subscriptions WHERE id = 'a'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                assert_eq!((label.as_str(), failures, last_ok), ("", 0, None));
                c.execute("INSERT INTO push_keys(id, vapid_public, vapid_private) VALUES (1, 'pub', 'sealed')", [])?;
                assert!(
                    c.execute("INSERT INTO push_keys(id, vapid_public, vapid_private) VALUES (2, 'pub', 'sealed')", [])
                        .is_err(),
                    "one key pair"
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn version_six_database_upgrades_to_settings() {
        let connection = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..6] {
            connection.execute_batch(sql).unwrap();
        }
        connection.pragma_update(None, "user_version", 6i64).unwrap();
        connection
            .execute(
                "INSERT INTO automations(id, name, kind, cron, enabled, created_at, updated_at)
                 VALUES ('kept', 'Morning report', 'script', '0 9 * * *', 1, 'now', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, created_at) VALUES ('kept', 'https://push.example/1', 'p', 'a', 'now')",
                [],
            )
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
                assert_eq!(version, 7);
                let (name, timezone): (String, Option<String>) =
                    c.query_row("SELECT name, timezone FROM automations", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
                assert_eq!((name.as_str(), timezone), ("Morning report", None));
                let device: String = c.query_row("SELECT id FROM push_subscriptions", [], |r| r.get(0))?;
                assert_eq!(device, "kept");
                // The migration seeds nothing: the defaults are the code's.
                let rows: i64 = c.query_row("SELECT count(*) FROM hub_settings", [], |r| r.get(0))?;
                assert_eq!(rows, 0);
                let put = |key: &str, value: &str| {
                    c.execute("INSERT INTO hub_settings(key, value, updated_at) VALUES (?1, ?2, 'now')", [key, value])
                };
                put("timezone", "America/Sao_Paulo")?;
                assert!(put("timezone", "UTC").is_err(), "one row per key");
                put("dictation", "off")?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn version_two_database_upgrades_to_file_history() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(MIGRATIONS[0]).unwrap();
        connection.execute_batch(MIGRATIONS[1]).unwrap();
        connection.pragma_update(None, "user_version", 2i64).unwrap();
        connection
            .execute(
                "INSERT INTO automations(id, name, kind, cron, enabled, created_at, updated_at)
                 VALUES ('kept', 'n', 'script', '0 * * * *', 1, 'now', 'now')",
                [],
            )
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let kept: String = c.query_row("SELECT id FROM automations", [], |r| r.get(0))?;
                assert_eq!(kept, "kept");
                let insert = |author: &str| {
                    c.execute(
                        "INSERT INTO file_versions(workspace_id, path, blob, size, author_kind, created_at)
                         VALUES ('w', 'a.txt', 'h', 1, ?1, 'now')",
                        [author],
                    )
                };
                for author in ["you", "agent", "unknown"] {
                    insert(author)?;
                }
                assert!(insert("robot").is_err());
                Ok(())
            })
            .unwrap();
    }
}
