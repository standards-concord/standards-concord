/**
 * XML Schema's built-in datatype hierarchy, kept apart from the rest of core so the web app can use it
 * without pulling in the RDF code (it says why a byte is an acceptable integer when it explains a finding).
 */
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** XML Schema's built-in datatype derivations: each datatype and the one it is derived from. */
export const XSD_BASE: Record<string, string> = {
  integer: 'decimal', nonPositiveInteger: 'integer', negativeInteger: 'nonPositiveInteger', long: 'integer', int: 'long', short: 'int', byte: 'short',
  nonNegativeInteger: 'integer', unsignedLong: 'nonNegativeInteger', unsignedInt: 'unsignedLong', unsignedShort: 'unsignedInt', unsignedByte: 'unsignedShort',
  positiveInteger: 'nonNegativeInteger', normalizedString: 'string', token: 'normalizedString', language: 'token', Name: 'token', NCName: 'Name',
  NMTOKEN: 'token', ID: 'NCName', IDREF: 'NCName', ENTITY: 'NCName', dateTimeStamp: 'dateTime', yearMonthDuration: 'duration', dayTimeDuration: 'duration',
};

/** Whether built-in datatype `a` is `b` or derived from it. */
export const derives = (a: string, b: string): boolean => {
  for (let x: string | undefined = a; x; x = x.startsWith(XSD) && XSD_BASE[x.slice(XSD.length)] ? XSD + XSD_BASE[x.slice(XSD.length)] : undefined) if (x === b) return true;
  return false;
};

/** The built-in XML Schema datatypes derived from `dt` (not `dt` itself): a literal written as one of them is a `dt` value too. */
export function derivedTypes(dt: string): string[] {
  return Object.keys(XSD_BASE)
    .map((l) => XSD + l)
    .filter((d) => d !== dt && derives(d, dt));
}
