/**
 * The recording browser: Chromium behind the allowlisting proxy (lib/egress.ts), with
 * the transports a forward proxy can't see switched off.
 *
 * WebRTC sends UDP straight from the browser, around any HTTP proxy. Chromium's
 * disable_non_proxied_udp policy stops that (WebRTC may then only use TCP through the
 * proxy, which checks it like anything else), and pages get no RTCPeerConnection at all,
 * so an attempt shows up as a page error instead of silently doing nothing. Concord
 * doesn't use WebRTC; voice input records with getUserMedia, which is unaffected.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';

/** Lets pages reach the loopback servers the recording runs on. */
export const LOCAL_NETWORK_ARGS = ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'];

/** Keeps WebRTC from sending UDP around the proxy. */
export const WEBRTC_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];

const NO_WEBRTC = `(() => {
  const blocked = function () { throw new Error('WebRTC is disabled while recording the walkthrough'); };
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport']) {
    try { Object.defineProperty(globalThis, name, { value: blocked, configurable: false, writable: false }); } catch {}
  }
})();`;

export async function launchBrowser(o: { proxy: string; headless?: boolean; args?: string[] }): Promise<Browser> {
  return chromium.launch({
    headless: o.headless !== false,
    proxy: { server: o.proxy, bypass: '<-loopback>' },
    args: [...(o.args ?? []), ...LOCAL_NETWORK_ARGS, ...WEBRTC_ARGS],
  });
}

/** Removes WebRTC from every page and frame in the context. */
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
