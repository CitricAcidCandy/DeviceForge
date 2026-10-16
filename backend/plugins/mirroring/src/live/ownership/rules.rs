use super::state::{Command, PARTICIPANT_LIMIT, Participant, REQUEST_LIMIT, State};

impl State {
    pub fn register(&mut self, client_id: &str, allowed: bool, master: bool) -> Result<(), String> {
        let before = self.clone();
        if self.participant(client_id).is_some() {
            return Err("设备控制客户端已经注册".into());
        }
        if self.participants.len() >= PARTICIPANT_LIMIT {
            return Err("设备投屏参与者已达上限".into());
        }
        self.participants.push(Participant {
            client_id: client_id.into(),
            allowed,
            master,
        });
        if allowed && self.owner_id.is_none() && !self.blocked && !self.transitioning {
            self.owner_id = Some(client_id.into());
        }
        self.changed_from(&before)
    }

    pub fn command(&mut self, client_id: &str, command: Command) -> Result<(), String> {
        let before = self.clone();
        let participant = self
            .participant(client_id)
            .ok_or("设备控制客户端尚未注册")?;
        if !participant.allowed {
            return Err("当前分享只允许观看".into());
        }
        match command {
            Command::Request => {
                if self.blocked {
                    return Err("设备控制资源失联，等待主控恢复".into());
                }
                if self.owner_id.is_none() && !self.transitioning {
                    self.owner_id = Some(client_id.into());
                    self.requests.retain(|entry| entry != client_id);
                } else {
                    if self.owner_id.as_deref() == Some(client_id)
                        || self.requests.iter().any(|entry| entry == client_id)
                    {
                        return Ok(());
                    }
                    if self.requests.len() >= REQUEST_LIMIT {
                        return Err("设备控制申请已达上限".into());
                    }
                    self.requests.push(client_id.into());
                }
            }
            Command::Respond {
                client_id: target,
                accept,
            } => {
                if !self.is_owner(client_id) {
                    return Err("只有当前持有人可以处理控制申请".into());
                }
                let Some(position) = self.requests.iter().position(|entry| *entry == target) else {
                    return Err("对应设备控制申请不存在".into());
                };
                self.requests.remove(position);
                if accept {
                    self.transitioning = true;
                    self.target_id = Some(target);
                }
            }
            Command::Reclaim => {
                if !participant.master {
                    return Err("只有服务器主控可以强制接管".into());
                }
                if self.blocked {
                    if self
                        .owner_id
                        .as_deref()
                        .is_some_and(|owner| self.participant(owner).is_some())
                    {
                        return Err("旧控制会话仍在线且资源未确认释放".into());
                    }
                    self.recovery_id = Some(client_id.into());
                } else if self.owner_id.as_deref() == Some(client_id) {
                    if !self.transitioning {
                        return Ok(());
                    }
                    self.target_id = Some(client_id.into());
                } else if self.owner_id.is_none() {
                    self.owner_id = Some(client_id.into());
                } else {
                    self.transitioning = true;
                    self.target_id = Some(client_id.into());
                }
                self.requests.retain(|entry| entry != client_id);
            }
            Command::Release => {
                if !self.is_owner(client_id) {
                    return Err("只有当前持有人可以释放控制权".into());
                }
                self.transitioning = true;
                self.target_id = None;
            }
        }
        self.changed_from(&before)
    }

    pub fn finish_handoff(&mut self, client_id: &str) -> Result<(), String> {
        let before = self.clone();
        if self.owner_id.as_deref() != Some(client_id) || !self.transitioning || self.blocked {
            return Err("当前会话没有待完成的设备控制移交".into());
        }
        self.owner_id = self
            .target_id
            .take()
            .filter(|target| self.participant(target).is_some_and(|entry| entry.allowed));
        self.requests
            .retain(|entry| self.owner_id.as_ref() != Some(entry));
        self.transitioning = false;
        self.changed_from(&before)
    }

    pub fn unregister(&mut self, client_id: &str, clean: bool) -> Result<(), String> {
        let before = self.clone();
        if self.owner_id.as_deref() == Some(client_id) {
            if clean {
                self.owner_id = if self.transitioning {
                    self.target_id.take().filter(|target| target != client_id)
                } else {
                    None
                };
                self.transitioning = false;
                self.blocked = false;
                self.recovery_id = None;
            } else {
                self.blocked = true;
                self.transitioning = false;
                self.target_id = None;
                self.recovery_id = None;
            }
        }
        if self.target_id.as_deref() == Some(client_id) {
            self.target_id = None;
        }
        if self.recovery_id.as_deref() == Some(client_id) {
            self.recovery_id = None;
        }
        self.participants
            .retain(|entry| entry.client_id != client_id);
        self.requests.retain(|entry| entry != client_id);
        if *self != before {
            self.changed_from(&before)?;
        }
        Ok(())
    }

    pub fn prune(&mut self, dead: &[String]) -> Result<(), String> {
        let before = self.clone();
        if self
            .owner_id
            .as_ref()
            .is_some_and(|owner| dead.contains(owner))
        {
            self.blocked = true;
            self.transitioning = false;
            self.target_id = None;
        }
        if self
            .target_id
            .as_ref()
            .is_some_and(|target| dead.contains(target))
        {
            self.target_id = None;
        }
        if self
            .recovery_id
            .as_ref()
            .is_some_and(|target| dead.contains(target))
        {
            self.recovery_id = None;
        }
        self.participants
            .retain(|entry| !dead.contains(&entry.client_id));
        self.requests.retain(|entry| !dead.contains(entry));
        if *self != before {
            self.changed_from(&before)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn finish_recovery(&mut self, client_id: &str) -> Result<(), String> {
        let before = self.clone();
        if !self.blocked
            || self.recovery_id.as_deref() != Some(client_id)
            || !self
                .participant(client_id)
                .is_some_and(|entry| entry.allowed && entry.master)
        {
            return Err("当前会话没有待确认的设备控制恢复".into());
        }
        self.owner_id = Some(client_id.into());
        self.target_id = None;
        self.recovery_id = None;
        self.transitioning = false;
        self.blocked = false;
        self.changed_from(&before)
    }
}
