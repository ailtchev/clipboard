// File attachments are stored outside SQLite, content-addressed by SHA-256:
//   <FILES_PATH>/ab/abcdef…   (identical uploads share one file on disk)
//   <FILES_PATH>/.tmp/<uuid>  (uploads in progress)
// SQLite only keeps metadata (attachments table). Names never reach the file system.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SHA256 = /^[0-9a-f]{64}$/;

const EXTENSION_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  yaml: 'application/yaml', yml: 'application/yaml', cfg: 'text/plain', conf: 'text/plain', ini: 'text/plain', html: 'text/html', htm: 'text/html',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', xz: 'application/x-xz',
  pcap: 'application/vnd.tcpdump.pcap', pcapng: 'application/vnd.tcpdump.pcap', cap: 'application/vnd.tcpdump.pcap',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Only these are ever served inline (thumbnails / pasted images). Everything else, SVG and HTML included, is a download.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

function sanitizeFileName(value) {
  const base = String(value ?? '').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  return base.slice(0, 200) || 'file';
}

function guessType(name, declared) {
  const header = String(declared || '').split(';')[0].trim().toLowerCase();
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(header) && header !== 'application/octet-stream' && header !== 'application/x-www-form-urlencoded') return header;
  const extension = path.extname(name).slice(1).toLowerCase();
  return EXTENSION_TYPES[extension] || 'application/octet-stream';
}

function isInlineImageType(type) {
  return INLINE_IMAGE_TYPES.has(type);
}

function contentDisposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

class FileStore {
  constructor(root) {
    this.root = path.resolve(root); // res.sendFile needs absolute paths
    this.tmpDir = path.join(root, '.tmp');
  }

  async init() {
    await fsp.mkdir(this.tmpDir, { recursive: true });
    await this.cleanTmp(0); // anything left at startup is from an interrupted upload
  }

  pathFor(sha256) {
    if (!SHA256.test(sha256)) throw new Error('Invalid file hash');
    return path.join(this.root, sha256.slice(0, 2), sha256);
  }

  // Streams the request body to a temporary file while hashing it. Rejects with status 413 past maxBytes.
  receive(req, maxBytes) {
    const tmp = path.join(this.tmpDir, crypto.randomUUID());
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      let size = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        req.unpipe(out);
        // remove the partial file only once the stream has closed (it may still be opening)
        out.once('close', () => fsp.rm(tmp, { force: true }).catch(() => {}));
        out.destroy();
        reject(error);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) fail(httpError(413, 'File is too large'));
        else hash.update(chunk);
      });
      req.on('close', () => { if (!req.complete) fail(httpError(400, 'Upload interrupted')); });
      req.on('error', fail);
      out.on('error', (error) => fail(error.code === 'ENOSPC' ? httpError(507, 'No space left for files') : error));
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve({ tmp, size, sha256: hash.digest('hex') });
      });
      req.pipe(out);
    });
  }

  async exists(sha256) {
    try {
      await fsp.access(this.pathFor(sha256));
      return true;
    } catch {
      return false;
    }
  }

  // Moves an upload into place; if the same content is already stored, the upload is simply dropped.
  async commit(tmp, sha256) {
    const target = this.pathFor(sha256);
    if (await this.exists(sha256)) {
      await fsp.rm(tmp, { force: true });
      return false;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(tmp, target);
    return true;
  }

  discard(tmp) {
    return fsp.rm(tmp, { force: true });
  }

  // Deletes stored files whose hash is not in `keep`. Returns the number of files removed.
  async sweep(keep) {
    let removed = 0;
    let dirs;
    try {
      dirs = await fsp.readdir(this.root);
    } catch {
      return 0;
    }
    for (const dir of dirs) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      const files = await fsp.readdir(path.join(this.root, dir)).catch(() => []);
      for (const file of files) {
        if (SHA256.test(file) && file.startsWith(dir) && !keep.has(file)) {
          await fsp.rm(path.join(this.root, dir, file), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  async cleanTmp(maxAgeMs) {
    const now = Date.now();
    const files = await fsp.readdir(this.tmpDir).catch(() => []);
    for (const file of files) {
      const full = path.join(this.tmpDir, file);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && now - stat.mtimeMs >= maxAgeMs) await fsp.rm(full, { force: true });
    }
  }
}

module.exports = { FileStore, sanitizeFileName, guessType, isInlineImageType, contentDisposition, httpError };
