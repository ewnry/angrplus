import { protocol, net } from 'electron';





export const extensionAuthorities = new Map<string, string>();

export function registerCustomSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'plugin',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: true,
        codeCache: true,
      },
    },
  ]);
}

export function registerCustomSchemeHandlers(): void {

  protocol.handle('plugin', async (request) => {
    const url = new URL(request.url);
    const authority = url.hostname;
    const originalHost = extensionAuthorities.get(authority);
    if (!originalHost) {
      return new Response(null, { status: 404 });
    }
    const targetUrl = new URL(url.pathname + url.search, originalHost);
    try {
      const fetchOptions: RequestInit & { duplex?: string } = {
        method: request.method,
        headers: request.headers,
        body: request.body,
      };
      if (request.body) {

        fetchOptions.duplex = 'half';
      }
      const response = await net.fetch(targetUrl.toString(), fetchOptions);
      return response;
    } catch (err) {
      console.error(`Failed to proxy request to ${targetUrl}:`, err);
      return new Response(null, { status: 500 });
    }
  });
}
