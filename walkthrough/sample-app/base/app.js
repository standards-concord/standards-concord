// Helping Hands: volunteering opportunities near you.
//
// The data uses the ODI volunteering standard. The classes come straight from the
// standard's URI on the Concord hub, generated from its SHACL shapes, so there is no
// mapping code to write or keep up to date.
import { Parser, Store, DataFactory } from "https://cdn.jsdelivr.net/npm/n3@2.13.12/+esm";
import { VolunteeringDataset } from "{{CLASSES}}";

const store = new Store();
store.addQuads(new Parser().parse(await (await fetch("data/opportunities.ttl")).text()));
const data = new VolunteeringDataset(store, DataFactory);

// A property may hold one value or a set of them, depending on the standard.
const one = (v) => (v instanceof Set ? [...v][0] : v);

function card(opportunity) {
  const li = document.createElement("li");
  li.className = "card";
  const age = one(opportunity.minimumAge);
  const places = one(opportunity.placesAvailable);
  li.innerHTML = `
    <h2>${one(opportunity.title)}</h2>
    <p>${one(opportunity.summary) ?? ""}</p>
    <div class="meta">
      ${age ? `<span class="pill">${age}+</span>` : ""}
      ${places ? `<span class="pill">${places} places</span>` : ""}
      ${one(opportunity.requiresBackgroundCheck) ? `<span class="pill">DBS check</span>` : ""}
    </div>
    <div class="actions"><button>Apply</button></div>`;
  return li;
}

const list = document.querySelector("#opportunities");
for (const opportunity of data.volunteeringOpportunity) list.append(card(opportunity));
