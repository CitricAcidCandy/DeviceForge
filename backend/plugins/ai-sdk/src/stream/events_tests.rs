use super::*;
use crate::config::Config;

const THREAD: &str = "abcdef12-1234-1234-1234-123456789abc";

fn events() -> Events {
    let root = std::env::temp_dir().join("deviceforge-sdk-public-event-test");
    let config = Config::parse(&serde_json::to_vec(&json!({
        "format_version":1,"profile":crate::model::PROFILE,
        "node_executable":root.join("node"),"node_version":crate::model::NODE_VERSION,
        "sdk_entry":root.join("sdk/index.js"),"sdk_version":crate::model::SDK_VERSION,
        "cli_executable":root.join("cli"),"cli_version":crate::model::SDK_VERSION,
        "projects":{"demo":root.join("project")},"state_root":root.join("state"),
        "codex_home":root.join("home"),"environment":{"SDK_TEST_SECRET":"credential-value"},"thread_options":{}
    })).unwrap()).unwrap();
    Events::new(None, Redactor::for_config(&config)).unwrap()
}

fn feed(events: &mut Events, value: Value) -> Option<Value> {
    events.event(&serde_json::to_vec(&value).unwrap()).unwrap()
}

#[test]
fn safe_snapshots_use_stable_aliases_and_success_is_delayed() {
    let mut events = events();
    feed(
        &mut events,
        json!({"type":"thread.started","thread_id":THREAD}),
    );
    feed(&mut events, json!({"type":"turn.started"}));
    let started = feed(&mut events, json!({"type":"item.started","item":{"id":"raw:provider:id","type":"command_execution","command":"secret command","cwd":"private path","status":"in_progress"}})).unwrap();
    let completed = feed(&mut events, json!({"type":"item.completed","item":{"id":"raw:provider:id","type":"command_execution","command":"secret command","aggregated_output":"credential-value","status":"completed"}})).unwrap();
    assert_eq!(started["item"]["id"], "item_1");
    assert_eq!(completed["item"]["id"], "item_1");
    assert!(completed["item"].get("command").is_none());
    assert!(completed["item"].get("aggregated_output").is_none());
    let answer = feed(&mut events, json!({"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"credential-value已完成"}})).unwrap();
    assert_eq!(answer["item"]["text"], "[已隐藏]已完成");
    assert!(
        feed(
            &mut events,
            json!({"type":"turn.completed","usage":{"input_tokens":1}})
        )
        .is_none()
    );
    events
        .verify_candidate(THREAD, "credential-value已完成", 6)
        .unwrap();
    assert!(events.verify_candidate(THREAD, "伪造回答", 6).is_err());
    assert_eq!(events.finish().unwrap()["type"], "turn.completed");
    assert!(events.event(br#"{"type":"turn.started"}"#).is_err());
}

#[test]
fn uncertain_items_and_wrong_thread_cannot_finish_a_success() {
    let mut events = events();
    feed(
        &mut events,
        json!({"type":"thread.started","thread_id":THREAD}),
    );
    feed(&mut events, json!({"type":"turn.started"}));
    feed(
        &mut events,
        json!({"type":"item.started","item":{"id":"answer","type":"agent_message","text":"候选"}}),
    );
    assert!(events.event(br#"{"type":"turn.completed"}"#).is_err());
    assert!(events.finish().is_err());
    let mut restored = Events::new(Some(THREAD), events.redactor).unwrap();
    assert!(
        restored
            .event(
                br#"{"type":"thread.started","thread_id":"abcdef12-1234-1234-1234-123456789abd"}"#
            )
            .is_err()
    );
}
