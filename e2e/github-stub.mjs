// A stand-in for GitHub's issues API, so the e2e server can file feedback issues offline.
// POST /repos/:owner/:repo/issues records the issue; GET /__issues lists what was received.
import http from 'node:http';

const port = Number(process.env.PORT ?? 8799);
const issues = [];
http
  .createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/__issues' || req.url === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url === '/healthz' ? { ok: true } : issues));
      return;
    }
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const m = req.method === 'POST' && req.url?.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
      if (!m) return void res.writeHead(404).end('{}');
      const number = issues.length + 1;
      issues.push({ number, repo: `${m[1]}/${m[2]}`, authorized: req.headers.authorization === 'Bearer e2e-feedback-token', ...JSON.parse(data) });
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ number, html_url: `https://github.com/${m[1]}/${m[2]}/issues/${number}` }));
    });
  })
  .listen(port, () => console.log(`GitHub stub on ${port}`));
