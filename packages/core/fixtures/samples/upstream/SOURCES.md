# Upstream copies of the sample vocabularies

These files are unmodified copies of each vocabulary as its publisher distributes it, kept so the converted
samples in the folder above can be checked against (and regenerated from) the originals. Retrieved 2026-11-11.

| File | Vocabulary (namespace) | Copied from | Licence |
| --- | --- | --- | --- |
| `solid-terms.ttl` | Solid Terms (`http://www.w3.org/ns/solid/terms#`) | [solid/vocab](https://github.com/solid/vocab) `solid-terms.ttl` at `b2ec12c3` | CC0 1.0 (stated in the file) |
| `acl.ttl` | Basic Access Control / Web Access Control (`http://www.w3.org/ns/auth/acl#`) | [w3c/ns](https://github.com/w3c/ns) `auth/acl.ttl` at `ce359b43` | W3C Software and Document License (2015) |
| `ldp.ttl` | Linked Data Platform (`http://www.w3.org/ns/ldp#`) | [w3c/ns](https://github.com/w3c/ns) `ldp.ttl` at `ce359b43` | W3C Software and Document License (2015) |
| `space.ttl` | Workspace / PIM space (`http://www.w3.org/ns/pim/space#`) | [w3c/ns](https://github.com/w3c/ns) `pim/space.ttl` at `ce359b43` | W3C Software and Document License (2015) |
| `meeting.ttl` | Meeting (`http://www.w3.org/ns/pim/meeting#`) | [w3c/ns](https://github.com/w3c/ns) `pim/meeting.ttl` at `ce359b43` | W3C Software and Document License (2015) |
| `ui.ttl` | User interface / forms (`http://www.w3.org/ns/ui#`) | [w3c/ns](https://github.com/w3c/ns) `ui.ttl` at `ce359b43` | CC0 1.0 (stated in the file) |
| `wf.ttl` | Workflow / issue tracking (`http://www.w3.org/2005/01/wf/flow#`) | [solidos/issue-pane](https://github.com/solidos/issue-pane) `src/ontology/wf.ttl` at `204e40ff`, SolidOS's copy of the document published at that namespace | W3C Software and Document License (2015) (published by W3C); the issue-pane repository is MIT |
| `schedule.ttl` | Schedule (`http://www.w3.org/ns/pim/schedule#`) | [w3c/ns](https://github.com/w3c/ns) `pim/schedule.ttl` at `ce359b43` (retrieved 2026-11-13) | W3C Software and Document License (2015) |
| `vcard.nq` | vCard Ontology (`http://www.w3.org/2006/vcard/ns#`), W3C Interest Group Note | npm [`@zazuko/rdf-vocabularies`](https://www.npmjs.com/package/@zazuko/rdf-vocabularies) 2023.1.19 `ontologies/vcard.nq`, a copy of the published document | W3C Software and Document License (2015) |
| `foaf.nq` | FOAF (`http://xmlns.com/foaf/0.1/`) | npm [`@zazuko/rdf-vocabularies`](https://www.npmjs.com/package/@zazuko/rdf-vocabularies) 2023.1.19 `ontologies/foaf.nq`, a copy of the published document | CC BY 1.0 (stated in the FOAF specification) |

SolidOS reads and writes all of these through the [`solid-namespace`](https://www.npmjs.com/package/solid-namespace)
prefixes (`solid`, `acl`, `ldp`, `space`, `meeting`, `ui`, `wf`, `vcard`, `foaf`, `sched`). By use in solid-ui, solid-panes,
issue-pane and meeting-pane source (November 2026), the most used are `ui`, `wf`, `foaf`, `vcard` and `meeting`.

Redistributed W3C conversions use the [2015 licence](https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document), with the [full notice](../../../../../docs/licences/W3C-20150513.md), preserved provenance and change notices described in [sample-vocabularies.md](../../../../../docs/sample-vocabularies.md). FOAF credits Dan Brickley and Libby Miller; its modified copy retains [CC BY 1.0](../../../../../docs/licences/CC-BY-1.0.md).
