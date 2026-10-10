//! 内存 JobStore 只实现合法状态流与终态 CAS，不实现宿主期限或成功资格策略。
use super::gate::Gate;
use apk_domain::{Error, Job, JobEvent, JobStatus, JobStore, Result};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
struct State {
    jobs: BTreeMap<String, Job>,
    events: Vec<JobEvent>,
    attempts: Vec<(String, JobStatus)>,
}

#[derive(Default)]
pub struct Store {
    state: Mutex<State>,
    pub creating: Gate,
    pub running_written: Gate,
    pub success_started: Gate,
    pub cancellation_started: Gate,
    pub listing: Gate,
}

impl Store {
    pub fn release_all(&self) {
        self.creating.release();
        self.running_written.release();
        self.success_started.release();
        self.cancellation_started.release();
        self.listing.release();
    }

    pub fn attempts(&self, id: &str, status: JobStatus) -> usize {
        self.state
            .lock()
            .unwrap()
            .attempts
            .iter()
            .filter(|(candidate, attempted)| candidate == id && attempted == &status)
            .count()
    }

    pub fn jobs(&self) -> Vec<Job> {
        self.state.lock().unwrap().jobs.values().cloned().collect()
    }

    fn event(state: &mut State, job: &Job) {
        state.events.push(JobEvent {
            sequence: state.events.len() as u64 + 1,
            job_id: job.id.clone(),
            status: job.status.clone(),
            timestamp: apk_domain::now(),
        });
    }
}

impl JobStore for Store {
    fn create(&self, job: &Job) -> Result<()> {
        // 门闩到达说明不可中断的真实 create 已开始，而非还在等存储槽。
        self.creating.wait("创建已开始")?;
        let mut state = self.state.lock().unwrap();
        if state.jobs.contains_key(&job.id) {
            return Err(Error::Conflict("测试任务 ID 重复".into()));
        }
        if job.status != JobStatus::Queued {
            return Err(Error::Invalid("新任务必须为排队状态".into()));
        }
        state.jobs.insert(job.id.clone(), job.clone());
        Self::event(&mut state, job);
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Job> {
        self.state
            .lock()
            .unwrap()
            .jobs
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound(id.into()))
    }

    fn list(&self, limit: usize) -> Result<Vec<Job>> {
        self.listing.wait("列表占用存储槽")?;
        Ok(self
            .state
            .lock()
            .unwrap()
            .jobs
            .values()
            .take(limit)
            .cloned()
            .collect())
    }

    fn transition(
        &self,
        id: &str,
        status: JobStatus,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<Job> {
        self.state
            .lock()
            .unwrap()
            .attempts
            .push((id.into(), status.clone()));
        if status == JobStatus::Succeeded {
            // 此时应用已取得成功资格，并已进入不可中断的存储副作用。
            self.success_started.wait("成功提交事务已开始")?;
        }
        if status == JobStatus::Cancelled {
            self.cancellation_started.wait("取消提交事务已开始")?;
        }
        let changed = {
            let mut state = self.state.lock().unwrap();
            let current = state
                .jobs
                .get(id)
                .cloned()
                .ok_or_else(|| Error::NotFound(id.into()))?;
            if current.status.is_terminal() {
                return Ok(current);
            }
            let legal = matches!(
                (&current.status, &status),
                (
                    JobStatus::Queued,
                    JobStatus::Running | JobStatus::Failed | JobStatus::Cancelled
                ) | (
                    JobStatus::Running,
                    JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled
                )
            );
            if !legal {
                return Err(Error::Conflict("测试存储拒绝非法状态转换".into()));
            }
            let mut updated = current;
            updated.status = status.clone();
            updated.result = result;
            updated.error = error;
            state.jobs.insert(id.into(), updated.clone());
            Self::event(&mut state, &updated);
            updated
        };
        if status == JobStatus::Running {
            // 已真实写入 Running 后才暂停返回，不以收到转换请求冒充已写入。
            self.running_written.wait("运行状态已写入")?;
        }
        Ok(changed)
    }

    fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>> {
        let state = self.state.lock().unwrap();
        if !state.jobs.contains_key(id) {
            return Err(Error::NotFound(id.into()));
        }
        Ok(state
            .events
            .iter()
            .filter(|event| event.job_id == id && event.sequence > after)
            .cloned()
            .collect())
    }

    fn recover(&self) -> Result<()> {
        Ok(())
    }
}
