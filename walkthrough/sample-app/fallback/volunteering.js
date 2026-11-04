// Stand-in for the classes Concord generates at <ontology URI>.js, used by the recorder
// only when the hub being recorded does not serve them yet (see walkthrough/README.md).
// It has the same shape as the generated module: one class per NodeShape and a dataset
// wrapper with a getter per class. Remove it once every deployment serves real classes.
import { DatasetWrapper, LiteralAs, OptionalFrom, TermAs, TermWrapper } from "https://cdn.jsdelivr.net/npm/@rdfjs/wrapper@0.34.0/+esm";

const VOL = "https://w3id.org/odi/volunteering#";

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
  get activityFor() { return OptionalFrom.subjectPredicate(this, VOL + "activityFor", TermAs.instance(VolunteeringOpportunity)); }
  get hoursVolunteered() { return OptionalFrom.subjectPredicate(this, VOL + "hoursVolunteered", LiteralAs.number); }
  get activityDate() { return OptionalFrom.subjectPredicate(this, VOL + "activityDate", LiteralAs.date); }
}
/* @activity-end */

export class VolunteeringDataset extends DatasetWrapper {
  get volunteeringOpportunity() { return this.instancesOf(VOL + "VolunteeringOpportunity", VolunteeringOpportunity); }
  get volunteer() { return this.instancesOf(VOL + "Volunteer", Volunteer); }
  /* @activity-start */
  get volunteeringActivity() { return this.instancesOf(VOL + "VolunteeringActivity", VolunteeringActivity); }
  /* @activity-end */
}
