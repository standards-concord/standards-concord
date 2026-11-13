import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SAMPLE_VOCABULARIES } from '@concord/shared';
import { SampleNotice } from './SampleNotice.js';

describe('sample redistribution notices', () => {
  for (const sample of SAMPLE_VOCABULARIES) it(`credits ${sample.slug} and links its full notice`, () => {
    const html = renderToStaticMarkup(createElement(SampleNotice, { sample }));
    expect(html).toContain(sample.sourceTitle);
    expect(html).toContain(`href="${sample.licence.url}"`);
    if (sample.licence.noticePath) expect(html).toContain(`href="${sample.licence.noticePath}"`);
    if (sample.licence.copyPath) expect(html).toContain(`href="${sample.licence.copyPath}"`);
    if (sample.copyrightNotice) expect(html).toContain(sample.copyrightNotice);
    if (sample.authors) {
      expect(html).toContain('Modified from');
      for (const author of sample.authors) expect(html).toContain(author);
    }
  });
});
