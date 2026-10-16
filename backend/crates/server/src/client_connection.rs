use axum::{extract::connect_info::Connected, serve::IncomingStream};
use std::net::{IpAddr, SocketAddr};
use tokio::net::TcpListener;

#[derive(Clone, Copy, Debug)]
pub struct ClientConnection {
    is_local: bool,
}

impl ClientConnection {
    pub fn from_addresses(peer: SocketAddr, local: Option<SocketAddr>) -> Self {
        let peer_ip = normalize(peer.ip());
        Self {
            is_local: peer_ip.is_loopback()
                || local.is_some_and(|address| normalize(address.ip()) == peer_ip),
        }
    }

    pub fn is_local(self) -> bool {
        self.is_local
    }
}

fn normalize(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map_or(IpAddr::V6(address), IpAddr::V4),
        address => address,
    }
}

impl Connected<IncomingStream<'_, TcpListener>> for ClientConnection {
    fn connect_info(stream: IncomingStream<'_, TcpListener>) -> Self {
        Self::from_addresses(*stream.remote_addr(), stream.io().local_addr().ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_or_matching_socket_interface_is_local() {
        let local = Some("192.168.50.5:7031".parse().unwrap());
        for peer in ["127.0.0.1:1000", "[::1]:1000", "192.168.50.5:1000"] {
            assert!(ClientConnection::from_addresses(peer.parse().unwrap(), local).is_local());
        }
        assert!(
            !ClientConnection::from_addresses("192.168.50.6:1000".parse().unwrap(), local)
                .is_local()
        );
        assert!(
            !ClientConnection::from_addresses("192.168.50.5:1000".parse().unwrap(), None)
                .is_local()
        );
    }

    #[test]
    fn mapped_ipv4_addresses_have_the_same_locality() {
        assert!(
            ClientConnection::from_addresses(
                "[::ffff:192.168.50.5]:1000".parse().unwrap(),
                Some("192.168.50.5:7031".parse().unwrap()),
            )
            .is_local()
        );
        assert!(
            ClientConnection::from_addresses("[::ffff:127.0.0.1]:1000".parse().unwrap(), None)
                .is_local()
        );
    }
}
