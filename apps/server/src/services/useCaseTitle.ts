/** Long enough for a one-sentence goal, as the offline interviewer has always used. */
const MAX = 80;

/** Keep the interview's title unless the first answer can replace a default. */
export function interviewTitle(current: string | undefined, name: string, answer: string): string | undefined {
  if (current && current !== `${name}'s use case` && current !== `${name}’s use case`) return current;
  const sentence = answer.trim().split(/[.!?](?:\s|$)/u)[0].trim();
  const clipped = sentence.length <= MAX ? sentence : sentence.slice(0, MAX + 1).replace(/\s+\S*$/, '').slice(0, MAX);
  return clipped.replace(/[\p{P}\s]+$/u, '') || current;
}
