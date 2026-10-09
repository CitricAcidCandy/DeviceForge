use apk_domain::{Error, Result, now, performance::*};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub struct SqlitePerformance {
    connection: Mutex<Connection>,
}
fn storage(error: impl std::fmt::Display) -> Error {
    Error::Storage(error.to_string())
}
fn encode<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(storage)
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(storage)
}
fn get(connection: &Connection, id: &str) -> Result<PerformanceSession> {
    let json: Option<String> = connection
        .query_row(
            "SELECT body FROM performance_sessions WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?;
    decode(&json.ok_or_else(|| Error::NotFound(id.into()))?)
}
fn save(connection: &Connection, session: &PerformanceSession) -> Result<()> {
    connection
        .execute(
            "UPDATE performance_sessions SET state=?2,body=?3 WHERE id=?1",
            params![session.id, session.state.key(), encode(session)?],
        )
        .map_err(storage)?;
    Ok(())
}
impl SqlitePerformance {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path).map_err(storage)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(2))
            .map_err(storage)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS performance_sessions(id TEXT PRIMARY KEY,state TEXT NOT NULL,body TEXT NOT NULL,last_raw TEXT);
            CREATE TABLE IF NOT EXISTS performance_readings(session_id TEXT NOT NULL REFERENCES performance_sessions(id),sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session_id,sequence));").map_err(storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| storage("性能数据库锁不可用"))
    }
}
impl PerformanceStore for SqlitePerformance {
    fn create(&self, session: PerformanceSession) -> Result<()> {
        session.request.validate()?;
        if session.state != PerformanceState::Running
            || session.samples != 0
            || session.revision != 0
        {
            return Err(Error::Invalid("性能会话初始状态无效".into()));
        }
        let connection = self.connection()?;
        connection
            .execute(
                "INSERT INTO performance_sessions(id,state,body) VALUES(?1,?2,?3)",
                params![session.id, session.state.key(), encode(&session)?],
            )
            .map_err(storage)?;
        Ok(())
    }
    fn get(&self, id: &str) -> Result<PerformanceSession> {
        get(&*self.connection()?, id)
    }
    fn transition(
        &self,
        id: &str,
        revision: u64,
        state: PerformanceState,
        error: Option<String>,
    ) -> Result<PerformanceSession> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage)?;
        let mut session = get(&transaction, id)?;
        if session.revision != revision {
            return Err(Error::Conflict("性能会话版本已变化".into()));
        }
        if !session.state.permits(state) {
            return Err(Error::Conflict("已结束的性能会话不能恢复".into()));
        }
        if session.state == state {
            return Ok(session);
        }
        session.state = state;
        session.error = error;
        session.revision = session
            .revision
            .checked_add(1)
            .ok_or_else(|| storage("性能版本溢出"))?;
        session.updated_at = now();
        save(&transaction, &session)?;
        // 暂停与恢复后的首个样本重新建立 CPU 基线。
        transaction
            .execute(
                "UPDATE performance_sessions SET last_raw=NULL WHERE id=?1",
                [id],
            )
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(session)
    }
    fn append(&self, id: &str, revision: u64, raw: RawPerformance) -> Result<bool> {
        raw.validate()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage)?;
        let mut session = get(&transaction, id)?;
        if session.state != PerformanceState::Running || session.revision != revision {
            return Ok(false);
        }
        if session.samples >= 3600 {
            return Err(Error::Conflict("会话已达到 3600 个样本上限".into()));
        }
        let previous: Option<String> = transaction
            .query_row(
                "SELECT last_raw FROM performance_sessions WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(storage)?;
        let previous: Option<RawPerformance> = previous.as_deref().map(decode).transpose()?;
        session.samples += 1;
        let reading = PerformanceReading::from_raw(session.samples, &raw, previous.as_ref());
        transaction
            .execute(
                "INSERT INTO performance_readings(session_id,sequence,body) VALUES(?1,?2,?3)",
                params![id, session.samples, encode(&reading)?],
            )
            .map_err(storage)?;
        session.updated_at = now();
        save(&transaction, &session)?;
        transaction
            .execute(
                "UPDATE performance_sessions SET last_raw=?2 WHERE id=?1",
                params![id, encode(&raw)?],
            )
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(true)
    }
    fn samples(&self, id: &str, after: u64, limit: u32) -> Result<PerformancePage> {
        if !(1..=100).contains(&limit) || after > i64::MAX as u64 {
            return Err(Error::Invalid("样本分页参数无效".into()));
        }
        let connection = self.connection()?;
        let session = get(&connection, id)?;
        let mut statement = connection.prepare("SELECT body FROM performance_readings WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3").map_err(storage)?;
        let readings: Vec<PerformanceReading> = statement
            .query_map(params![id, after, limit], |row| row.get::<_, String>(0))
            .map_err(storage)?
            .map(|row| decode(&row.map_err(storage)?))
            .collect::<Result<_>>()?;
        let next_after = readings.last().map_or(after, |value| value.sequence);
        Ok(PerformancePage {
            session,
            readings,
            next_after,
        })
    }
    fn list(&self, after_id: Option<&str>, limit: u32) -> Result<PerformanceSessions> {
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid("会话分页大小应为 1–100".into()));
        }
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT body FROM performance_sessions WHERE id>?1 ORDER BY id LIMIT ?2")
            .map_err(storage)?;
        let sessions: Vec<PerformanceSession> = statement
            .query_map(params![after_id.unwrap_or(""), limit], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage)?
            .map(|row| decode(&row.map_err(storage)?))
            .collect::<Result<_>>()?;
        let next_after_id = sessions.last().map(|value| value.id.clone());
        Ok(PerformanceSessions {
            sessions,
            next_after_id,
        })
    }
    fn recover(&self) -> Result<u64> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage)?;
        let mut count = 0;
        loop {
            let values: Vec<String> = {
                let mut statement = transaction.prepare("SELECT body FROM performance_sessions WHERE state IN ('running','paused') LIMIT 100").map_err(storage)?;
                statement
                    .query_map([], |row| row.get(0))
                    .map_err(storage)?
                    .collect::<std::result::Result<_, _>>()
                    .map_err(storage)?
            };
            if values.is_empty() {
                break;
            }
            for value in values {
                let mut session: PerformanceSession = decode(&value)?;
                session.state = PerformanceState::Interrupted;
                session.revision = session
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| storage("性能版本溢出"))?;
                session.updated_at = now();
                session.error = Some("服务器重启，性能采样已终止".into());
                save(&transaction, &session)?;
                count += 1;
            }
        }
        transaction.commit().map_err(storage)?;
        Ok(count)
    }
}
