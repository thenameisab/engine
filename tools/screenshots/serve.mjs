/** Minimal static server for the assembled dashboard site (capture harness only). */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const PORT = Number(process.argv[2] ?? 8787);
const ROOT = process.argv[3] ?? join(process.cwd(), 'apps', 'dashboard', 'site');

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  let path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
