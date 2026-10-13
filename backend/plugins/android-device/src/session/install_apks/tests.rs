use super::*;

#[test]
fn default_modules_do_not_change_install_argv() {
    let mut args = vec!["install-apks".into(), "--apks=input.apks".into()];
    append_modules(&mut args, None);
    assert_eq!(args, ["install-apks", "--apks=input.apks"]);
}

#[test]
fn module_selection_appends_one_fixed_flag_without_instant_or_device_spec() {
    let mut args = vec!["install-apks".into()];
    append_modules(&mut args, Some(&["base".into(), "feature_1".into()]));
    assert_eq!(args, ["install-apks", "--modules=base,feature_1"]);
}
