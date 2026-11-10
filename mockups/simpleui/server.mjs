import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const page = join(root, 'index.html');
// The mockup reuses the fonts the app ships instead of keeping a second copy
// of them in the repository.
const fontRoots = [
  join(root, '..', '..', 'apps', 'readest-app', 'public', 'fonts'),
  join(root, '..', '..', 'apps', 'readest-app', 'public', 'fonts', 'simpleui'),
];

createServer(async (request, response) => {
  const fontPath = request.url?.match(/^\/fonts\/([A-Za-z0-9-]+\.ttf)$/)?.[1];
  if (fontPath) {
    for (const fontRoot of fontRoots) {
      try {
        const font = await readFile(join(fontRoot, fontPath));
        response.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'no-store' });
        response.end(font);
        return;
      } catch {
        // Try the next font root.
      }
    }
    response.writeHead(404).end('Font not found');
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
