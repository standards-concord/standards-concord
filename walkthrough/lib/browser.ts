/**
 * The recording browser: Chromium behind the allowlisting proxy (lib/egress.ts), with
 * the transports a forward proxy can't see switched off.
 *
 * WebRTC sends UDP straight from the browser, around any HTTP proxy. Two things stop it:
 * - Chromium's disable_non_proxied_udp policy, so WebRTC may only use TCP through the
 *   proxy, which checks it like anything else;
 * - pages get no working RTCPeerConnection: it is replaced with a function that throws.
 *
 * Every call to that replacement is reported to the recorder (as a refused outside
 * request) by the DevTools protocol, from outside the page: the debugger pauses on the
 * error it throws, records it and resumes. Page code can't intercept or forge that,
 * and catching the error doesn't hide it. The replacement is installed by an init script,
 * before any of a document's own scripts, in every frame.
 *
 * The recording drives a single page, so any other page (a popup, a new tab) is closed
 * and reported, rather than guarded after its scripts may already have run.
 *
 * Concord doesn't use WebRTC; voice input records with getUserMedia, which is unaffected.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

/** Lets pages reach the loopback servers the recording runs on. */
export const LOCAL_NETWORK_ARGS = ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'];

/** Keeps WebRTC from sending UDP around the proxy. */
export const WEBRTC_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];

const WEBRTC_NAMES = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport'];

/** The name the replacement script is parsed under, so the debugger can tell its throws apart. */
const GUARD_URL = 'concord-walkthrough-no-webrtc.js';

/**
 * Replaces the WebRTC constructors with one function that throws (non-configurable, so
 * pages can't put them back). Runs first in every document; idempotent.
 */
const NO_WEBRTC = `(() => {
  const blocked = function () {
    throw new Error('WebRTC is disabled while recording the walkthrough');
  };
  for (const name of ${JSON.stringify(WEBRTC_NAMES)}) {
    const d = Object.getOwnPropertyDescriptor(globalThis, name);
    if (d && !d.configurable) continue;
    try { Object.defineProperty(globalThis, name, { value: blocked, configurable: false, writable: false, enumerable: false }); } catch {}
  }
})();
//# sourceURL=${GUARD_URL}`;

export async function launchBrowser(o: { proxy: string; headless?: boolean; args?: string[] }): Promise<Browser> {
  return chromium.launch({
    headless: o.headless !== false,
    proxy: { server: o.proxy, bypass: '<-loopback>' },
    args: [...(o.args ?? []), ...LOCAL_NETWORK_ARGS, ...WEBRTC_ARGS],
  });
}

/**
 * Removes WebRTC from every page in the context. Each attempt to use it, and any page
 * other than the ones guarded with guardPage(), is added to `blocked`.
 */
export async function guardContext(context: BrowserContext, blocked: Set<string>) {
  await context.addInitScript(NO_WEBRTC);
  const guarded = new WeakSet<Page>();
  (context as any).__guarded = guarded;
  context.on('page', (p) => {
    // Give guardPage() a moment to claim a page it created.
    setTimeout(() => {
      if (guarded.has(p) || p.isClosed()) return;
      blocked.add(`unexpected page: ${p.url().slice(0, 200) || 'about:blank'}`);
      void p.close().catch(() => {});
    }, 0);
  });
}

/** Opens a page in a guarded context with WebRTC calls watched from outside the page. */
export async function guardedPage(context: BrowserContext, blocked: Set<string>): Promise<Page> {
  const guarded: WeakSet<Page> | undefined = (context as any).__guarded;
  const page = await context.newPage();
  guarded?.add(page);
  await watchWebRtc(page, blocked);
  return page;
}

/**
 * Watches every exception thrown in the page from the debugger, and records the ones
 * thrown by the replacement, before resuming. (Catching the error in the page doesn't
 * hide it: the debugger sees it as it's thrown.) Only the copy the init script installed
 * counts: it is the first script parsed under GUARD_URL in each document, as it runs
 * before any of the page's own, so a page that evaluates a script under that name can't
 * forge a report.
 */
async function watchWebRtc(page: Page, blocked: Set<string>) {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const contextsSeen = new Set<number>();
  const genuine = new Set<string>();
  let attempts = 0;
  cdp.on('Debugger.scriptParsed', (e: any) => {
    if (e.url !== GUARD_URL || contextsSeen.has(e.executionContextId)) return;
    contextsSeen.add(e.executionContextId);
    genuine.add(e.scriptId);
  });
  cdp.on('Debugger.paused', async (e: any) => {
    try {
      const top = e.callFrames?.[0]?.location;
      if (e.reason === 'exception' && top && genuine.has(top.scriptId)) blocked.add(`webrtc: RTCPeerConnection (attempt ${++attempts}) on ${page.url().slice(0, 200)}`);
    } finally {
      await cdp.send('Debugger.resume').catch(() => {});
    }
  });
  await cdp.send('Debugger.enable');
  // Caught exceptions too; anything else is resumed straight away.
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' });
}

/** Whether Playwright's Chromium is installed here (the general CI test job has none). */
export const hasChromium = () => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
};
