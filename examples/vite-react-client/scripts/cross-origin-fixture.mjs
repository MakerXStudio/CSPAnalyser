#!/usr/bin/env node
import { createServer } from 'node:http';

const host = 'localhost';
const port = 4174;
const origin = `http://${host}:${port}`;

const frameBody = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Cross-origin frame fixture</title>
  </head>
  <body>
    <h1>Cross-origin frame scenario</h1>
  </body>
</html>
`;
const frameAncestorsBody = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Frame ancestors fixture</title>
  </head>
  <body>
    <h1>Frame ancestors denied fixture</h1>
  </body>
</html>
`;

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin, Access-Control-Request-Private-Network',
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? '/', origin);

  if (req.method === 'OPTIONS') {
    send(
      res,
      204,
      {
        ...corsHeaders(req),
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
      '',
    );
    return;
  }

  if (requestUrl.pathname === '/') {
    send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ready');
    return;
  }

  if (requestUrl.pathname === '/beacon') {
    send(
      res,
      204,
      {
        ...corsHeaders(req),
        'Cache-Control': 'no-store',
      },
      '',
    );
    return;
  }

  if (requestUrl.pathname === '/frame.html') {
    send(
      res,
      200,
      {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      },
      frameBody,
    );
    return;
  }

  if (requestUrl.pathname === '/frame-ancestors-denied.html') {
    send(
      res,
      200,
      {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'Content-Type': 'text/html; charset=utf-8',
      },
      frameAncestorsBody,
    );
    return;
  }

  send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
});

server.listen(port, host, () => {
  console.log(`Cross-origin CSP fixture listening at ${origin}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
