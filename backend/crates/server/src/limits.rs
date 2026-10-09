//! 部署者可调限流上限；并发和请求大小仍有独立边界。
pub fn requests_per_second(value: Option<&str>) -> Result<u32, &'static str> {
    match value {
        None => Ok(120),
        Some(value) => value
            .parse::<u32>()
            .ok()
            .filter(|rate| (1..=100_000).contains(rate))
            .ok_or("DEVICEFORGE_HTTP_RATE 必须是 1 到 100000 的整数"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn deployment_rate_keeps_finite_bounds() {
        assert_eq!(super::requests_per_second(None), Ok(120));
        assert_eq!(super::requests_per_second(Some("100000")), Ok(100000));
        for value in ["", "0", "-1", "100001", "unlimited"] {
            assert!(super::requests_per_second(Some(value)).is_err());
        }
    }
}
