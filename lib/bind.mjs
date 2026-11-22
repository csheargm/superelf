// Which address the web server listens on · 监听地址
//
// It was server.listen(PORT): every interface, so anyone who could reach the machine reached the
// login form. Default now 127.0.0.1 — reach it through `tailscale serve` (which proxies to
// localhost) or set "bind_host" in config.json: the Tailscale 100.x address, or "0.0.0.0" for
// direct LAN access (README "Reachability").
//
// A demo node keeps its old all-interfaces bind unless configured: it runs in a container whose
// published port only works when the server listens on the container's interface.
export const DEFAULT_BIND_HOST = '127.0.0.1';
export const DEMO_BIND_HOST = '0.0.0.0';

export function bindHostFor(cfg, demo) {
  const v = cfg && cfg.bind_host;
  if (v !== undefined && v !== null && v !== '') {
    if (typeof v !== 'string' || !/^[0-9a-fA-F.:]+$|^[a-zA-Z0-9.-]+$/.test(v)) throw new Error(`config.json bind_host must be an address string, got ${JSON.stringify(v)}`);
    return v;
  }
  return demo ? DEMO_BIND_HOST : DEFAULT_BIND_HOST;
}
