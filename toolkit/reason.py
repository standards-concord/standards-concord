#!/usr/bin/env python3
"""OWL DL reasoning for Concord, via owlready2 (HermiT or Pellet).

Reads an ontology from stdin (N-Triples by default, or RDF/XML with
``--format rdfxml``), classifies it and prints a JSON object on stdout:

    {"engine": "hermit", "available": true, "consistent": true,
     "unsatisfiable": [iri...], "inferredSubClassOf": [[sub, super]...],
     "explanation": "...", "error": null}

Exit code is 0 whenever a result was produced (including "inconsistent");
non-zero only when the toolkit itself failed (missing owlready2/Java etc.).
"""
from __future__ import annotations

import argparse
import io
import json
import sys

OWL_THING = "http://www.w3.org/2002/07/owl#Thing"
OWL_NOTHING = "http://www.w3.org/2002/07/owl#Nothing"


def clean(msg: str, limit: int = 4000) -> str:
    """Drop JVM noise (e.g. "Picked up JAVA_TOOL_OPTIONS") from Java error output."""
    lines = [l for l in str(msg).splitlines() if not l.startswith("Picked up JAVA_TOOL_OPTIONS")]
    return "\n".join(lines).strip()[:limit]


def emit(payload: dict, code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    sys.exit(code)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["hermit", "pellet"], default="hermit")
    parser.add_argument("--format", choices=["ntriples", "rdfxml"], default="ntriples")
    parser.add_argument("--iri", default="http://example.org/concord-input")
    args = parser.parse_args()

    base = {"engine": args.engine, "available": False, "consistent": True,
            "unsatisfiable": [], "inferredSubClassOf": [], "explanation": None, "error": None}

    try:
        import owlready2
        from owlready2 import (World, ThingClass, OwlReadyInconsistentOntologyError,
                               sync_reasoner_hermit, sync_reasoner_pellet)
    except Exception as exc:  # pragma: no cover - environment dependent
        emit({**base, "error": f"owlready2 not available: {exc}"}, 2)

    data = sys.stdin.buffer.read()
    world = World()
    try:
        onto = world.get_ontology(args.iri).load(fileobj=io.BytesIO(data), format=args.format)
    except Exception as exc:
        emit({**base, "error": f"failed to load ontology: {exc}"}, 3)

    def named_classes():
        return [c for c in world.classes() if isinstance(c, ThingClass) and c.iri not in (OWL_THING, OWL_NOTHING)]

    # Asserted named superclasses, so we can report only *new* (inferred) ones.
    asserted = {(c.iri, s.iri) for c in named_classes() for s in c.is_a if isinstance(s, ThingClass)}

    reason = sync_reasoner_pellet if args.engine == "pellet" else sync_reasoner_hermit
    try:
        with onto:
            reason(world, infer_property_values=False, debug=0)
    except OwlReadyInconsistentOntologyError as exc:
        emit({**base, "available": True, "consistent": False,
              "explanation": "The ontology is inconsistent: no interpretation satisfies all axioms "
                             "(typically an individual asserted to be an instance of disjoint classes, "
                             "or of an unsatisfiable class). " + clean(exc, 2000)})
    except Exception as exc:
        # Java missing or reasoner crash: report as unavailable so the caller can fall back.
        emit({**base, "error": f"reasoner failed: {clean(exc)}"}, 4)

    unsat = sorted({c.iri for c in world.inconsistent_classes()
                    if isinstance(c, ThingClass) and c.iri != OWL_NOTHING})
    unsat_set = set(unsat)
    inferred = sorted({(c.iri, s.iri) for c in named_classes() if c.iri not in unsat_set
                       for s in c.is_a
                       if isinstance(s, ThingClass) and s.iri not in (OWL_THING, OWL_NOTHING)
                       and (c.iri, s.iri) not in asserted and s.iri != c.iri})

    explanation = None
    if unsat:
        explanation = (f"{len(unsat)} class(es) are unsatisfiable (equivalent to owl:Nothing), "
                       "typically because they are subclasses of disjoint classes or carry contradictory restrictions.")
    emit({**base, "available": True, "consistent": True, "unsatisfiable": unsat,
          "inferredSubClassOf": [list(p) for p in inferred], "explanation": explanation,
          "owlready2": getattr(owlready2, "VERSION", None)})


if __name__ == "__main__":
    main()
