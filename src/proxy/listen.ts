import * as fs from 'fs';
import * as path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';


export function getRequiredProxyPort(appPath: string): number | undefined {
  const marker = path.join(appPath, 'antigravity-proxy.json');
  if (!fs.existsSync(marker)) return undefined;
  const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (value?.requiredPort !== 50999) {
    throw new Error('Invalid antigravity-proxy.json: the binary patch requires port 50999');
  }
  return value.requiredPort;
}

export function listenProxy(server: Server, preferredPort = 50999, allowFallback = true): Promise<number> {
  return new Promise((resolve, reject) => {
    let triedFallback = false;
    const onListening = () => {
      server.removeListener('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && allowFallback && !triedFallback) {
        triedFallback = true;
        server.listen(0, '127.0.0.1');
        return;
      }
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      if (error.code === 'EADDRINUSE' && !allowFallback) {
        error.message = `Port ${preferredPort} is occupied. The patched language server requires this exact port; close the other instance before starting Antigravity.`;
      }
      reject(error);
    };
    server.once('listening', onListening);
    server.on('error', onError);
    server.listen(preferredPort, '127.0.0.1');
  });
}
