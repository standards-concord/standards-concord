# Third-party logos

Concord shows other projects' logos in two places, only to name the thing a button connects to:

- **Connect your agent** (`apps/web/src/components/AgentLogos.tsx`): Claude, ChatGPT, Claude Code, Codex, Cursor and VS Code.
- **Solid** (`SolidIcon` in `apps/web/src/components/badges.tsx`): the Solid row in Settings' sign-in providers. The login page's Solid button will use it too.

| Mark | Path data from | Owner's guidelines |
| --- | --- | --- |
| Claude, Claude Code | Simple Icons (CC0), traced from claude.ai and code.claude.com | Anthropic |
| OpenAI Blossom (ChatGPT) | Iconify `logos` set (CC0) | openai.com/brand: the Blossom is used in black or white only |
| Codex | Lobe Icons (MIT), Codex app mark | openai.com/brand |
| Cursor | Simple Icons (CC0), from cursor.com/brand | cursor.com/brand |
| VS Code | Iconify `logos` set (CC0) | code.visualstudio.com/brand |
| Solid | solid/solidproject.org, `assets/img/solid-emblem.svg` | solidproject.org |

The licences above cover the SVG files. The marks themselves stay their owners' trademarks. So:

- Use a mark only next to the name of the product it belongs to, to say Concord works with it. Never to suggest the owner endorses Concord.
- Don't redraw, recolour, crop or combine a mark. The black-or-white marks (OpenAI, Cursor) take the text colour so they stay black on light pages and white on dark ones.
- Keep every mark in the picker the same size (20px). The Playwright test in `e2e/connect.spec.ts` checks the size and that each mark is visible in light and dark mode.

Check the owner's brand page before adding a new mark or changing one.

**Connected agents** (`AgentAccess.tsx`) reuse these marks. An agent gets one only when its whole registered name, ignoring case and spacing, is one of the app's names. Only Claude Code may add one bracketed label, because it registers as "Claude Code (<server name>)". A name that merely contains an app's name, such as "Not Claude", gets the generic agent mark. The name is the app's own claim, so another app could register as exactly "Claude"; that is an accepted limit, since the row shows the same name as text and the consent page says whether Concord could confirm who made the app.

The Solid ecosystem sample copies identify their original publishers and licences on every sample. See [sample vocabularies](sample-vocabularies.md) for attribution, source documents and conversion decisions for all ten.
