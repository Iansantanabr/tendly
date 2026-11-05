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
}
