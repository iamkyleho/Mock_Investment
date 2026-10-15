import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function withinRoot(file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function respond(res, status, message, head = false) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : message);
}

const server = createServer(async (req, res) => {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    res.setHeader('Allow', 'GET, HEAD');
    return respond(res, 405, 'Method not allowed.');
  }

  try {
    // Decode before checking segments so encoded traversal and dotfiles are rejected.
    const pathname = decodeURIComponent((req.url ?? '/').split(/[?#]/, 1)[0]);
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')
      || pathname.split('/').some(segment => segment.startsWith('.') || segment.includes(':'))) {
      return respond(res, 403, 'Forbidden.', head);
    }

    let file = path.resolve(root, `.${pathname}`);
    if (!withinRoot(file)) return respond(res, 403, 'Forbidden.', head);
    let info = await stat(file);
    if (info.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await stat(file);
    }

    // Resolve links too: files outside the project cannot be exposed through a symlink.
    file = await realpath(file);
    if (!withinRoot(file) || path.relative(root, file).split(path.sep).some(segment => segment.startsWith('.'))) {
      return respond(res, 403, 'Forbidden.', head);
    }
    if (!info.isFile()) return respond(res, 404, 'Not found.', head);

    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    if (head) return res.end();
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    if (error instanceof URIError) return respond(res, 400, 'Invalid URL.', head);
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) {
      return respond(res, 404, 'Not found.', head);
    }
    console.error(error);
    respond(res, 500, 'Internal server error.', head);
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Set a different PORT and try again.`
    : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Mock Investment: http://localhost:${port}`);
  console.log('Press Ctrl+C to stop.');
});
