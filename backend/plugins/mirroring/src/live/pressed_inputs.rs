use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct PressedInputs {
    keys: BTreeMap<u32, Vec<u8>>,
    key_order: Vec<u32>,
    touches: BTreeMap<u64, Vec<u8>>,
}

impl PressedInputs {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn record(&mut self, bytes: &[u8]) -> Result<(), String> {
        match bytes.first().copied() {
            Some(0) => self.key(bytes),
            Some(2) => self.touch(bytes),
            Some(_) => Ok(()),
            None => Err("设备输入跟踪缺少完整消息".into()),
        }
    }

    fn key(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() != 14 || bytes[1] > 1 {
            return Err("设备按键跟踪消息无效".into());
        }
        let keycode = u32::from_be_bytes(bytes[2..6].try_into().map_err(|_| "设备按键编码无效")?);
        if keycode > 320 {
            return Err("设备按键跟踪超出范围".into());
        }
        if bytes[1] == 0 {
            let mut released = bytes.to_vec();
            released[1] = 1;
            released[6..14].fill(0);
            if self.keys.insert(keycode, released).is_none() {
                self.key_order.push(keycode);
            }
        } else {
            self.keys.remove(&keycode);
            self.key_order.retain(|value| *value != keycode);
        }
        Ok(())
    }

    fn touch(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() != 32 || bytes[1] > 2 {
            return Err("设备触摸跟踪消息无效".into());
        }
        let pointer = u64::from_be_bytes(bytes[2..10].try_into().map_err(|_| "设备触摸编码无效")?);
        if pointer > 9 {
            return Err("设备触摸跟踪超出范围".into());
        }
        if bytes[1] == 1 {
            self.touches.remove(&pointer);
        } else {
            let mut released = bytes.to_vec();
            released[1] = 1;
            released[22..32].fill(0);
            self.touches.insert(pointer, released);
        }
        Ok(())
    }

    pub(crate) fn release(&mut self) -> Vec<Vec<u8>> {
        let mut released = Vec::with_capacity(self.keys.len() + self.touches.len());
        released.extend(std::mem::take(&mut self.touches).into_values().rev());
        for keycode in std::mem::take(&mut self.key_order).into_iter().rev() {
            if let Some(bytes) = self.keys.remove(&keycode) {
                released.push(bytes);
            }
        }
        released
    }

    pub(crate) fn clear(&mut self) {
        self.keys.clear();
        self.key_order.clear();
        self.touches.clear();
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.keys.is_empty() && self.touches.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::PressedInputs;
    use crate::live::model::{Action, Control};

    fn key(action: Action, keycode: u32) -> Vec<u8> {
        Control::Key {
            action,
            keycode,
            repeat: 7,
            meta_state: 4096,
        }
        .encode()
        .unwrap()
    }

    fn touch(action: Action, pointer_id: u64, x: u32) -> Vec<u8> {
        Control::Touch {
            action,
            pointer_id,
            x,
            y: 20,
            width: 100,
            height: 200,
            pressure: 1.0,
        }
        .encode()
        .unwrap()
    }

    #[test]
    fn repeated_keys_release_once_with_zero_modifiers_and_repeat() {
        let mut pressed = PressedInputs::new();
        pressed.record(&key(Action::Down, 29)).unwrap();
        pressed.record(&key(Action::Down, 29)).unwrap();
        let released = pressed.release();
        assert_eq!(released.len(), 1);
        assert_eq!(released[0][1], 1);
        assert_eq!(&released[0][6..14], &[0; 8]);
        assert!(pressed.release().is_empty());
    }

    #[test]
    fn completed_keys_do_not_produce_extra_releases() {
        let mut pressed = PressedInputs::new();
        pressed.record(&key(Action::Down, 29)).unwrap();
        pressed.record(&key(Action::Up, 29)).unwrap();
        assert!(pressed.release().is_empty());
    }

    #[test]
    fn key_release_reverses_actual_press_order() {
        let mut pressed = PressedInputs::new();
        pressed.record(&key(Action::Down, 113)).unwrap();
        pressed.record(&key(Action::Down, 31)).unwrap();
        let released = pressed.release();
        assert_eq!(
            u32::from_be_bytes(released[0][2..6].try_into().unwrap()),
            31
        );
        assert_eq!(
            u32::from_be_bytes(released[1][2..6].try_into().unwrap()),
            113
        );
    }

    #[test]
    fn touches_release_at_latest_coordinates_with_zero_pressure_and_buttons() {
        let mut pressed = PressedInputs::new();
        pressed.record(&touch(Action::Down, 1, 10)).unwrap();
        pressed.record(&touch(Action::Move, 1, 30)).unwrap();
        pressed.record(&touch(Action::Down, 2, 40)).unwrap();
        pressed.record(&touch(Action::Up, 2, 40)).unwrap();
        let released = pressed.release();
        assert_eq!(released.len(), 1);
        assert_eq!(released[0][1], 1);
        assert_eq!(
            u32::from_be_bytes(released[0][10..14].try_into().unwrap()),
            30
        );
        assert_eq!(&released[0][22..32], &[0; 10]);
    }

    #[test]
    fn malformed_input_is_rejected_and_non_pressed_commands_are_ignored() {
        let mut pressed = PressedInputs::new();
        assert!(pressed.record(&[]).is_err());
        assert!(pressed.record(&[0, 0]).is_err());
        assert!(pressed.record(&[2, 0]).is_err());
        pressed
            .record(&Control::ResetVideo {}.encode().unwrap())
            .unwrap();
        assert!(pressed.release().is_empty());
    }

    #[test]
    fn clear_discards_tracking_after_confirmed_resource_cleanup() {
        let mut pressed = PressedInputs::new();
        pressed.record(&key(Action::Down, 29)).unwrap();
        pressed.record(&touch(Action::Down, 1, 10)).unwrap();
        pressed.clear();
        assert!(pressed.release().is_empty());
    }
}
