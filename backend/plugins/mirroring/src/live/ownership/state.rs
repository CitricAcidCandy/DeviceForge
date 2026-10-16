use serde::{Deserialize, Serialize};

pub(super) const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(super) const PARTICIPANT_LIMIT: usize = 64;
pub(super) const REQUEST_LIMIT: usize = 32;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct State {
    pub version: u8,
    pub revision: u64,
    pub control_revision: u64,
    pub owner_id: Option<String>,
    pub target_id: Option<String>,
    pub recovery_id: Option<String>,
    pub transitioning: bool,
    pub blocked: bool,
    pub participants: Vec<Participant>,
    pub requests: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Participant {
    pub client_id: String,
    pub allowed: bool,
    pub master: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Request {
    pub client_id: String,
    pub is_master: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct View {
    pub version: u8,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub epoch: u8,
    pub revision: u64,
    pub control_revision: u64,
    pub client_id: String,
    pub owner_id: Option<String>,
    pub is_master: bool,
    pub can_control: bool,
    pub has_control: bool,
    pub transitioning: bool,
    pub blocked: bool,
    pub requests: Vec<Request>,
}

#[derive(Clone, Debug)]
pub enum Command {
    Request,
    Respond { client_id: String, accept: bool },
    Reclaim,
    Release,
}

pub(super) fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err("控制客户端或设备标识无效".into());
    }
    Ok(())
}

impl State {
    pub fn empty() -> Self {
        Self {
            version: 1,
            control_revision: 1,
            ..Self::default()
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.revision > SAFE_INTEGER
            || self.control_revision > SAFE_INTEGER
            || self.participants.len() > PARTICIPANT_LIMIT
            || self.requests.len() > REQUEST_LIMIT
            || (!self.transitioning && self.target_id.is_some())
            || (self.transitioning && self.owner_id.is_none())
            || (!self.blocked && self.recovery_id.is_some())
        {
            return Err("设备控制协调状态无效或超限".into());
        }
        let mut clients = std::collections::HashSet::new();
        for participant in &self.participants {
            identifier(&participant.client_id)?;
            if !clients.insert(&participant.client_id) {
                return Err("设备控制客户端重复".into());
            }
        }
        let mut requests = std::collections::HashSet::new();
        for client in &self.requests {
            if !requests.insert(client)
                || !self
                    .participants
                    .iter()
                    .any(|entry| entry.client_id == *client && entry.allowed)
            {
                return Err("设备控制申请归属无效".into());
            }
        }
        for client in [&self.owner_id, &self.target_id, &self.recovery_id]
            .into_iter()
            .flatten()
        {
            identifier(client)?;
        }
        if let Some(target) = &self.target_id
            && !self
                .participants
                .iter()
                .any(|entry| entry.client_id == *target && entry.allowed)
        {
            return Err("设备控制移交目标无效".into());
        }
        if !self.blocked
            && let Some(owner) = &self.owner_id
            && !self
                .participants
                .iter()
                .any(|entry| entry.client_id == *owner && entry.allowed)
        {
            return Err("设备控制持有人归属无效".into());
        }
        if let Some(client) = &self.recovery_id
            && !self
                .participant(client)
                .is_some_and(|entry| entry.allowed && entry.master)
        {
            return Err("设备控制故障恢复归属无效".into());
        }
        Ok(())
    }

    pub fn changed(&mut self) -> Result<(), String> {
        self.revision = self
            .revision
            .checked_add(1)
            .filter(|value| *value <= SAFE_INTEGER)
            .ok_or("设备控制修订序号已耗尽")?;
        Ok(())
    }

    pub fn changed_from(&mut self, previous: &Self) -> Result<(), String> {
        if self.owner_id != previous.owner_id
            || self.transitioning != previous.transitioning
            || self.blocked != previous.blocked
        {
            self.control_revision = self
                .control_revision
                .checked_add(1)
                .filter(|value| *value <= SAFE_INTEGER)
                .ok_or("设备控制输入代次已耗尽")?;
        }
        self.changed()
    }

    pub fn participant(&self, client_id: &str) -> Option<&Participant> {
        self.participants
            .iter()
            .find(|entry| entry.client_id == client_id)
    }

    pub fn view(&self, client_id: &str) -> View {
        let participant = self.participant(client_id);
        View {
            version: 1,
            kind: "control_state",
            epoch: 1,
            revision: self.revision,
            control_revision: self.control_revision,
            client_id: client_id.into(),
            owner_id: self.owner_id.clone(),
            is_master: participant.is_some_and(|entry| entry.master),
            can_control: participant.is_some_and(|entry| entry.allowed),
            has_control: self.is_owner(client_id),
            transitioning: self.transitioning,
            blocked: self.blocked,
            requests: self
                .requests
                .iter()
                .filter_map(|client| self.participant(client))
                .map(|entry| Request {
                    client_id: entry.client_id.clone(),
                    is_master: entry.master,
                })
                .collect(),
        }
    }

    pub fn is_owner(&self, client_id: &str) -> bool {
        self.owner_id.as_deref() == Some(client_id)
            && !self.transitioning
            && !self.blocked
            && self
                .participant(client_id)
                .is_some_and(|entry| entry.allowed)
    }
}
