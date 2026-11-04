// A stand-in for GitHub's issues API, so the e2e server can post public feedback summaries offline.
// POST /repos/:owner/:repo/issues creates, GET lists, PATCH /repos/:owner/:repo/issues/:n edits.
// GET /__issues lists everything received, for the tests.
import http from 'node:http';

const port = Number(process.env.PORT ?? 8799);
const issues = [];
const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
http
  .createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/__issues') return send(res, 200, issues);
      if (req.method === 'GET' && url.pathname === '/user') return send(res, 200, { login: 'concord-e2e-bot' });
      const list = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
      const one = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
      if (list && req.method === 'GET') return send(res, 200, [...issues].reverse().map((i) => ({ number: i.number, html_url: i.html_url, title: i.title, body: i.body, created_at: i.created_at, user: { login: 'concord-e2e-bot' } })));
      if (list && req.method === 'POST') {
        const number = issues.length + 1;
        const html_url = `https://github.com/${list[1]}/${list[2]}/issues/${number}`;
        issues.push({ number, html_url, state: 'open', created_at: new Date().toISOString(), repo: `${list[1]}/${list[2]}`, authorized: req.headers.authorization === 'Bearer e2e-feedback-token', ...JSON.parse(data) });
        return send(res, 201, { number, html_url });
      }
      if (one && req.method === 'PATCH' && issues[Number(one[3]) - 1]) {
        Object.assign(issues[Number(one[3]) - 1], JSON.parse(data));
        return send(res, 200, {});
      }
      send(res, 404, {});
    });
  })
  .listen(port, () => console.log(`GitHub stub on ${port}`));
