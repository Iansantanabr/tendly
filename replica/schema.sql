-- hub.db: the fork's own SQLite database, beside Tendly's tendly.db.
-- Source of truth is MIGRATIONS in crates/server/src/hub/store.rs; this file
-- mirrors it for planning. Every numbered entry below is live (never edit one).
--
-- Conventions (SQLite, not Postgres):
--   ids      TEXT uuid, or INTEGER AUTOINCREMENT for append-only logs
--   times    TEXT, RFC 3339 in UTC ("2026-11-06T01:05:14Z"); never local time
--   enums    CHECK constraints
--   owner    single user today: the server's token is the only owner. Every
--            table that will belong to a person later gets `owner_id` when the
--            multi-user milestone lands (see the end of this file), not before.
--   access   data-layer checks: security.rs `guard` authenticates every /api/
--            call; each hub route then validates workspace ids and paths.
--   foreign keys to Tendly's own tables (sessions, workspaces) live in another
--            database, so they are soft references checked in code; deleting a
--            workspace leaves rows that list endpoints skip.

---------------------------------------------------------------- live: 1
CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,            -- turn_done | turn_failed | waiting | automation_done | automation_failed
    session_id TEXT,               -- soft ref to tendly.db sessions
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
    seen_at TEXT                   -- unread = last_turn_at > seen_at
);

---------------------------------------------------------------- live: 2
CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('script', 'agent')),
    cron TEXT NOT NULL,
    timezone TEXT,                 -- IANA name; NULL = the hub's time zone (see 7)
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
    automation_id TEXT NOT NULL,   -- runs are deleted with their automation, in code
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'timeout')),
    exit_code INTEGER,
    output_tail TEXT NOT NULL DEFAULT '',
    session_id TEXT,               -- agent runs: the conversation it opened ("Rotinas recentes")
    trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual'))
);
CREATE INDEX automation_runs_by_automation ON automation_runs(automation_id, started_at);

---------------------------------------------------------------- live: 3
CREATE TABLE file_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    blob TEXT NOT NULL,            -- sha256 under <state>/history/blobs
    size INTEGER NOT NULL,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('you', 'agent', 'unknown')),
    session_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX file_versions_by_path ON file_versions(workspace_id, path, id);

---------------------------------------------------------------- live: 4
CREATE TABLE publications (
    slug TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('team', 'password', 'public')),
    password_hash TEXT,            -- argon2id
    mode TEXT NOT NULL CHECK (mode IN ('frozen', 'live')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    frozen_at TEXT,
    UNIQUE (workspace_id, path)
);
CREATE TABLE publication_secret (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL           -- HMAC key for password cookies
);

---------------------------------------------------------------- live: 5 (M2, named spaces)
-- A saved Mesa layout with a name ("Relatório de anúncios"). Loading one
-- replaces the shared canvas through Tendly's own revisioned save, so two
-- windows still resolve conflicts the way they do today.
CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    layout TEXT NOT NULL,          -- LayoutDocument JSON, validated by canvas.rs rules
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (name)
);

---------------------------------------------------------------- live: 6 (M3, push on phones)
-- Nothing secret is stored in the clear: `push_keys.vapid_private` and
-- `push_subscriptions.auth` hold base64url(nonce || AES-256-GCM ciphertext),
-- sealed with the 32-byte key in <state>/push-seal.key (0600). Lose that file
-- and the key pair is made again and every device subscribes again.
CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE, -- browser push service URL
    p256dh TEXT NOT NULL,          -- the browser's public key (base64url, 65 bytes)
    auth TEXT NOT NULL,            -- sealed
    label TEXT NOT NULL DEFAULT '', -- "iPhone", "Mac · Chrome"
    created_at TEXT NOT NULL,
    last_ok_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0  -- dropped after 404/410 or 5 rejections in a row
);
CREATE TABLE push_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    vapid_public TEXT NOT NULL,
    vapid_private TEXT NOT NULL    -- sealed; generated once; rotating it invalidates every subscription
);

---------------------------------------------------------------- live: 7 (M4, hub settings)
-- Small key/value settings that are the fork's, not Tendly's preferences.
-- The migration seeds nothing; a missing or unusable row means the default.
--   timezone          IANA zone for automations without one (VPS clocks run UTC).
--                     Written once, at the first start, from the machine's own zone
--                     unless that is UTC-like; default America/Sao_Paulo.
--   public_base_url   https://pub.example.com for /p/{slug} links, or '' (this server's own
--                     address). The server answers for that host under /p/ only.
--   dictation         'browser' | 'off'
--   mesa_sidebar      'icons' | 'expanded' (Apps A): the sidebar on the Mesa; default icons.
--   app_order         JSON {"pinned": [], "order": [], "hidden": []} (Apps A), each entry
--                     '<workspace id>/<slug>'; a hidden app is never pinned. No migration:
--                     both are rows of this table, and a missing row means the default.
CREATE TABLE hub_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

---------------------------------------------------------------- live: 8 (M5, version messages)
-- One line of what the agent said in the turn that wrote the version (first
-- sentence, at most 80 characters, no model call). NULL for the person's own
-- versions, for changes from outside Tendly and for versions kept before this.
ALTER TABLE file_versions ADD COLUMN message TEXT;

---------------------------------------------------------------- live: 9 (M5, pinned message)
-- The message the person pinned to the top of a conversation. One per
-- conversation (the primary key), always a message of theirs; `text` is a copy
-- read from the stored conversation when it is pinned, at most 4000 characters.
CREATE TABLE pinned_messages (
    session_id TEXT PRIMARY KEY,   -- soft ref to tendly.db sessions
    message_id TEXT NOT NULL,      -- the id of the message event
    text TEXT NOT NULL,
    pinned_at TEXT NOT NULL
);

---------------------------------------------------------------- live: 10 (Apps C, permissions and app frames)
-- What the person allowed each app. An app asks in app.json ("permissions");
-- one row per app and permission once the person answered (allowed 1 or 0).
-- What an app may do = what it asks AND allowed = 1. A permission taken out of
-- app.json has its row deleted when the grants are next read, so asking for it
-- again is a new question. No foreign keys: the app is a folder, not a row.
CREATE TABLE app_grants (
    workspace_id TEXT NOT NULL,    -- soft ref to tendly.db workspaces
    slug TEXT NOT NULL,            -- apps/<slug>/
    permission TEXT NOT NULL,      -- sessions:read | files:read | automations:read | notify | agent:draft (checked in code)
    allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    granted_at TEXT NOT NULL,      -- when this answer was given (kept when the same answer is given again)
    PRIMARY KEY (workspace_id, slug, permission)
);
-- The secret that signs the addresses app files are served from
-- (/apps-run/<workspace>/<slug>/<expiry>.<hmac>/...), made on first use.
-- Deleting the row invalidates every address in use; open apps load again.
CREATE TABLE app_frame_secret (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL
);
-- Where an inbox entry leads when it is not about a conversation: an app's
-- notice (kind 'app') opens /apps/<workspace>/<slug>. NULL for everything else.
ALTER TABLE notifications ADD COLUMN link TEXT;

---------------------------------------------------------------- live: 11 (Apps D, collections)
-- The records of an app's collections (tendly.db.collection(name) in the SDK).
-- One row per record; `data` is a JSON object of the app's own making, up to
-- 5 MB. `rev` is 1 when the record is created and goes up by one on every
-- write: a write that names the revision it saw is refused (409, with the
-- current record) when the record has moved on. That check is in code, under
-- the connection's lock, together with the limits (50,000 records per
-- collection, 100 collections per app).
-- A collection is not a row of its own: it exists while it has records.
-- No foreign keys: the app is a folder (apps/<slug>/ in a workspace of
-- tendly.db), and its records stay if the folder goes.
-- Filters (`where` on top-level fields) use json_type/json_extract on `data`
-- with the field path bound as a parameter; no index on fields, which is fine
-- at 50,000 rows per collection.
CREATE TABLE app_records (
    workspace_id TEXT NOT NULL,    -- soft ref to tendly.db workspaces
    slug TEXT NOT NULL,            -- apps/<slug>/
    collection TEXT NOT NULL,      -- [A-Za-z0-9_-]{1,64} (checked in code)
    id TEXT NOT NULL,              -- a UUID made by the server, or the app's own ([A-Za-z0-9_-]{1,64})
    data TEXT NOT NULL CHECK (json_valid(data)),
    rev INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
    created_at TEXT NOT NULL,      -- RFC 3339 UTC with milliseconds, so text order is time order
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, slug, collection, id)
);
-- The default list order (oldest first) and "most recently written first".
CREATE INDEX app_records_by_created ON app_records(workspace_id, slug, collection, created_at);
CREATE INDEX app_records_by_updated ON app_records(workspace_id, slug, collection, updated_at);

---------------------------------------------------------------- later (multi-user, after the VPS)
-- Not a migration yet. Sketch so today's tables don't paint us into a corner:
--   people(id, name, email UNIQUE, role CHECK IN ('admin','member'), created_at)
--   folder_grants(person_id -> people ON DELETE CASCADE, workspace_id, access CHECK IN ('read','write'))
--   conversation_shares(session_id, person_id -> people ON DELETE CASCADE, role CHECK IN ('read','join'), UNIQUE(session_id, person_id))
--   conversation_notes(id, session_id, author_id -> people ON DELETE SET NULL, body, created_at)   -- "Entre nós": never sent to the agent
--   and owner_id (-> people ON DELETE SET NULL) added to automations, publications, spaces, push_subscriptions;
--   notifications gets person_id so each person has a bell of their own.
