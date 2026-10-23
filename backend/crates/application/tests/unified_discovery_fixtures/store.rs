//! 内存 JobStore 与同步存储门闩；只模拟端口，不改应用的期限和终态规则。
use apk_domain::{Error, Job, JobEvent, JobStatus, JobStore, Result};
use serde_json::Value;
use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Create,
    Running,
    BeforeSuccess,
    AfterSuccess,
}

#[derive(Default)]
pub struct Gate {
    state: Mutex<(Option<String>, bool)>,
    changed: Condvar,
}
impl Gate {
    pub fn reached(&self) -> Option<String> {
        self.state.lock().unwrap().0.clone()
    }
    pub fn release(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
    fn wait(&self, id: &str) -> Result<()> {
        let until = Instant::now() + Duration::from_secs(12);
        let mut state = self.state.lock().unwrap();
        state.0 = Some(id.into());
        self.changed.notify_all();
        while !state.1 {
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Error::Storage("测试存储门闩未释放".into()));
            }
            state = self.changed.wait_timeout(state, remaining).unwrap().0;
        }
        Ok(())
    }
}

struct Rule {
    operation: String,
    phase: Phase,
    gate: Arc<Gate>,
    consumed: bool,
}
#[derive(Default)]
struct Data {
    jobs: Vec<Job>,
    events: Vec<JobEvent>,
}
#[derive(Default)]
pub struct Store {
    data: Mutex<Data>,
    rules: Mutex<Vec<Rule>>,
    fail_success: AtomicBool,
    cancelled_success: AtomicBool,
}
impl Store {
    pub fn hold(&self, operation: &str, phase: Phase) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        self.rules.lock().unwrap().push(Rule {
            operation: operation.into(),
            phase,
            gate: gate.clone(),
            consumed: false,
        });
        gate
    }
    pub fn release_all(&self) {
        for rule in self.rules.lock().unwrap().iter() {
            rule.gate.release();
        }
    }
    pub fn fail_next_success(&self) {
        self.fail_success.store(true, Ordering::SeqCst);
    }
    pub fn return_cancelled_for_success(&self) {
        self.cancelled_success.store(true, Ordering::SeqCst);
    }
    pub fn jobs(&self) -> Vec<Job> {
        self.data.lock().unwrap().jobs.clone()
    }
    fn pass(&self, operation: &str, id: &str, phase: Phase) -> Result<()> {
        let gate = {
            let mut rules = self.rules.lock().unwrap();
            rules
                .iter_mut()
                .find(|rule| !rule.consumed && rule.operation == operation && rule.phase == phase)
                .map(|rule| {
                    rule.consumed = true;
                    rule.gate.clone()
                })
        };
        if let Some(gate) = gate {
            gate.wait(id)?;
        }
        Ok(())
    }
    fn event(data: &mut Data, id: &str, status: JobStatus) {
        data.events.push(JobEvent {
            sequence: data.events.len() as u64 + 1,
            job_id: id.into(),
            status,
            timestamp: apk_domain::now(),
            progress: None,
        });
    }
}

impl JobStore for Store {
    fn create(&self, job: &Job) -> Result<()> {
        self.pass(&job.operation, &job.id, Phase::Create)?;
        let mut data = self.data.lock().unwrap();
        if data.jobs.iter().any(|old| old.id == job.id) {
            return Err(Error::Conflict("测试重复 Job".into()));
        }
        data.jobs.push(job.clone());
        Self::event(&mut data, &job.id, job.status.clone());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<Job> {
        self.data
            .lock()
            .unwrap()
            .jobs
            .iter()
            .find(|job| job.id == id)
            .cloned()
            .ok_or_else(|| Error::NotFound(id.into()))
    }
    fn list(&self, limit: usize) -> Result<Vec<Job>> {
        Ok(self
            .data
            .lock()
            .unwrap()
            .jobs
            .iter()
            .rev()
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
        let old = self.get(id)?;
        if status == JobStatus::Running {
            self.pass(&old.operation, id, Phase::Running)?;
        }
        if status == JobStatus::Succeeded {
            self.pass(&old.operation, id, Phase::BeforeSuccess)?;
            if self.fail_success.swap(false, Ordering::SeqCst) {
                return Err(Error::Storage("受控成功存储失败".into()));
            }
        }
        let actual = {
            let mut data = self.data.lock().unwrap();
            let index = data
                .jobs
                .iter()
                .position(|job| job.id == id)
                .ok_or_else(|| Error::NotFound(id.into()))?;
            if data.jobs[index].status.is_terminal() {
                data.jobs[index].clone()
            } else {
                let status = if status == JobStatus::Succeeded
                    && self.cancelled_success.swap(false, Ordering::SeqCst)
                {
                    JobStatus::Cancelled
                } else {
                    status
                };
                let job = &mut data.jobs[index];
                job.status = status.clone();
                job.result = if status == JobStatus::Succeeded {
                    result
                } else {
                    None
                };
                job.error = error;
                let actual = job.clone();
                Self::event(&mut data, id, status);
                actual
            }
        };
        // 已经写入真实终态，但调用返回尚未发生，构造 Pending 发布窗口。
        if actual.status == JobStatus::Succeeded {
            self.pass(&old.operation, id, Phase::AfterSuccess)?;
        }
        Ok(actual)
    }
    fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>> {
        self.get(id)?;
        Ok(self
            .data
            .lock()
            .unwrap()
            .events
            .iter()
            .filter(|event| event.job_id == id && event.sequence > after)
            .cloned()
            .collect())
    }
    fn recover(&self) -> Result<()> {
        let mut data = self.data.lock().unwrap();
        let unfinished = data
            .jobs
            .iter()
            .filter(|job| !job.status.is_terminal())
            .map(|job| job.id.clone())
            .collect::<Vec<_>>();
        for id in unfinished {
            let job = data.jobs.iter_mut().find(|job| job.id == id).unwrap();
            job.status = JobStatus::Failed;
            job.error = Some("受控重启未续跑".into());
            Self::event(&mut data, &id, JobStatus::Failed);
        }
        Ok(())
    }
}
