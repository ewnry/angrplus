# Google connection in Antigravity+

Open **Settings → General+ → Google connections**. Use **Add connection** to save a named proxy or relay. Select **Use** beside a saved connection to activate it; **Direct** switches Google requests back to a direct connection. Profiles can be edited or deleted. The change applies to new requests; existing requests continue on their original connection. An existing single connection is preserved as a saved profile.

- **Direct** connects to Google normally.
- **SOCKS4 / SOCKS4a** accepts `socks4://host:port` or `socks4a://host:port`.
- **SOCKS5** accepts `socks5://host:port` or `socks5h://host:port`. The latter resolves the destination at the proxy.
- **HTTP / HTTPS proxy** accepts `http://host:port` or `https://host:port`. An HTTP proxy must support CONNECT.
- **Custom server / Worker** accepts the HTTPS base URL of a server implementing the AG+ relay protocol and its relay key. A plain VPS or arbitrary HTTPS server is not itself an AG+ relay.

Proxy URLs can include credentials (`scheme://user:password@host:port`); percent-encode special characters. Credentials and relay keys are encrypted using the existing local credential storage. The address shown in settings omits proxy credentials; saving the same address with no credentials preserves them.

Only designated Google hosts used by AG+ are routed. Other model providers keep their configured connections. Vendor components can make additional network requests outside this routing layer, so this is not a system-wide proxy.

## Relay protocol

The relay accepts `GET` and `POST` at `/relay/{service}/{path}` with the `x-agy-relay-key` header. Service mappings are `cloudcode` → `daily-cloudcode-pa.googleapis.com`, `oauth` → `oauth2.googleapis.com`, `googleapis` → `www.googleapis.com`, and `generative` → `generativelanguage.googleapis.com`. Query strings and request bodies must be preserved, responses streamed, and redirects not followed. The relay must authenticate clients and restrict destinations to these hosts; do not deploy an open proxy.

The experimental Cloudflare Worker implementation is maintained separately in the local `work/ag-cf-relay` directory. It requires a Cloudflare `RELAY_SECRET` and does not log request bodies or authorization headers. A VPS implementation can expose the same protocol behind HTTPS. A relay operator can access requests and tokens, so use a trusted server.
