use super::*;

#[test]
fn ipv4_and_localhost_require_an_explicit_decimal_port() {
    for address in [
        "0.0.0.0:1",
        "255.255.255.255:65535",
        "127.0.0.1:00080",
        "localhost:1",
        "localhost:65535",
    ] {
        assert!(rules::address(address).is_ok(), "{address}");
    }
    for address in [
        "",
        "127.0.0.1",
        "localhost",
        "localhost:",
        "localhost:0",
        "localhost:65536",
        "localhost:000001",
        "localhost:+80",
        "localhost:-1",
        "localhost:80tail",
        "localhost:８０",
        "LOCALHOST:80",
        "device.example:80",
        "256.0.0.1:80",
        "127.00.0.1:80",
        "127.1:80",
        "0x7f000001:80",
        "[::1]:80",
        "::1:80",
        "-t:80",
        "localhost:80 -remove",
        "localhost:80;id",
        " localhost:80",
        "localhost:80\n",
        "127.0.0.1\0:80",
    ] {
        assert!(rules::address(address).is_err(), "{address:?}");
    }
}

#[test]
fn connection_input_preserves_the_hdc_address_literal() {
    assert!(matches!(
        parse("connect", &json!({"address":"localhost:00080"})).unwrap(),
        Input::Connect { address } if address == "localhost:00080"
    ));
    assert!(matches!(
        parse("disconnect", &json!({"address":"127.0.0.1:65535"})).unwrap(),
        Input::Disconnect { address } if address == "127.0.0.1:65535"
    ));
    for operation in ["connect", "disconnect"] {
        for value in [
            json!({}),
            json!({"address":null}),
            json!({"address":80}),
            json!({"address":"localhost:80","extra":true}),
            json!({"host":"localhost","port":80}),
            json!({"address":"device.example:80"}),
            json!(null),
            json!([]),
        ] {
            assert!(parse(operation, &value).is_err());
        }
    }
    for operation in ["connect.unknown", "harmony.connect", "packages"] {
        assert!(parse(operation, &json!({"address":"localhost:80"})).is_err());
    }
}

#[test]
fn connect_requires_one_of_the_two_exact_hdc_success_lines() {
    assert_eq!(
        rules::connect(b"\r\n Connect OK \r\n", b"").unwrap(),
        "Connect OK"
    );
    assert_eq!(
        rules::connect(b"[Info]Target is connected, repeat operation\r\n", b"").unwrap(),
        "[Info]Target is connected, repeat operation"
    );
    for output in [
        "",
        "Success",
        "connect ok",
        "connected to localhost:80",
        "already connected to localhost:80",
        "prefix Connect OK",
        "Connect OK trailing",
        "Target is connected, repeat operation",
    ] {
        assert!(rules::connect(output.as_bytes(), b"").is_err());
    }
}

#[test]
fn disconnect_requires_the_supported_silent_response() {
    assert_eq!(rules::disconnect(b"", b"").unwrap(), "");
    assert_eq!(rules::disconnect(b" \r\n", b"\t").unwrap(), "");
    for output in [
        "Success",
        "Connect OK",
        "No target available",
        "[Info]Target is connected, repeat operation",
    ] {
        assert!(rules::disconnect(output.as_bytes(), b"").is_err());
        assert!(rules::disconnect(b"", output.as_bytes()).is_err());
    }
}

#[test]
fn diagnostics_and_invalid_utf8_win_over_connection_success_or_silence() {
    for diagnostic in [
        "[Fail]No target available",
        "[fAiL] independent diagnostic",
        "Connect failed",
        "CreateConnect failed",
        "error: denied",
    ] {
        assert!(rules::connect(b"Connect OK", diagnostic.as_bytes()).is_err());
        assert!(rules::connect(format!("Connect OK\n{diagnostic}").as_bytes(), b"").is_err());
        assert!(rules::disconnect(b"", diagnostic.as_bytes()).is_err());
        assert!(rules::disconnect(diagnostic.as_bytes(), b"").is_err());
    }
    assert!(rules::connect(&[0xff], b"").is_err());
    assert!(rules::connect(b"Connect OK", &[0xff]).is_err());
    assert!(rules::disconnect(&[0xff], b"").is_err());
    assert!(rules::disconnect(b"", &[0xff]).is_err());
}
