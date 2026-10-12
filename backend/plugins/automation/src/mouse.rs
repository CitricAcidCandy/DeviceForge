//! 按同一总期限派发点击；F9只在本次重复任务期间轮询。
use crate::{
    Result,
    control::Control,
    input::{MouseClick, MouseRepeat, Repeat},
    native,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::Instant;
pub(crate) fn position(control: &Control) -> Result<Value> {
    control.check()?;
    let position = native::position()?;
    Ok(
        json!({"x":position.x,"y":position.y,"coordinate_space":"virtual_desktop","source":"GetCursorPos"}),
    )
}
pub(crate) fn click(control: &Control, input: MouseClick) -> Result<Value> {
    control.check()?;
    let position = native::prepare(input.position)?;
    control.check()?;
    if let Err(error) = native::click(input.button, input.click) {
        if matches!(error, crate::Error::CleanupFailed) {
            control.failed();
        }
        return Err(error);
    }
    control.check()?;
    Ok(
        json!({"dispatched":1,"button":input.button,"click":input.click,"position":position,"effect_confirmed":false}),
    )
}
pub(crate) async fn repeat(control: &Control, input: MouseRepeat) -> Result<Value> {
    control.check()?;
    let position = native::prepare(input.position)?;
    let origin = Instant::now();
    let mut dispatched = 0_u64;
    let mut was_down = if input.stop_on_f9 {
        native::f9()
    } else {
        false
    };
    let duration = match input.repeat {
        Repeat::Count { .. } => None,
        Repeat::Duration { duration_ms } => Some(duration_ms),
        Repeat::Manual { max_duration_ms } => Some(max_duration_ms),
    };
    let stop_reason = loop {
        control.check()?;
        if let Repeat::Count { count } = input.repeat
            && dispatched >= u64::from(count)
        {
            break "count_limit";
        }
        if duration.is_some_and(|limit| origin.elapsed().as_millis() >= u128::from(limit)) {
            break match input.repeat {
                Repeat::Manual { .. } => "manual_limit",
                _ => "duration",
            };
        }
        if input.stop_on_f9 {
            let down = native::f9();
            if down && !was_down {
                break "f9";
            }
            was_down = down;
        }
        let next = origin + Duration::from_millis(dispatched * input.interval_ms);
        if Instant::now() < next {
            control
                .pause(
                    next.saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(20)),
                )
                .await?;
            continue;
        }
        if let Err(error) = native::click(input.button, input.click) {
            if matches!(error, crate::Error::CleanupFailed) {
                control.failed();
            }
            return Err(error);
        }
        dispatched += 1;
    };
    control.check()?;
    Ok(
        json!({"dispatched":dispatched,"button":input.button,"click":input.click,"position":position,"stop_reason":stop_reason,"elapsed_ms":origin.elapsed().as_millis() as u64,"effect_confirmed":false}),
    )
}
