/** Keep the interview's title unless the first answer can replace a default. */
export function interviewTitle(current: string | undefined, name: string, answer: string): string | undefined {
  if (current && current !== `${name}'s use case` && current !== `${name}’s use case`) return current;
  const sentence = answer.trim().split(/[.!?](?:\s|$)/u)[0].trim();
  const clipped = sentence.length <= 60 ? sentence : sentence.slice(0, 61).replace(/\s+\S*$/, '').slice(0, 60);
  return clipped.replace(/[\p{P}\s]+$/u, '') || current;
}
