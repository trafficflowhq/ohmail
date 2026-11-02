### The sender's address line keeps the name before the @ whole, and the proxy reads OHMAIL_TLS_TERMINATOR only as addresses

On the web, in a narrow open message the line under the sender that states their address no longer breaks the
part before the @ over two lines: "from" stays beside the address, a long name before the @ is shortened at its
end, and the domain stays whole, as it already did in the Screener and the wider header.

On your own server, the proxy now refuses to start when `OHMAIL_TLS_TERMINATOR` is anything but `gateway` or
addresses and CIDRs separated by single spaces, and says what to write. Before, such a value already stopped the
server, but the proxy still handed it to Caddy, where a brace or a line break would have been read as
configuration.
