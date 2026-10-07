// Serves the isolated UI spike on loopback. It reads pd and falls back to fixtures; it never writes pd or sends Dispatch.
// ATTENTION_SOURCE=fixture skips pd. PD_PROJECT selects the project; otherwise the checkout's pd context decides.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { agentClaims, attentionProjection, createProjectReader, projectTasks } from './pd-source.mjs';
import { fixtureState } from './fixtures.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/tasks', ['tasks.html', 'text/html; charset=utf-8']],
  ['/agents', ['agents.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/shells.js', ['shells.js', 'text/javascript; charset=utf-8']],
]);

const projections = new Map([
  ['/api/attention', attentionProjection],
  ['/api/tasks', projectTasks],
  ['/api/agents', agentClaims],
]);

function contextProject() {
  return new Promise((resolve) => {
    execFile('pd', ['context'], { timeout: 10_000 }, (error, stdout) => {
      try {
        resolve(error ? null : JSON.parse(stdout).project ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

const project = process.env.ATTENTION_SOURCE === 'fixture' ? null : process.env.PD_PROJECT || await contextProject();
const readState = project ? createProjectReader(project) : null;
readState?.().catch((error) => console.warn(`The first pd read failed: ${error.message}`));

async function currentState() {
  if (!readState) return { state: fixtureState, source: 'fixture' };
  try {
    return { state: await readState(), source: 'pd' };
  } catch (error) {
    console.warn(`Using fixtures: ${error.message}`);
    return { state: fixtureState, source: 'fixture' };
  }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  const projection = projections.get(path);
  if (projection) {
    const { state, source } = await currentState();
    response
      .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ source, ...projection(state) }));
    return;
  }
  const asset = assets.get(path);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }).end(body);
  } catch {
    response.writeHead(500).end('The UI asset could not load.');
  }
});

server.listen(8795, '127.0.0.1', () => {
  console.log(`Attention UI spike: http://localhost:8795 (${project ? `pd project ${project}` : 'fixtures'})`);
});
