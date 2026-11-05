// Helping Hands: volunteering opportunities near you.
//
// The data uses the ODI volunteering standard. The classes come straight from the
// standard's URI on the Concord hub, generated from its SHACL shapes, so there is no
// mapping code to write or keep up to date.
import { Parser, Store, DataFactory } from "https://cdn.jsdelivr.net/npm/n3@2.13.12/+esm";
import { VolunteeringActivity, VolunteeringDataset } from "{{CLASSES}}";

const { namedNode } = DataFactory;
const VOL = "https://w3id.org/odi/volunteering#";
const RDF_TYPE = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");

const store = new Store();
for (const file of ["data/opportunities.ttl", "data/activities.ttl"])
  store.addQuads(new Parser().parse(await (await fetch(file)).text()));
const data = new VolunteeringDataset(store, DataFactory);
const me = namedNode("https://helping-hands.example/sam");
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// A property may hold one value or a set of them, depending on the standard.
const one = (v) => (v && typeof v === "object" && typeof v[Symbol.iterator] === "function" ? [...v][0] : v);
const sameAs = (a, b) => a && b && a.value === b.value;

/** The time volunteers have given to an opportunity. */
const activitiesFor = (opportunity) => [...data.volunteeringActivity].filter((a) => sameAs(a.activityFor, opportunity));

/** Hours given to an opportunity, optionally by one volunteer. */
function hours(opportunity, volunteer) {
  return activitiesFor(opportunity)
    .filter((activity) => !volunteer || sameAs(activity.activityBy, volunteer))
    .reduce((total, activity) => total + (activity.hoursVolunteered ?? 0), 0);
}

/** The last day someone gave time to an opportunity. */
function lastHelped(opportunity) {
  const days = activitiesFor(opportunity).map((activity) => activity.activityDate?.getTime()).filter(Boolean);
  return days.length ? new Date(Math.max(...days)) : undefined;
}

/** Records time a volunteer gave, as a new VolunteeringActivity. */
function logHours(opportunity, amount) {
  const id = namedNode(`https://helping-hands.example/activity/${store.size}`);
  store.addQuad(id, RDF_TYPE, namedNode(VOL + "VolunteeringActivity"));
  const activity = new VolunteeringActivity(id, store, DataFactory);
  activity.activityBy = me;
  activity.activityFor = opportunity;
  activity.hoursVolunteered = amount;
  activity.activityDate = new Date();
}

function card(opportunity) {
  const li = document.createElement("li");
  li.className = "card";
  const age = one(opportunity.minimumAge);
  const places = one(opportunity.placesAvailable);
  const given = hours(opportunity);
  const last = lastHelped(opportunity);
  li.innerHTML = `
    <h2>${one(opportunity.title)}</h2>
    <p>${one(opportunity.summary) ?? ""}</p>
    <div class="meta">
      ${age ? `<span class="pill">${age}+</span>` : ""}
      ${places ? `<span class="pill">${places} places</span>` : ""}
      ${one(opportunity.requiresBackgroundCheck) ? `<span class="pill">DBS check</span>` : ""}
      ${given ? `<span class="pill hours">${given} hours given</span>` : ""}
      ${last ? `<span class="pill">Last helped ${day.format(last)}</span>` : ""}
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
