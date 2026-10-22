//! 插件配置根独立于业务数据和随包插件，避免更换部署目录丢失用户设置。
use std::path::PathBuf;

pub(crate) fn resolve(
    explicit: Option<PathBuf>,
    user_profile: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, std::io::Error> {
    let directory = explicit
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            user_profile
                .filter(|path| !path.as_os_str().is_empty())
                .or_else(|| home.filter(|path| !path.as_os_str().is_empty()))
                .map(|path| path.join(".deviceforge"))
        })
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "无法确定用户配置目录，请设置 DEVICEFORGE_USER_DIR",
            )
        })?;
    if directory.is_absolute() {
        Ok(directory)
    } else {
        Ok(std::env::current_dir()?.join(directory))
    }
}

pub(crate) fn from_environment() -> Result<PathBuf, std::io::Error> {
    resolve(
        std::env::var_os("DEVICEFORGE_USER_DIR").map(PathBuf::from),
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_home_is_independent_of_business_directory() {
        let home = std::env::current_dir().unwrap().join("user-home");
        assert_eq!(
            resolve(None, Some(home.clone()), None).unwrap(),
            home.join(".deviceforge")
        );
        let explicit = home.join("isolated");
        assert_eq!(
            resolve(Some(explicit.clone()), Some(home), None).unwrap(),
            explicit
        );
        assert!(resolve(None, None, None).is_err());
    }
}
