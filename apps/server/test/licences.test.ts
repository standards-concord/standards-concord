import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { licenceRouter } from '../src/public/licences.js';

// Exercise the public router directly; no listening socket is needed for these static documents.
const read = (url: string) => new Promise<string>((resolve, reject) => {
  licenceRouter()({ method: 'GET', url, headers: {} } as Request, {
    type() { return this; }, send(body: string) { resolve(body); },
  } as unknown as Response, (error?: unknown) => reject(error ?? new Error('No licence route matched')));
});

describe('bundled public licence notices', () => {
  for (const id of ['W3C-20150513', 'CC-BY-1.0']) it(`serves the complete, unchanged ${id} text as markdown and HTML`, async () => {
    const text = fs.readFileSync(path.join(config.repoRoot, 'docs/licences', `${id}.md`), 'utf8');
    expect(await read(`/docs/licences/${id}.md`)).toBe(text);
    expect(await read(`/licences/${id}`)).toContain(await marked.parse(text));
  });
  it('only serves the bundled licence allowlist', async () => {
    await expect(read('/licences/unknown')).rejects.toMatchObject({ status: 404 });
  });
});
