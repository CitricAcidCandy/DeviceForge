use crate::model::{AssistantInput, PROMPT_CHAR_LIMIT, TEXT_BYTE_LIMIT};
use serde::Deserialize;
use serde_json::{Value, json};

pub const MAX_TURNS: u8 = 4;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredAnswer {
    is_final: bool,
    final_answer: String,
    #[serde(default)]
    next_step: String,
    #[serde(default)]
    missing_info: String,
}

pub enum Next {
    Final(String),
    Continue(String),
}

pub struct Plan {
    completed: u8,
}

pub fn schema() -> Value {
    json!({
        "type":"object",
        "properties":{
            "is_final":{"type":"boolean"}, "final_answer":{"type":"string"},
            "next_step":{"type":"string"}, "missing_info":{"type":"string"}
        },
        "required":["is_final","final_answer"], "additionalProperties":false
    })
}

pub fn task_prompt(input: &AssistantInput) -> String {
    match input
        .user_prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        Some(prompt) => format!("multi-agent-orchestrator\n\n{prompt}"),
        None => "multi-agent-orchestrator".into(),
    }
}

fn prompt(task: &str, hint: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    if !task.trim().is_empty() {
        parts.push(format!("User task:\n{}", task.trim()));
    }
    if !hint.trim().is_empty() {
        parts.push(format!("Context from previous turn:\n{}", hint.trim()));
    }
    parts.extend([
        "You must continue executing the task in this turn.".into(),
        "Return JSON only with keys: is_final(boolean), final_answer(string), next_step(string), missing_info(string).".into(),
        "When all work is complete, set is_final=true and final_answer to the complete final response for the user.".into(),
        "When work is not complete yet, set is_final=false and explain next_step/missing_info.".into(),
    ]);
    let combined = parts.join("\n\n");
    if combined.chars().count() > PROMPT_CHAR_LIMIT {
        return Err("测试助手组合提示词超过字符限额".into());
    }
    Ok(combined)
}

impl Plan {
    pub fn new(input: &AssistantInput) -> Result<(Self, String), String> {
        Ok((Self { completed: 0 }, prompt(&task_prompt(input), "")?))
    }

    pub fn advance(&mut self, text: &str) -> Result<Next, String> {
        if self.completed >= MAX_TURNS || text.len() > TEXT_BYTE_LIMIT {
            return Err("测试助手轮次或回答超限".into());
        }
        self.completed += 1;
        let answer: StructuredAnswer =
            serde_json::from_str(text).map_err(|_| "测试助手回答不符合固定schema")?;
        if answer.is_final && !answer.final_answer.trim().is_empty() {
            return Ok(Next::Final(answer.final_answer.trim().into()));
        }
        if self.completed == MAX_TURNS {
            return Err("测试助手四轮内没有完整最终回答".into());
        }
        let hint = [
            &answer.next_step,
            &answer.missing_info,
            &answer.final_answer,
        ]
        .into_iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
        Ok(Next::Continue(prompt(
            "",
            if hint.is_empty() {
                "No final answer was produced in previous turn."
            } else {
                &hint
            },
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> AssistantInput {
        AssistantInput {
            project_id: "demo".into(),
            user_prompt: Some("生成用例".into()),
            stream_output: false,
        }
    }

    #[test]
    fn helper_preserves_prefix_schema_and_four_turn_boundary() {
        let (mut plan, first) = Plan::new(&input()).unwrap();
        assert!(first.contains("multi-agent-orchestrator\n\n生成用例"));
        assert_eq!(schema()["properties"]["missing_info"]["type"], "string");
        for _round in 0..3 {
            let Next::Continue(next) = plan.advance(r#"{"is_final":false,"final_answer":"","next_step":"继续","missing_info":"设备"}"#).unwrap() else { panic!("助手过早完成") };
            assert!(next.contains("继续 | 设备"));
            assert!(!next.contains("User task:"));
        }
        assert!(
            plan.advance(r#"{"is_final":false,"final_answer":""}"#)
                .is_err()
        );
    }

    #[test]
    fn malformed_schema_is_a_failure_and_complete_answer_stops() {
        for text in [
            r#"{"is_final":"true","final_answer":"回答"}"#,
            r#"{"is_final":true,"final_answer":"回答","extra":0}"#,
            "非JSON",
        ] {
            let (mut plan, _) = Plan::new(&input()).unwrap();
            assert!(plan.advance(text).is_err());
        }
        let (mut plan, _) = Plan::new(&input()).unwrap();
        let Next::Final(answer) = plan
            .advance(r#"{"is_final":true,"final_answer":" 回答 "}"#)
            .unwrap()
        else {
            panic!("完整回答未结束")
        };
        assert_eq!(answer, "回答");
    }
}
