/**
 * Web Worker that runs sparq's OWL 2 DL reasoner (WebAssembly) over a Turtle document, so a
 * large ontology never freezes the page. Started by reasonInBrowser.ts.
 */
import { reasonOverTurtle } from '@concord/core/reasoner';

// The worker global, typed without the webworker lib (it clashes with this project's DOM lib).
const scope = self as unknown as { onmessage: ((ev: MessageEvent<{ turtle: string }>) => void) | null; postMessage: (m: unknown) => void };

scope.onmessage = async (ev) => {
  try {
    scope.postMessage({ result: await reasonOverTurtle(ev.data.turtle) });
  } catch (e) {
    scope.postMessage({ error: (e as Error).message ?? String(e) });
  }
};
