import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, safeHref } from './Markdown';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('never loads remote images: they become links', () => {
    const out = html('![probe](https://attacker.example/pixel)');
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://attacker.example/pixel"');
    expect(out).toContain('>probe</a>');
  });

  it('drops script and data links in any case or spacing', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'vbscript:x']) {
      expect(safeHref(href), href).toBeUndefined();
    }
    const out = html('[click](JaVaScRiPt:alert(1)) and [ok](https://example.org/a?b=1&c=2) and [here](/o/x)');
    expect(out).not.toMatch(/javascript/i);
    expect(out).toContain('click');
    expect(out).toContain('href="https://example.org/a?b=1&amp;c=2"');
    expect(out).toContain('href="/o/x"');
  });

  it('escapes raw HTML', () => {
    expect(html('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});
