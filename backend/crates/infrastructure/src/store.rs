use apk_domain::{Error, Job, JobEvent, JobStatus, JobStore, Result, now};
use rusqlite::{Connection, params};
use serde_json::Value;
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub struct SqliteStore(Mutex<Connection>);
fn storage(e: impl std::fmt::Display) -> Error {
    Error::Storage(e.to_string())
}
impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path).map_err(storage)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS events_job ON events(job_id,sequence);").map_err(storage)?;
        Ok(Self(Mutex::new(connection)))
    }
    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.0.lock().map_err(storage)
    }
}
fn read_job(connection: &Connection, id: &str) -> Result<Job> {
    let body: String = connection
        .query_row("SELECT body FROM jobs WHERE id=?1", [id], |r| r.get(0))
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Error::NotFound(id.into()),
            _ => storage(e),
        })?;
    serde_json::from_str(&body).map_err(storage)
}
fn event(connection: &Connection, job: &Job) -> Result<()> {
    let body = serde_json::to_string(&JobEvent {
        sequence: 0,
        job_id: job.id.clone(),
        status: job.status.clone(),
        timestamp: now(),
    })
    .map_err(storage)?;
    connection
        .execute(
            "INSERT INTO events(job_id,body) VALUES(?1,?2)",
            params![job.id, body],
        )
        .map_err(storage)?;
    Ok(())
}
impl JobStore for SqliteStore {
    fn create(&self, job: &Job) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(storage)?;
        tx.execute(
            "INSERT INTO jobs(id,body) VALUES(?1,?2)",
            params![job.id, serde_json::to_string(job).map_err(storage)?],
        )
        .map_err(storage)?;
        event(&tx, job)?;
        tx.commit().map_err(storage)
    }
    fn get(&self, id: &str) -> Result<Job> {
        read_job(&*self.lock()?, id)
    }
    fn list(&self, limit: usize) -> Result<Vec<Job>> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT body FROM jobs ORDER BY rowid DESC LIMIT ?1")
            .map_err(storage)?;
        let rows = statement
            .query_map([limit.min(200) as u64], |r| r.get::<_, String>(0))
            .map_err(storage)?;
        rows.map(|r| serde_json::from_str(&r.map_err(storage)?).map_err(storage))
            .collect()
    }
    fn transition(
        &self,
        id: &str,
        status: JobStatus,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<Job> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(storage)?;
        let mut job = read_job(&tx, id)?;
        if job.status.is_terminal() {
            return Ok(job);
        }
        let allowed = match job.status {
            JobStatus::Queued => matches!(
                status,
                JobStatus::Running | JobStatus::Cancelled | JobStatus::Failed
            ),
            JobStatus::Running => status.is_terminal(),
            _ => false,
        };
        if !allowed {
            return Err(Error::Conflict("任务状态不可按此方向流转".into()));
        }
        job.status = status;
        job.result = result;
        job.error = error;
        tx.execute(
            "UPDATE jobs SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&job).map_err(storage)?],
        )
        .map_err(storage)?;
        event(&tx, &job)?;
        tx.commit().map_err(storage)?;
        Ok(job)
    }
    fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>> {
        let connection = self.lock()?;
        read_job(&connection, id)?;
        let mut statement = connection.prepare("SELECT sequence, body FROM events WHERE job_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 200").map_err(storage)?;
        let rows = statement
            .query_map(params![id, after], |r| {
                Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(storage)?;
        rows.map(|row| {
            let (sequence, body) = row.map_err(storage)?;
            let mut value: JobEvent = serde_json::from_str(&body).map_err(storage)?;
            value.sequence = sequence;
            Ok(value)
        })
        .collect()
    }
    fn recover(&self) -> Result<()> {
        let ids: Vec<String> = {
            let connection = self.lock()?;
            let mut statement = connection
                .prepare("SELECT body FROM jobs")
                .map_err(storage)?;
            let rows = statement
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(storage)?;
            let jobs: Result<Vec<Job>> = rows
                .map(|r| serde_json::from_str(&r.map_err(storage)?).map_err(storage))
                .collect();
            jobs?
                .into_iter()
                .filter(|j| !j.status.is_terminal())
                .map(|j| j.id)
                .collect()
        };
        for id in ids {
            self.transition(
                &id,
                JobStatus::Failed,
                None,
                Some("服务重启中断了任务，请重新提交".into()),
            )?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn job(id: &str) -> Job {
        Job {
            id: id.into(),
            operation: "test".into(),
            input: Value::Null,
            status: JobStatus::Queued,
            result: None,
            error: None,
            created_at: now(),
        }
    }
    #[test]
    fn terminal_state_and_event_cursor() {
        let store = SqliteStore::open(":memory:").unwrap();
        store.create(&job("a")).unwrap();
        store
            .transition("a", JobStatus::Cancelled, None, None)
            .unwrap();
        assert_eq!(
            store
                .transition("a", JobStatus::Succeeded, Some(Value::Bool(true)), None)
                .unwrap()
                .status,
            JobStatus::Cancelled
        );
        let events = store.events("a", 0).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(store.events("a", events[0].sequence).unwrap().len(), 1);
    }
    #[test]
    fn reopen_and_recover_more_than_one_page() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jobs.db");
        {
            let store = SqliteStore::open(&path).unwrap();
            for i in 0..205 {
                store.create(&job(&i.to_string())).unwrap();
            }
        }
        let store = SqliteStore::open(&path).unwrap();
        store.recover().unwrap();
        assert_eq!(store.get("0").unwrap().status, JobStatus::Failed);
        assert_eq!(store.get("204").unwrap().status, JobStatus::Failed);
    }
}
