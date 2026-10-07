// Serves the isolated UI spike on loopback. Dispatch stays in the browser and never reaches an external service.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  const route = routes.get(new URL(request.url, 'http://localhost').pathname);
  if (!route || request.method !== 'GET') {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(route[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }).end(body);
  } catch {
    response.writeHead(500).end('The UI asset could not load.');
  }
});

server.listen(8795, '127.0.0.1', () => {
  console.log('Attention UI spike: http://localhost:8795');
});
