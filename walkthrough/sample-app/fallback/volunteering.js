// Stand-in for the classes Concord generates at <ontology URI>.js, used by the recorder
// only when the hub being recorded does not serve them yet (see walkthrough/README.md).
// It has the same shape as the generated module: one class per NodeShape and a dataset
// wrapper with a getter per class. Remove it once every deployment serves real classes.
import { DatasetWrapper, LiteralAs, OptionalAs, OptionalFrom, TermAs, TermFrom, TermWrapper } from "https://cdn.jsdelivr.net/npm/@rdfjs/wrapper@0.34.0/+esm";

const VOL = "https://w3id.org/odi/volunteering#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

/** Writes a value as a literal of one datatype (dates as xsd:date), as the generated module does. */
const literalWriter = (datatype) => (value, factory) =>
  factory.literal(value instanceof Date ? value.toISOString().slice(0, datatype === XSD + "date" ? 10 : undefined) : String(value), factory.namedNode(datatype));

export class VolunteeringOpportunity extends TermWrapper {
  get title() { return OptionalFrom.subjectPredicate(this, VOL + "title", LiteralAs.string); }
  get summary() { return OptionalFrom.subjectPredicate(this, VOL + "summary", LiteralAs.string); }
  get minimumAge() { return OptionalFrom.subjectPredicate(this, VOL + "minimumAge", LiteralAs.number); }
  get placesAvailable() { return OptionalFrom.subjectPredicate(this, VOL + "placesAvailable", LiteralAs.number); }
  get requiresBackgroundCheck() { return OptionalFrom.subjectPredicate(this, VOL + "requiresBackgroundCheck", LiteralAs.boolean); }
}

export class Volunteer extends TermWrapper {}

/* @activity-start */
export class VolunteeringActivity extends TermWrapper {
  get activityBy() { return OptionalFrom.subjectPredicate(this, VOL + "activityBy", TermAs.instance(Volunteer)); }
  set activityBy(value) { OptionalAs.object(this, VOL + "activityBy", value, TermFrom.instance); }
  get activityFor() { return OptionalFrom.subjectPredicate(this, VOL + "activityFor", TermAs.instance(VolunteeringOpportunity)); }
  set activityFor(value) { OptionalAs.object(this, VOL + "activityFor", value, TermFrom.instance); }
  get hoursVolunteered() { return OptionalFrom.subjectPredicate(this, VOL + "hoursVolunteered", LiteralAs.number); }
  set hoursVolunteered(value) { OptionalAs.object(this, VOL + "hoursVolunteered", value, literalWriter(XSD + "decimal")); }
  get activityDate() { return OptionalFrom.subjectPredicate(this, VOL + "activityDate", LiteralAs.date); }
  set activityDate(value) { OptionalAs.object(this, VOL + "activityDate", value, literalWriter(XSD + "date")); }
}
/* @activity-end */

export class VolunteeringDataset extends DatasetWrapper {
  get volunteeringOpportunity() { return this.instancesOf(VOL + "VolunteeringOpportunity", VolunteeringOpportunity); }
  get volunteer() { return this.instancesOf(VOL + "Volunteer", Volunteer); }
  /* @activity-start */
  get volunteeringActivity() { return this.instancesOf(VOL + "VolunteeringActivity", VolunteeringActivity); }
  /* @activity-end */
}
