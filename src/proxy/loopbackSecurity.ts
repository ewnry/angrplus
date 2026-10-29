import type { IncomingMessage, ServerResponse } from 'node:http';

function validPort(port: unknown): port is number {
  return Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535;
}

function loopbackOrigins(port: number, protocols: string[]): string[] {
  return protocols.flatMap((protocol) => [`${protocol}//127.0.0.1:${port}`, `${protocol}//localhost:${port}`]);
}

export function guardLoopbackRequest(req: IncomingMessage, res: ServerResponse, languageServerPort?: number): boolean {
  const port = req.socket.localPort;
  const duplicate = ['host', 'origin'].some(
    (name) =>
      req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length > 1,
  );
  const allowedOrigins = validPort(port) ? loopbackOrigins(port, ['http:']) : [];
  if (validPort(languageServerPort)) allowedOrigins.push(...loopbackOrigins(languageServerPort, ['http:', 'https:']));
  if (
    duplicate ||
    !validPort(port) ||
    ![`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost'].includes(req.headers.host || '') ||
    (req.headers.origin !== undefined && !allowedOrigins.includes(req.headers.origin))
  ) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Service is available only at its loopback origin' }));
    return false;
  }
  return true;
}

export function languageServerModelsUrl(value: string, port?: number): URL | undefined {
  if (!validPort(port)) return undefined;
  try {
    const url = new URL(value);
    if (
      value !== url.href ||
      !loopbackOrigins(port, ['http:', 'https:']).includes(url.origin) ||
      ![
        '/LanguageServerService/GetAvailableModels',
        '/exa.language_server_pb.LanguageServerService/GetAvailableModels',
      ].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function authenticatedGoogleFileUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'googleapis.com' && !url.hostname.endsWith('.googleapis.com')) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443')
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}
