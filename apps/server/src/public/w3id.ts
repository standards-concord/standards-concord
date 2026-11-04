import type { OntologyProject } from '@concord/shared';

/** Where public ontology pages live on this site. */
export const PUBLIC_BASE = '/def';

/**
 * Redirect rules for a persistent IRI service, so that the ontology IRI and
 * every version IRI (https://w3id.org/odi/<slug>/<version>) land on the public
 * page here. Redirects are 303s and keep the Accept header, so content
 * negotiation still works through them. Only w3id.org is generated for now;
 * it is the service Concord mints IRIs under by default.
 */
export function persistentIdRules(project: Pick<OntologyProject, 'ontologyIRI' | 'slug'>, base: string) {
  let url: URL;
  try {
    url = new URL(project.ontologyIRI);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'w3id.org') return undefined;
  const dir = url.pathname.replace(/^\/|\/$/g, '');
  if (!dir) return undefined;
  const target = `${base}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}`;
  const rules = [
    `# ${project.ontologyIRI} -> ${target}`,
    `# Add as ${dir}/.htaccess in https://github.com/perma-id/w3id.org`,
    'Options +FollowSymLinks',
    'RewriteEngine on',
    `RewriteRule ^$ ${target} [R=303,L]`,
    `RewriteRule ^(.+)$ ${target}/$1 [R=303,L]`,
    '',
  ].join('\n');
  return { service: 'w3id.org', file: `${dir}/.htaccess`, rules };
}
