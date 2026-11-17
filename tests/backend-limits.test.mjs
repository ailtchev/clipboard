import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const textHelpers = requireCjs('../src/backend/text.js');

const projectRoot = path.resolve(import.meta.dirname, '..');

async function startServer(extraEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'clippy-backend-'));
  const dist = path.join(root, 'dist');
  mkdirSync(dist);
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['src/backend/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: path.join(root, 'database.sqlite'),
      DIST_PATH: dist,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseURL = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/healthz`);
      if (response.ok) return { baseURL, child, root };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Backend did not start: ${stderr}`);
}

async function stopServer(server) {
  server.child.kill('SIGTERM');
  await new Promise((resolve) => server.child.once('exit', resolve));
  rmSync(server.root, { recursive: true, force: true });
}

async function post(baseURL, text) {
  return fetch(`${baseURL}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

test('rejects oversized quoted and unquoted embedded images', async () => {
  const server = await startServer({ MAX_IMAGE_BYTES: '10' });
  try {
    const payload = 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAA';
    assert.equal((await post(server.baseURL, `<img src="${payload}">`)).status, 413);
    assert.equal((await post(server.baseURL, `<img src=${payload}>`)).status, 413);
    assert.equal((await post(server.baseURL, '<img src="data&#58;image/png;base64,AAAAAAAAAAAAAAAAAAAA">')).status, 413);
    assert.equal((await post(server.baseURL, '<img src="data&colon;image/png;base64,AAAAAAAAAAAAAAAAAAAA">')).status, 413);
  } finally {
    await stopServer(server);
  }
});

test('serializes concurrent writes so the database capacity is not overrun', async () => {
  const server = await startServer({
    MAX_ENTRY_BYTES: '30000',
    MAX_DATABASE_BYTES: '122000', // empty DB is 24 KB with the attachments table + indexes
  });
  try {
    const payload = `<p>${'x'.repeat(22000)}</p>`;
    const statuses = await Promise.all([
      post(server.baseURL, payload),
      post(server.baseURL, payload),
    ]).then((responses) => responses.map((response) => response.status).sort());
    assert.deepEqual(statuses, [201, 413]);
  } finally {
    await stopServer(server);
  }
});

test('RETENTION_TIME accepts units, bare days and 0', () => {
  const { parseDuration, formatDuration } = textHelpers;
  assert.equal(parseDuration('10d'), 864000);
  assert.equal(parseDuration('36h'), 129600);
  assert.equal(parseDuration('90m'), 5400);
  assert.equal(parseDuration('2w'), 1209600);
  assert.equal(parseDuration('10'), 864000);
  assert.equal(parseDuration('0'), 0);
  assert.equal(parseDuration('ten days'), null);
  assert.equal(formatDuration(864000), '10d');
  assert.equal(formatDuration(0), 'off');
});

test('HTML from the rich editor converts to plain text with line breaks', () => {
  const { htmlToPlainText } = textHelpers;
  assert.equal(htmlToPlainText('first<div>second</div><div><br></div><div>x&nbsp;&amp;&lt;y&gt;</div>'), 'first\nsecond\n\nx &<y>');
  assert.equal(htmlToPlainText('<b>bold</b> <img src="data:x">'), 'bold [image]');
});

test('plain-text push and .txt pull round-trip CLI output as monospace', async () => {
  const server = await startServer();
  try {
    const body = 'A:admin@pe1# show router interface\n  system      10.0.0.1/32   Up\n  to-pe2 <&> 192.0.2.1/31  Up\n';
    const pushed = await fetch(`${server.baseURL}/api/text`, { method: 'PUT', body });
    assert.equal(pushed.status, 201);
    const id = (await pushed.text()).trim();
    assert.match(id, /^#\d+$/);
    assert.equal(await (await fetch(`${server.baseURL}/api/latest.txt`)).text(), body);
    assert.equal(await (await fetch(`${server.baseURL}/api/messages/${id.slice(1)}.txt`)).text(), body);
    const [entry] = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.equal(entry.mono, true);
    assert.equal((await fetch(`${server.baseURL}/api/messages/999.txt`)).status, 404);
  } finally {
    await stopServer(server);
  }
});

test('plain-text POST is rejected to prevent cross-origin simple-request injection', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseURL}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://attacker.example' },
      body: 'attacker-controlled clipboard entry',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
  } finally {
    await stopServer(server);
  }
});

test('cross-origin simple POST cannot restore a deleted entry', async () => {
  const server = await startServer();
  try {
    const created = await (await post(server.baseURL, '<p>keep deleted</p>')).json();
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}`, { method: 'DELETE' })).status, 204);
    const response = await fetch(`${server.baseURL}/api/messages/${created.id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://attacker.example' },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
  } finally {
    await stopServer(server);
  }
});

test('delete is soft and can be restored; mono can be toggled', async () => {
  const server = await startServer();
  try {
    const created = await (await post(server.baseURL, '<p>keep me</p>')).json();
    assert.equal(created.mono, false);
    const patched = await fetch(`${server.baseURL}/api/messages/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mono: true }),
    });
    assert.equal((await patched.json()).mono, true);
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
    assert.equal((await fetch(`${server.baseURL}/api/latest.txt`)).status, 404);
    const restored = await fetch(`${server.baseURL}/api/messages/${created.id}/restore`, { method: 'PUT' });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).id, created.id);
    assert.equal((await (await fetch(`${server.baseURL}/api/messages`)).json()).length, 1);
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}/restore`, { method: 'PUT' })).status, 404);
  } finally {
    await stopServer(server);
  }
});

test('restore is rejected after the server-side undo window expires', async () => {
  const server = await startServer({ RESTORE_WINDOW_SECONDS: '1' });
  try {
    const created = await (await post(server.baseURL, '<p>expire undo</p>')).json();
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}`, { method: 'DELETE' })).status, 204);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}/restore`, { method: 'PUT' })).status, 404);
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
  } finally {
    await stopServer(server);
  }
});

test('pinned entries bypass retention until they are unpinned', async () => {
  const server = await startServer({ RETENTION_TIME: '1s', PURGE_INTERVAL_MS: '300' });
  try {
    const pinned = await (await post(server.baseURL, '<p>keep pinned</p>')).json();
    const expiring = await (await post(server.baseURL, '<p>expire normally</p>')).json();
    const patched = await fetch(`${server.baseURL}/api/messages/${pinned.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_pinned: true }),
    });
    assert.equal(patched.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    let entries = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.deepEqual(entries.map((entry) => entry.id), [pinned.id]);
    assert.equal(entries[0].is_pinned, true);
    assert.equal(entries.some((entry) => entry.id === expiring.id), false);

    assert.equal((await fetch(`${server.baseURL}/api/messages/${pinned.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_pinned: false }),
    })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 700));
    entries = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.deepEqual(entries, []);
  } finally {
    await stopServer(server);
  }
});

test('entries older than RETENTION_TIME are purged', async () => {
  const server = await startServer({ RETENTION_TIME: '1s', PURGE_INTERVAL_MS: '300' });
  try {
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).retention, '1s');
    assert.equal((await post(server.baseURL, '<p>short-lived</p>')).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
  } finally {
    await stopServer(server);
  }
});

async function upload(baseURL, name, body, { type, route = 'files', headers = {} } = {}) {
  return fetch(`${baseURL}/api/${route}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { ...(type ? { 'Content-Type': type } : {}), ...headers },
    body,
  });
}

async function postEntry(baseURL, text, attachments = []) {
  return fetch(`${baseURL}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, attachments }),
  });
}

// Content files on disk under <root>/files/xx/<sha256> (ignores the .tmp upload directory).
function storedFiles(root) {
  const filesRoot = path.join(root, 'files');
  if (!existsSync(filesRoot)) return [];
  return readdirSync(filesRoot).filter((dir) => /^[0-9a-f]{2}$/.test(dir)).flatMap((dir) => readdirSync(path.join(filesRoot, dir)));
}

test('files are stored on disk outside SQLite, linked to an entry and downloadable', async () => {
  const server = await startServer();
  try {
    const content = Buffer.from('A:admin@pe1# admin show configuration\n'.repeat(20000));
    const uploaded = await upload(server.baseURL, 'pe1 config.cfg', content, { type: 'text/plain' });
    assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    assert.equal(file.size, content.length);
    const sha = createHash('sha256').update(content).digest('hex');
    assert.ok(existsSync(path.join(server.root, 'files', sha.slice(0, 2), sha)));
    assert.ok(statSync(path.join(server.root, 'database.sqlite')).size < content.length / 4);

    const created = await postEntry(server.baseURL, '', [file.id]);
    assert.equal(created.status, 201);
    const entry = await created.json();
    assert.equal(entry.files.length, 1);
    assert.equal(entry.files[0].name, 'pe1 config.cfg');
    const listed = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.equal(listed[0].files[0].id, file.id);

    const download = await fetch(`${server.baseURL}/${entry.files[0].url}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /^attachment; filename="pe1 config\.cfg"/);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(content));
    const byIndex = await fetch(`${server.baseURL}/api/messages/${entry.id}/files/1`);
    assert.ok(Buffer.from(await byIndex.arrayBuffer()).equals(content));
    assert.equal((await fetch(`${server.baseURL}/api/messages/${entry.id}/files/2`)).status, 404);

    assert.equal((await postEntry(server.baseURL, '<p>reuse</p>', [file.id])).status, 409);
    const config = await (await fetch(`${server.baseURL}/api/config`)).json();
    assert.equal(config.filesBytesUsed, content.length);
    assert.equal(config.maxFileBytes, 100 * 1024 * 1024);
    assert.equal(config.maxFilesBytes, 5 * 1024 * 1024 * 1024);
  } finally {
    await stopServer(server);
  }
});

test('files over MAX_FILE_BYTES or past MAX_FILES_BYTES are rejected and identical files are stored once', async () => {
  const server = await startServer({ MAX_FILE_BYTES: '1000', MAX_FILES_BYTES: '1500' });
  try {
    const tooLarge = await upload(server.baseURL, 'big.bin', Buffer.alloc(2000, 1));
    assert.equal(tooLarge.status, 413);
    assert.match((await tooLarge.json()).error, /larger than the 1000 B limit/);
    assert.deepEqual(storedFiles(server.root), []);

    const first = Buffer.alloc(900, 2);
    assert.equal((await upload(server.baseURL, 'a.bin', first)).status, 201);
    const full = await upload(server.baseURL, 'b.bin', Buffer.alloc(900, 3));
    assert.equal(full.status, 413);
    assert.match((await full.json()).error, /storage is full/);
    assert.equal((await upload(server.baseURL, 'a-copy.bin', first)).status, 201);
    assert.equal(storedFiles(server.root).length, 1);
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, 900);
  } finally {
    await stopServer(server);
  }
});

test('terminal upload creates an entry and the .txt view links its files', async () => {
  const server = await startServer();
  try {
    const uploaded = await upload(server.baseURL, 'capture.pcap', Buffer.from('pcap-bytes'), { route: 'upload' });
    assert.equal(uploaded.status, 201);
    const id = (await uploaded.text()).trim();
    assert.match(id, /^#\d+$/);
    const text = await (await fetch(`${server.baseURL}/api/messages/${id.slice(1)}.txt`, {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'lab.example', 'X-Forwarded-Prefix': '/clipboard' },
    })).text();
    assert.match(text, /^\[file\] capture\.pcap \(10 B\) https:\/\/lab\.example\/clipboard\/api\/files\/\d+\/capture\.pcap\n$/);
    const [entry] = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.equal(entry.files[0].type, 'application/vnd.tcpdump.pcap');
  } finally {
    await stopServer(server);
  }
});

test('pasted images are stored as files and shown inline; unsafe types are never served inline', async () => {
  const server = await startServer();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const image = await (await upload(server.baseURL, 'pasted-image.png', png, { type: 'image/png' })).json();
    const entry = await (await postEntry(server.baseURL, `<p>see</p><img src="${image.url}">`)).json();
    assert.deepEqual(entry.files, []);
    assert.match(entry.message, new RegExp(`src="api/files/${image.id}/pasted-image\\.png"`));
    const shown = await fetch(`${server.baseURL}/${image.url}`);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.match(shown.headers.get('content-disposition'), /^inline;/);
    assert.match((await fetch(`${server.baseURL}/${image.url}?download`)).headers.get('content-disposition'), /^attachment;/);

    // the same image pasted into a second entry gets its own reference, so deleting one entry keeps the other intact
    const copy = await (await postEntry(server.baseURL, `<img src="https://lab.example/clipboard/${entry.message.match(/api\/files\/\d+\/[^"]+/)[0]}">`)).json();
    const copyUrl = copy.message.match(/api\/files\/(\d+)\//);
    assert.ok(copyUrl && Number(copyUrl[1]) !== image.id);
    assert.equal(storedFiles(server.root).length, 1);

    const page = await (await upload(server.baseURL, 'evil.html', Buffer.from('<script>alert(1)</script>'), { type: 'text/html' })).json();
    const served = await fetch(`${server.baseURL}/${page.url}`);
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    assert.match(served.headers.get('content-disposition'), /^attachment;/);
    assert.match(served.headers.get('content-security-policy'), /sandbox/);
  } finally {
    await stopServer(server);
  }
});

test('unsent uploads can be removed and files of purged entries are deleted from disk', async () => {
  const server = await startServer({ RETENTION_TIME: '1s', PURGE_INTERVAL_MS: '300' });
  try {
    const pending = await (await upload(server.baseURL, 'draft.txt', Buffer.from('draft'))).json();
    assert.equal((await fetch(`${server.baseURL}/api/files/${pending.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${server.baseURL}/api/files/${pending.id}`, { method: 'DELETE' })).status, 404);

    const kept = await (await upload(server.baseURL, 'kept.txt', Buffer.from('kept'))).json();
    assert.equal((await postEntry(server.baseURL, '<p>with file</p>', [kept.id])).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
    assert.deepEqual(storedFiles(server.root), []);
    assert.equal((await fetch(`${server.baseURL}/${kept.url}`)).status, 404);
  } finally {
    await stopServer(server);
  }
});
