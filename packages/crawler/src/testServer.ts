/** A tiny real HTTP server used only by tests, so crawlPage/crawlSite get real
 * network responses (status/headers/redirects) instead of Playwright's
 * network-less `page.setContent`. Not shipped — never imported by src code. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  origin: string;
  close: () => Promise<void>;
}

const ROBOTS_TXT = `
User-agent: *
Disallow: /forbidden

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Allow: /

Sitemap: /sitemap.xml
`.trim();

function sitemapXml(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/target</loc></url>
</urlset>`;
}

const PAGES: Record<string, (origin: string) => { status: number; headers?: Record<string, string>; body?: string }> = {
  '/': () => ({
    status: 200,
    body: `<!doctype html><html><head>
      <title>Home — Test Site</title>
      <meta name="description" content="A test page for the crawler." />
      <link rel="canonical" href="ORIGIN/" />
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Test Co',
        url: 'ORIGIN/',
      })}</script>
    </head><body><h1>Hello</h1><a href="ORIGIN/target">target</a><a href="ORIGIN/forbidden">forbidden</a></body></html>`,
  }),
  '/target': () => ({
    status: 200,
    body: `<!doctype html><html><head><title>Target</title>
      <meta name="description" content="Target page." />
      <link rel="canonical" href="ORIGIN/target" />
    </head><body>Target page</body></html>`,
  }),
  '/redirect': () => ({ status: 302, headers: { location: 'ORIGIN/target' } }),
  '/noindex': () => ({
    status: 200,
    body: `<!doctype html><html><head><title>Noindex</title>
      <meta name="robots" content="noindex" />
    </head><body>Noindex page</body></html>`,
  }),
  '/broken-schema': () => ({
    status: 200,
    body: `<!doctype html><html><head><title>Broken</title>
      <meta name="description" content="Broken schema page." />
      <script type="application/ld+json">{ not valid json </script>
    </head><body>Broken</body></html>`,
  }),
  '/forbidden': () => ({ status: 200, body: '<!doctype html><title>Forbidden</title>' }),
};

export function startTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(ROBOTS_TXT);
        return;
      }
      const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
      if (url.pathname === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' }).end(sitemapXml(origin));
        return;
      }
      const handler = PAGES[url.pathname];
      if (!handler) {
        res.writeHead(404).end('not found');
        return;
      }
      const { status, headers = {}, body } = handler(origin);
      const resolvedHeaders = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k, v.replaceAll('ORIGIN', origin)]),
      );
      if (body !== undefined) resolvedHeaders['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(status, resolvedHeaders);
      res.end(body?.replaceAll('ORIGIN', origin) ?? '');
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://localhost:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
