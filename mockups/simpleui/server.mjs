import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const page = join(root, 'index.html');

createServer(async (request, response) => {
  const fontPath = request.url?.match(/^\/fonts\/([A-Za-z0-9-]+\.ttf)$/)?.[1];
  if (fontPath) {
    try {
      const font = await readFile(join(root, 'fonts', fontPath));
      response.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'no-store' });
      response.end(font);
    } catch {
      response.writeHead(404).end('Font not found');
    }
    return;
  }
  if (request.url !== '/' && request.url !== '/index.html') {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const html = await readFile(page);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  } catch {
    response.writeHead(500).end('Mockup unavailable');
  }
}).listen(8765, '127.0.0.1', () => {
  console.log('SimpleUI mockup: http://127.0.0.1:8765');
});
