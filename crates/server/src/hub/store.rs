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
    // 8: one line of what the agent said, on the versions an agent wrote
    "ALTER TABLE file_versions ADD COLUMN message TEXT;",
    // 9: the message pinned to the top of a conversation, one per conversation
    "CREATE TABLE pinned_messages (
        session_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        pinned_at TEXT NOT NULL
    );",
    // 10: what the person allowed each app to do, the secret that signs the
    // addresses app frames are served from, and where an inbox entry leads
    "CREATE TABLE app_grants (
        workspace_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        permission TEXT NOT NULL,
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        granted_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, slug, permission)
    );
    CREATE TABLE app_frame_secret (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        secret TEXT NOT NULL
    );
    ALTER TABLE notifications ADD COLUMN link TEXT;",
    // 11: the records of an app's collections (`apps/records.rs`): one JSON
    // object each, with a revision that counts its writes
    "CREATE TABLE app_records (
        workspace_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data)),
        rev INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, slug, collection, id)
    );
    CREATE INDEX app_records_by_created ON app_records(workspace_id, slug, collection, created_at);
    CREATE INDEX app_records_by_updated ON app_records(workspace_id, slug, collection, updated_at);",
];

pub struct HubStore {
    connection: SharedConnection,
    /// Apps that changed on disk and what their files held before (`apps/live.rs`).
    /// In memory only: it belongs here because this handle is what every part of the hub shares.
    pub(crate) app_live: super::apps::live::Live,
    /// App frame addresses kept alive past their signed expiry (`apps/frame.rs`). In memory only.
    pub(crate) app_frames: super::apps::frame::Frames,
    /// The errors each open app reported last (`apps/diagnostics.rs`). In memory only.
    pub(crate) app_health: super::apps::diagnostics::Health,
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
            app_live: Default::default(),
            app_frames: Default::default(),
            app_health: Default::default(),
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
                assert_eq!(version as usize, MIGRATIONS.len());
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
    fn version_seven_database_upgrades_to_version_messages() {
        let connection = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..7] {
            connection.execute_batch(sql).unwrap();
        }
        connection.pragma_update(None, "user_version", 7i64).unwrap();
        connection
            .execute(
                "INSERT INTO file_versions(workspace_id, path, blob, size, author_kind, session_id, created_at)
                 VALUES ('w', 'a.txt', 'h', 1, 'agent', 's', 'then')",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO hub_settings(key, value, updated_at) VALUES ('timezone', 'America/Sao_Paulo', 'now')", [])
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
                assert_eq!(version as usize, MIGRATIONS.len());
                // Versions kept before the upgrade stay, with no message.
                let (path, session, message): (String, Option<String>, Option<String>) = c.query_row(
                    "SELECT path, session_id, message FROM file_versions",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                assert_eq!((path.as_str(), session.as_deref(), message), ("a.txt", Some("s"), None));
                let zone: String = c.query_row("SELECT value FROM hub_settings WHERE key = 'timezone'", [], |r| r.get(0))?;
                assert_eq!(zone, "America/Sao_Paulo");
                c.execute(
                    "INSERT INTO file_versions(workspace_id, path, blob, size, author_kind, created_at, message)
                     VALUES ('w', 'a.txt', 'i', 1, 'agent', 'now', 'Tightened the title.')",
                    [],
                )?;
                let kept: Option<String> =
                    c.query_row("SELECT message FROM file_versions ORDER BY id DESC LIMIT 1", [], |r| r.get(0))?;
                assert_eq!(kept.as_deref(), Some("Tightened the title."));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn version_eight_database_upgrades_to_pinned_messages() {
        let connection = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..8] {
            connection.execute_batch(sql).unwrap();
        }
        connection.pragma_update(None, "user_version", 8i64).unwrap();
        connection
            .execute(
                "INSERT INTO file_versions(workspace_id, path, blob, size, author_kind, created_at, message)
                 VALUES ('w', 'a.txt', 'h', 1, 'agent', 'then', 'Tightened the title.')",
                [],
            )
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
                assert_eq!(version as usize, MIGRATIONS.len());
                let kept: Option<String> = c.query_row("SELECT message FROM file_versions", [], |r| r.get(0))?;
                assert_eq!(kept.as_deref(), Some("Tightened the title."));
                let pin = |session: &str, message: &str| {
                    c.execute(
                        "INSERT INTO pinned_messages(session_id, message_id, text, pinned_at) VALUES (?1, ?2, 'said', 'now')",
                        [session, message],
                    )
                };
                pin("s1", "m1")?;
                assert!(pin("s1", "m2").is_err(), "one pin per conversation");
                pin("s2", "m1")?;
                let rows: i64 = c.query_row("SELECT count(*) FROM pinned_messages", [], |r| r.get(0))?;
                assert_eq!(rows, 2);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn version_nine_database_upgrades_to_app_grants() {
        let connection = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..9] {
            connection.execute_batch(sql).unwrap();
        }
        connection.pragma_update(None, "user_version", 9i64).unwrap();
        connection
            .execute(
                "INSERT INTO notifications(kind, session_id, title, body, created_at) VALUES ('waiting', 's1', 'kept', '', 'then')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO pinned_messages(session_id, message_id, text, pinned_at) VALUES ('s1', 'm1', 'said', 'then')",
                [],
            )
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
                assert_eq!(version as usize, MIGRATIONS.len());
                // What was there stays, and an old inbox entry leads nowhere in particular.
                let (title, link): (String, Option<String>) =
                    c.query_row("SELECT title, link FROM notifications", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
                assert_eq!((title.as_str(), link), ("kept", None));
                let pinned: i64 = c.query_row("SELECT count(*) FROM pinned_messages", [], |r| r.get(0))?;
                assert_eq!(pinned, 1);
                let grant = |slug: &str, permission: &str, allowed: i64| {
                    c.execute(
                        "INSERT INTO app_grants(workspace_id, slug, permission, allowed, granted_at) VALUES ('w', ?1, ?2, ?3, 'now')",
                        rusqlite::params![slug, permission, allowed],
                    )
                };
                grant("crm", "sessions:read", 1)?;
                grant("crm", "notify", 0)?;
                grant("other", "sessions:read", 1)?;
                assert!(grant("crm", "sessions:read", 0).is_err(), "one decision per app and permission");
                assert!(grant("crm", "files:read", 2).is_err(), "allowed is yes or no");
                c.execute("INSERT INTO app_frame_secret(id, secret) VALUES (1, 's')", [])?;
                assert!(c.execute("INSERT INTO app_frame_secret(id, secret) VALUES (2, 's')", []).is_err(), "one secret");
                c.execute(
                    "INSERT INTO notifications(kind, title, created_at, link) VALUES ('app', 'CRM: New lead', 'now', '/apps/w/crm')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn version_ten_database_upgrades_to_app_records() {
        let connection = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..10] {
            connection.execute_batch(sql).unwrap();
        }
        connection.pragma_update(None, "user_version", 10i64).unwrap();
        connection
            .execute(
                "INSERT INTO app_grants(workspace_id, slug, permission, allowed, granted_at) VALUES ('w', 'crm', 'notify', 1, 'then')",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO app_frame_secret(id, secret) VALUES (1, 'kept')", []).unwrap();
        connection
            .execute(
                "INSERT INTO notifications(kind, title, created_at, link) VALUES ('app', 'CRM: New lead', 'then', '/apps/w/crm')",
                [],
            )
            .unwrap();
        let store = HubStore::migrated(connection).unwrap();
        store
            .with(|c| {
                let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
                assert_eq!(version as usize, MIGRATIONS.len());
                // What was there stays.
                let allowed: i64 = c.query_row("SELECT allowed FROM app_grants WHERE slug = 'crm'", [], |r| r.get(0))?;
                assert_eq!(allowed, 1);
                let secret: String = c.query_row("SELECT secret FROM app_frame_secret", [], |r| r.get(0))?;
                assert_eq!(secret, "kept");
                let link: Option<String> = c.query_row("SELECT link FROM notifications", [], |r| r.get(0))?;
                assert_eq!(link.as_deref(), Some("/apps/w/crm"));
                let record = |collection: &str, id: &str, data: &str| {
                    c.execute(
                        "INSERT INTO app_records(workspace_id, slug, collection, id, data, created_at, updated_at)
                         VALUES ('w', 'crm', ?1, ?2, ?3, 'now', 'now')",
                        [collection, id, data],
                    )
                };
                record("leads", "a", r#"{"name":"Ana"}"#)?;
                assert!(record("leads", "a", "{}").is_err(), "one record per id in a collection");
                record("deals", "a", "{}")?;
                assert!(record("leads", "b", "{nope").is_err(), "data is JSON");
                let rev: i64 = c.query_row("SELECT rev FROM app_records WHERE collection = 'leads'", [], |r| r.get(0))?;
                assert_eq!(rev, 1, "a new record starts at revision 1");
                assert!(c.execute("UPDATE app_records SET rev = 0", []).is_err(), "revisions start at 1");
                // The filters of `apps/records.rs` need SQLite's JSON functions.
                let name: String =
                    c.query_row("SELECT json_extract(data, '$.\"name\"') FROM app_records WHERE id = 'a' AND collection = 'leads'", [], |r| r.get(0))?;
                assert_eq!(name, "Ana");
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
