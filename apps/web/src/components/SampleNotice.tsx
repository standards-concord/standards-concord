import type { SampleAttribution } from '@concord/shared';

/** Attribution travels with the project, including when the sample has been edited. */
export function SampleNotice({ sample }: { sample: SampleAttribution }) {
  const link = 'text-accent underline underline-offset-2';
  return (
    <section aria-label="About this sample" className="rounded-lg border border-line bg-surface-2 p-4 text-sm leading-relaxed">
      <h2 className="font-semibold">About this sample</h2>
      <p className="mt-1">
        A sample copy for trying Concord. The original is published by {sample.publisher}: {' '}
        <a className={link} href={sample.source}>{sample.sourceTitle}</a>. Licence: {' '}
        <a className={link} href={sample.licence.url}>{sample.licence.name}</a>.{' '}
        <a className={link} href="#sample-conversion-changes">What the conversion changed</a>.
      </p>
      <p className="mt-1 text-muted">Used by {sample.usedBy}.</p>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">Conversion changes</summary>
        <p id="sample-conversion-changes" className="mt-1">{sample.changes}</p>
      </details>
    </section>
  );
}
