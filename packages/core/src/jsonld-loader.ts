/**
 * JSON-LD processing never touches the network: remote contexts and `@import`
 * are refused, so neither a submitted document nor an edited prefix can make
 * the server fetch a URL.
 */

export const REMOTE_REFUSED = 'Remote JSON-LD documents are not loaded';

/** A JSON-LD document loader that loads nothing: every remote context or `@import` is an error. */
export const noRemoteDocuments = async (url: string): Promise<never> => {
  throw new Error(`${REMOTE_REFUSED} (${url}). Put the context inline.`);
};
