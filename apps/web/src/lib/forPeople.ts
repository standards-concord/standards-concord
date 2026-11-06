/**
 * A fork check's advice, worded for a person. The server writes it once for both people and
 * coding agents, naming the MCP tools to call ("Sync the fork (sync_fork)"). People have the
 * buttons instead, so the tool names come out; anything else is left exactly as written.
 */
export function forPeople(text: string): string {
  return text
    .replace(/ \([a-z_]*fork[a-z_]*, or ([^)]+)\)/g, ' ($1)')
    .replace(/ \([a-z_]*fork[a-z_]*\)/g, '')
    .replace(/;? get_fork on this fork lists them/g, '')
    .replace(/call propose_fork again/g, 'propose the fork again')
    .replace(/ with edit_fork/g, '');
}
