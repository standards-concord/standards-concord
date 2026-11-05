/**
 * Browser entry point (`@concord/core/reasoner`): complete OWL 2 DL reasoning over a
 * Turtle document with sparq, loading only n3 and sparq rather than all of @concord/core.
 */
import { OntologyGraph } from './graph.js';
import { owlReasoner, structuralReasoner, type OwlReasonerOptions } from './reasoner.js';
import type { ReasonerResult } from './types.js';

export type { ReasonerResult, OwlReasonerOptions };

export async function reasonOverTurtle(turtle: string, opts?: OwlReasonerOptions): Promise<ReasonerResult> {
  return owlReasoner(await OntologyGraph.fromTurtle(turtle), opts);
}

/** The structural checks alone (no OWL reasoner), for when sparq gave no verdict. */
export async function structuralOverTurtle(turtle: string): Promise<ReasonerResult> {
  return structuralReasoner(await OntologyGraph.fromTurtle(turtle));
}
