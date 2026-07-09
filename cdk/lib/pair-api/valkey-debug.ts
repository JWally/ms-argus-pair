export async function diagnoseValkeyConnectivity(): Promise<Record<string, unknown>> {
  const host = process.env.VALKEY_ENDPOINT ?? '';
  const port = Number(process.env.VALKEY_PORT ?? '6379');
  const result: Record<string, unknown> = { host, port };
  const dnsmod = await import('node:dns/promises');
  try {
    const addrs = await dnsmod.resolve4(host);
    result.dns = { ok: true, addrs };
  } catch (e) {
    result.dns = { ok: false, err: (e as Error).message };
    return result;
  }

  const ips = (result.dns as { addrs: string[] }).addrs;
  const netmod = await import('node:net');
  result.tcp = await Promise.all(
    ips.map(async (ip) => {
      const tcp: Record<string, unknown> = { ip };
      try {
        const t0 = Date.now();
        await new Promise<void>((resolve, reject) => {
          const sock = netmod.createConnection({ host: ip, port, timeout: 2000 });
          sock.once('connect', () => {
            sock.end();
            resolve();
          });
          sock.once('error', (err) => reject(err));
          sock.once('timeout', () => reject(new Error('tcp_timeout')));
        });
        tcp.ok = true;
        tcp.ms = Date.now() - t0;
      } catch (e) {
        tcp.ok = false;
        tcp.err = (e as Error).message;
      }
      return tcp;
    })
  );

  const tlsmod = await import('node:tls');
  result.tls = await Promise.all(
    ips.map(async (ip) => {
      const tls: Record<string, unknown> = { ip };
      try {
        const t0 = Date.now();
        await new Promise<void>((resolve, reject) => {
          const sock = tlsmod.connect({
            host: ip,
            port,
            servername: host,
            timeout: 3000,
            rejectUnauthorized: false,
          });
          sock.once('secureConnect', () => {
            sock.end();
            resolve();
          });
          sock.once('error', (err) => reject(err));
          sock.once('timeout', () => reject(new Error('tls_timeout')));
        });
        tls.ok = true;
        tls.ms = Date.now() - t0;
      } catch (e) {
        tls.ok = false;
        tls.err = (e as Error).message;
      }
      return tls;
    })
  );

  try {
    const { getValkey } = await import('../valkey-client');
    const t0 = Date.now();
    const valkey = getValkey();
    const pong = await valkey.ping();
    result.ioredisPing = { ok: true, pong, ms: Date.now() - t0, status: valkey.status };
  } catch (e) {
    result.ioredisPing = { ok: false, err: (e as Error).message };
  }
  return result;
}
