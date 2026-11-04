// Helping Hands: volunteering opportunities near you.
//
// The data uses the ODI volunteering standard. The classes come straight from the
// standard's URI on the Concord hub, generated from its SHACL shapes, so there is no
// mapping code to write or keep up to date.
import { Parser, Store, DataFactory } from "https://cdn.jsdelivr.net/npm/n3@2.13.12/+esm";
import { VolunteeringDataset } from "{{CLASSES}}";

const { namedNode, literal, quad } = DataFactory;
const VOL = "https://w3id.org/odi/volunteering#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const RDF_TYPE = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");

const store = new Store();
for (const file of ["data/opportunities.ttl", "data/activities.ttl"])
  store.addQuads(new Parser().parse(await (await fetch(file)).text()));
const data = new VolunteeringDataset(store, DataFactory);
const me = namedNode("https://helping-hands.example/sam");

// A property may hold one value or a set of them, depending on the standard.
const one = (v) => (v instanceof Set ? [...v][0] : v);
const sameAs = (a, b) => a && b && a.value === b.value;

/** Hours given to an opportunity, optionally by one volunteer. */
function hours(opportunity, volunteer) {
  let total = 0;
  for (const activity of data.volunteeringActivity)
    if (sameAs(one(activity.activityFor), opportunity) && (!volunteer || sameAs(one(activity.activityBy), volunteer)))
      total += Number(one(activity.hoursVolunteered) ?? 0);
  return total;
}

/** Records time a volunteer gave, as a vol:VolunteeringActivity. */
function logHours(opportunity, amount) {
  const activity = namedNode(`https://helping-hands.example/activity/${store.size}`);
  store.addQuads([
    quad(activity, RDF_TYPE, namedNode(VOL + "VolunteeringActivity")),
    quad(activity, namedNode(VOL + "activityBy"), me),
    quad(activity, namedNode(VOL + "activityFor"), opportunity),
    quad(activity, namedNode(VOL + "hoursVolunteered"), literal(String(amount), namedNode(XSD + "decimal"))),
    quad(activity, namedNode(VOL + "activityDate"), literal(new Date().toISOString().slice(0, 10), namedNode(XSD + "date"))),
  ]);
}

function card(opportunity) {
  const li = document.createElement("li");
  li.className = "card";
  const age = one(opportunity.minimumAge);
  const places = one(opportunity.placesAvailable);
  const given = hours(opportunity);
  li.innerHTML = `
    <h2>${one(opportunity.title)}</h2>
    <p>${one(opportunity.summary) ?? ""}</p>
    <div class="meta">
      ${age ? `<span class="pill">${age}+</span>` : ""}
      ${places ? `<span class="pill">${places} places</span>` : ""}
      ${one(opportunity.requiresBackgroundCheck) ? `<span class="pill">DBS check</span>` : ""}
      ${given ? `<span class="pill hours">${given} hours given</span>` : ""}
    </div>
    <div class="actions">
      <button>Apply</button>
      <button class="secondary" data-log>Log hours</button>
    </div>`;
  li.querySelector("[data-log]").addEventListener("click", (e) => {
    const form = document.createElement("form");
    form.className = "log";
    form.innerHTML = `<label>Hours <input type="number" min="0.5" step="0.5" value="2" aria-label="Hours"></label><button>Save</button>`;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      logHours(opportunity, Number(form.querySelector("input").value));
      render();
    });
    e.target.replaceWith(form);
    form.querySelector("input").select();
  });
  return li;
}

function render() {
  const list = document.querySelector("#opportunities");
  list.replaceChildren(...[...data.volunteeringOpportunity].map(card));
  const mine = [...data.volunteeringOpportunity].reduce((t, o) => t + hours(o, me), 0);
  const impact = document.querySelector("#impact");
  impact.hidden = false;
  impact.innerHTML = `Your impact <strong>${mine} hours</strong>`;
}
render();
