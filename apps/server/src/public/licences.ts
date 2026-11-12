import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { marked } from 'marked';
import { config } from '../config.js';
import { HttpError } from '../db.js';

/** Reviewed, bundled notices only. The markdown files are the source of truth. */
export function licenceRouter(): Router {
  const router = Router();
  const read = (id: string) => {
    if (!['W3C-20150513', 'CC-BY-1.0'].includes(id)) throw new HttpError(404, 'Licence not found');
    return fs.readFileSync(path.join(config.repoRoot, 'docs/licences', `${id}.md`), 'utf8');
  };
  router.get('/licences/:id', async (req, res) => {
    const id = String(req.params.id);
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${id}</title><main>${await marked.parse(read(id))}</main></html>`);
  });
  router.get('/docs/licences/:file', (req, res) => {
    const file = String(req.params.file);
    if (!file.endsWith('.md')) throw new HttpError(404, 'Licence not found');
    res.type('text/markdown').send(read(file.slice(0, -3)));
  });
  return router;
}
