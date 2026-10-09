// 仅解析宿主生成的单引号 / 反斜线引用，模拟 ADB 设备端 shell 的参数拆分。
pub fn shell_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut active = false;
    let mut chars = command.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' => { quoted = !quoted; active = true; }
            '\\' if !quoted => { word.push(chars.next().expect("完整转义")); active = true; }
            ' ' if !quoted => {
                if active { words.push(std::mem::take(&mut word)); active = false; }
            }
            ch => { word.push(ch); active = true; }
        }
    }
    assert!(!quoted);
    if active { words.push(word); }
    words
}
