import type http from 'node:http';

/** Types for github-stub.mjs, so TypeScript tests can import it. */
export interface GithubStub {
  server: http.Server;
  listen(port?: number, host?: string): Promise<string>;
  callbackUrl: string;
  mintOidc(claims: Record<string, unknown>): string;
}

export function createGithubStub(opts?: { appId?: string; publicKey?: string; clientId?: string; clientSecret?: string; callbackUrl?: string }): GithubStub;
