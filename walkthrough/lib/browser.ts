/**
 * The recording browser: Chromium behind the allowlisting proxy (lib/egress.ts), with
 * the transports a forward proxy can't see switched off.
 *
 * WebRTC can send UDP straight from the browser, around any HTTP proxy. Chromium's
 * disable_non_proxied_udp policy prevents that: WebRTC may then only use TCP through the
 * proxy (TURN over TCP or TLS), which checks and reports it like any other connection.
 * Pages also get no working RTCPeerConnection, as a second layer. Nothing is detected or
 * reported from inside the page: there is no traffic to report, because there's no route
 * for it. Concord doesn't use WebRTC; voice input records with getUserMedia, which is
 * unaffected.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';

/** Lets pages reach the loopback servers the recording runs on. */
export const LOCAL_NETWORK_ARGS = ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'];

/** Keeps WebRTC from sending anything except through the proxy. */
export const WEBRTC_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];

const NO_WEBRTC = `(() => {
  const blocked = function () { throw new TypeError('WebRTC is disabled while recording the walkthrough'); };
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport']) {
    try { Object.defineProperty(globalThis, name, { value: blocked, configurable: false, writable: false, enumerable: false }); } catch {}
  }
})();`;

export async function launchBrowser(o: { proxy: string; headless?: boolean; args?: string[] }): Promise<Browser> {
  return chromium.launch({
    headless: o.headless !== false,
    proxy: { server: o.proxy, bypass: '<-loopback>' },
    args: [...(o.args ?? []), ...LOCAL_NETWORK_ARGS, ...WEBRTC_ARGS],
  });
}

/** Removes the WebRTC constructors from every page and frame in the context. */
export async function guardContext(context: BrowserContext) {
  await context.addInitScript(NO_WEBRTC);
}

/** Whether Playwright's Chromium is installed here (the general CI test job has none). */
export const hasChromium = () => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
};
