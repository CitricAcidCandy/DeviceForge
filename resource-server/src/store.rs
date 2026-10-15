use crate::model::{CatalogQuery, MarketEntry, Visibility, validate_market_entry};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("资源存储 I/O 失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("资源数据库失败：{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("资源不存在")]
    Missing,
    #[error("资源标识无效")]
    InvalidId,
    #[error("市场元数据无效：{0}")]
    Metadata(String),
    #[error("市场条目已存在")]
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceRecord {
    pub id: String,
    pub sha256: String,
    pub filename: String,
    pub media_type: String,
    pub kind: String,
    pub size: u64,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogResult {
    pub entries: Vec<MarketEntry>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Clone)]
pub struct Store {
    root: Arc<PathBuf>,
    connection: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open(root: &Path) -> Result<Self, StoreError> {
        fs::create_dir_all(root.join("blobs"))?;
        fs::create_dir_all(root.join("tmp"))?;
        let connection = Connection::open(root.join("resources.sqlite"))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS resources (
                 id TEXT PRIMARY KEY,
                 sha256 TEXT NOT NULL,
                 filename TEXT NOT NULL,
                 media_type TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 size INTEGER NOT NULL,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS market_entries (
                 id TEXT NOT NULL,
                 version TEXT NOT NULL,
                 visibility TEXT NOT NULL,
                 payload TEXT NOT NULL,
                 PRIMARY KEY (id, version)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS market_entries_fts USING fts5(
                 id UNINDEXED,
                 version UNINDEXED,
                 name,
                 summary,
                 description,
                 keywords,
                 author
             );",
        )?;
        Ok(Self {
            root: Arc::new(root.to_path_buf()),
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn temp_path(&self) -> PathBuf {
        self.root.join("tmp").join(uuid::Uuid::new_v4().to_string())
    }

    pub fn blob_path(&self, sha256: &str) -> Result<PathBuf, StoreError> {
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StoreError::InvalidId);
        }
        Ok(self.root.join("blobs").join(&sha256[..2]).join(sha256))
    }

    pub fn resource_path(&self, resource: &ResourceRecord) -> Result<PathBuf, StoreError> {
        self.blob_path(&resource.sha256)
    }

    pub fn publish_blob(
        &self,
        temporary: &Path,
        filename: &str,
        media_type: &str,
        kind: &str,
        size: u64,
        sha256: &str,
    ) -> Result<ResourceRecord, StoreError> {
        let destination = self.blob_path(sha256)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if destination.exists() {
            let _ = fs::remove_file(temporary);
        } else {
            fs::rename(temporary, &destination)?;
        }
        let created_at = now_ms();
        let connection = self.connection.lock().map_err(|_| StoreError::Conflict)?;
        connection.execute(
            "INSERT OR IGNORE INTO resources (id, sha256, filename, media_type, kind, size, created_at) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![sha256, filename, media_type, kind, size as i64, created_at as i64],
        )?;
        read_resource(&connection, sha256)?.ok_or(StoreError::Missing)
    }

    pub fn resource(&self, id: &str) -> Result<ResourceRecord, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Conflict)?;
        read_resource(&connection, id)?.ok_or(StoreError::Missing)
    }

    pub fn insert_market_entry(&self, entry: &MarketEntry) -> Result<(), StoreError> {
        validate_market_entry(entry).map_err(|error| StoreError::Metadata(error.to_string()))?;
        let payload = serde_json::to_string(entry).map_err(|_| StoreError::Conflict)?;
        let visibility = match entry.visibility {
            Visibility::Market => "market",
            Visibility::Internal => "internal",
        };
        let connection = self.connection.lock().map_err(|_| StoreError::Conflict)?;
        let transaction = connection.unchecked_transaction()?;
        if transaction
            .query_row(
                "SELECT 1 FROM market_entries WHERE id = ?1 AND version = ?2",
                params![entry.id, entry.version],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(StoreError::Conflict);
        }
        transaction.execute(
            "INSERT INTO market_entries (id, version, visibility, payload) VALUES (?1, ?2, ?3, ?4)",
            params![entry.id, entry.version, visibility, payload],
        )?;
        transaction.execute(
            "INSERT INTO market_entries_fts (id, version, name, summary, description, keywords, author) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![entry.id, entry.version, entry.name, entry.summary, entry.description, entry.keywords.join(" "), entry.author.as_deref().unwrap_or("")],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_market_entry(&self, id: &str, version: &str) -> Result<bool, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Conflict)?;
        let transaction = connection.unchecked_transaction()?;
        let removed = transaction.execute(
            "DELETE FROM market_entries WHERE id = ?1 AND version = ?2",
            params![id, version],
        )?;
        if removed > 0 {
            transaction.execute(
                "DELETE FROM market_entries_fts WHERE id = ?1 AND version = ?2",
                params![id, version],
            )?;
        }
        transaction.commit()?;
        Ok(removed > 0)
    }

    pub fn catalog(&self, query: &CatalogQuery) -> Result<CatalogResult, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Conflict)?;
        let payloads = if let Some(text) = query
            .q
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let search = fts_search_query(text);
            let mut statement = connection.prepare(
                "SELECT market_entries.payload
                 FROM market_entries
                 JOIN market_entries_fts ON market_entries_fts.id = market_entries.id
                    AND market_entries_fts.version = market_entries.version
                 WHERE market_entries_fts MATCH ?1
                 ORDER BY bm25(market_entries_fts)",
            )?;
            let rows = statement.query_map([search], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement =
                connection.prepare("SELECT payload FROM market_entries ORDER BY id, version")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut entries = Vec::new();
        for payload in payloads {
            let entry: MarketEntry =
                serde_json::from_str(&payload).map_err(|_| StoreError::Conflict)?;
            if matches_query(&entry, query) {
                entries.push(entry);
            }
        }
        if query
            .q
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            entries.sort_by_key(|entry| {
                std::cmp::Reverse(search_score(entry, query.q.as_deref().unwrap_or_default()))
            });
        }
        let total = entries.len();
        let (offset, limit) = query.bounds();
        let entries = entries.into_iter().skip(offset).take(limit).collect();
        Ok(CatalogResult {
            entries,
            total,
            offset,
            limit,
        })
    }
}

fn read_resource(connection: &Connection, id: &str) -> Result<Option<ResourceRecord>, StoreError> {
    connection
        .query_row(
            "SELECT id, sha256, filename, media_type, kind, size, created_at FROM resources WHERE id = ?1",
            params![id],
            |row| {
                Ok(ResourceRecord {
                    id: row.get(0)?,
                    sha256: row.get(1)?,
                    filename: row.get(2)?,
                    media_type: row.get(3)?,
                    kind: row.get(4)?,
                    size: row.get::<_, i64>(5)? as u64,
                    created_at: row.get::<_, i64>(6)? as u64,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
}

fn matches_query(entry: &MarketEntry, query: &CatalogQuery) -> bool {
    if matches!(entry.visibility, Visibility::Internal) {
        return false;
    }
    if let Some(kind) = &query.kind {
        if entry.kind.as_str() != kind {
            return false;
        }
    }
    if let Some(category) = &query.category {
        let wanted = category.split(',').filter(|value| !value.is_empty());
        if wanted
            .clone()
            .any(|value| !entry.categories.iter().any(|item| item == value))
        {
            return false;
        }
    }
    if let Some(scope) = &query.applies_to {
        if !entry.applies_to.iter().any(|item| item == scope) {
            return false;
        }
    }
    if let Some(mcp) = &query.supports_mcp {
        if entry.supports_mcp.as_str() != mcp {
            return false;
        }
    }
    if query
        .supports_agent
        .is_some_and(|value| value != entry.supports_agent)
    {
        return false;
    }
    if let Some(policy) = &query.restart_policy {
        if entry.restart_policy.as_str() != policy {
            return false;
        }
    }
    if query.platform.as_ref().is_some_and(|value| {
        !entry.platforms.is_empty() && !entry.platforms.iter().any(|item| item == value)
    }) {
        return false;
    }
    if query.architecture.as_ref().is_some_and(|value| {
        !entry.architectures.is_empty() && !entry.architectures.iter().any(|item| item == value)
    }) {
        return false;
    }
    if let Some(text) = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let needle = text.to_lowercase();
        let haystack = [
            entry.name.to_lowercase(),
            entry.summary.to_lowercase(),
            entry.description.to_lowercase(),
            entry.keywords.join(" ").to_lowercase(),
            entry.author.clone().unwrap_or_default().to_lowercase(),
        ]
        .join(" ");
        if !haystack.contains(&needle) {
            return false;
        }
    }
    true
}

fn fts_search_query(text: &str) -> String {
    text.split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn search_score(entry: &MarketEntry, query: &str) -> u8 {
    let needle = query.trim().to_lowercase();
    let name = entry.name.to_lowercase();
    if name == needle {
        return 5;
    }
    if name.starts_with(&needle) {
        return 4;
    }
    if entry
        .keywords
        .iter()
        .any(|keyword| keyword.to_lowercase().contains(&needle))
    {
        return 3;
    }
    if entry.summary.to_lowercase().contains(&needle) {
        return 2;
    }
    1
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
