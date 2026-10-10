/// 与既有受控容器路径规则一致；目录末尾的斜杠允许保留。
pub fn safe_entry(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.contains(':')
        && !name.chars().any(char::is_control)
        && !name.split('/').any(|part| part == "." || part == "..")
}
