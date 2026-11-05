/**
 * Browser entry point (`@concord/core/reasoner`): complete OWL 2 DL reasoning over a
 * Turtle document with sparq, loading only n3 and sparq rather than all of @concord/core.
 */
import { OntologyGraph } from './graph.js';
import { owlReasoner, type OwlReasonerOptions } from './reasoner.js';
import type { ReasonerResult } from './types.js';

export type { ReasonerResult, OwlReasonerOptions };

export async function reasonOverTurtle(turtle: string, opts?: OwlReasonerOptions): Promise<ReasonerResult> {
  return owlReasoner(await OntologyGraph.fromTurtle(turtle), opts);
}
