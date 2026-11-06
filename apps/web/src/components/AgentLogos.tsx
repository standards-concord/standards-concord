import { useId } from 'react';

/**
 * The official marks of the apps people connect to Concord, drawn inline so
 * they need no network request. Each is used only to name the app it belongs
 * to, unaltered and at the same size, as the owners' brand guidelines allow:
 *
 * - Claude and Claude Code: Anthropic's marks, in Claude's brand orange.
 * - ChatGPT: the OpenAI Blossom. OpenAI's guidelines allow it only in black or
 *   white, so it takes the text colour (black in light mode, white in dark).
 * - Codex: the Codex app mark with its blue gradient.
 * - Cursor: the cube from cursor.com/brand, in the text colour like the Blossom.
 * - VS Code: Microsoft's Visual Studio Code icon.
 *
 * The path data comes from Simple Icons (CC0) and the Iconify "logos" and Lobe
 * Icons sets, which trace the owners' published files. The marks themselves
 * remain their owners' trademarks; see docs/third-party-marks.md.
 *
 * Every logo is decorative (the button's text names the app), so it is hidden
 * from assistive technology.
 */

const box = 'size-5 shrink-0';

/** A unique id that is safe inside url(#…): React's ids contain characters like ':' or '«'. */
function useSvgId(prefix: string) {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export function ClaudeLogo() {
  return (
    <svg viewBox="0 0 24 24" className={box} aria-hidden data-logo="claude">
      <path
        fill="#D97757"
        d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.2549-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0174.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
      />
    </svg>
  );
}

export function ClaudeCodeLogo() {
  return (
    <svg viewBox="0 0 24 24" className={box} aria-hidden data-logo="claude-code">
      <path fill="#D97757" d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z" />
    </svg>
  );
}

export function OpenAILogo() {
  return (
    <svg viewBox="0 0 256 260" className={`${box} text-fg`} aria-hidden data-logo="chatgpt">
      <path
        fill="currentColor"
        d="M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218-28.188-16.218z"
      />
    </svg>
  );
}

export function CodexLogo() {
  const id = useSvgId('codex');
  return (
    <svg viewBox="0 0 24 24" className={box} aria-hidden data-logo="codex">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="0" y2="24">
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}

export function CursorLogo() {
  return (
    <svg viewBox="0 0 24 24" className={`${box} text-fg`} aria-hidden data-logo="cursor">
      <path
        fill="currentColor"
        d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
      />
    </svg>
  );
}

const VSCODE_OUTLINE =
  'M180.828 252.605a15.87 15.87 0 0 0 12.65-.486l52.501-25.262a15.94 15.94 0 0 0 9.025-14.364V41.197a15.94 15.94 0 0 0-9.025-14.363l-52.5-25.263a15.88 15.88 0 0 0-18.115 3.084L74.857 96.35l-43.78-33.232a10.614 10.614 0 0 0-13.56.603L3.476 76.494c-4.63 4.211-4.635 11.495-.012 15.713l37.967 34.638-37.967 34.637c-4.623 4.219-4.618 11.502.012 15.714l14.041 12.772a10.614 10.614 0 0 0 13.56.604l43.78-33.233 100.507 91.695a15.85 15.85 0 0 0 5.464 3.571m10.464-183.649-76.262 57.889 76.262 57.888z';

export function VSCodeLogo() {
  const id = useSvgId('vscode');
  const mask = `${id}-mask`;
  const sheen = `${id}-sheen`;
  return (
    <svg viewBox="0 0 256 254" className={box} aria-hidden data-logo="vscode">
      <defs>
        <linearGradient id={sheen} x1="50%" x2="50%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={mask} fill="#fff">
          <path d={VSCODE_OUTLINE} />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <path
          fill="#0065a9"
          d="M246.135 26.873 193.593 1.575a15.885 15.885 0 0 0-18.123 3.08L3.466 161.482c-4.626 4.219-4.62 11.502.012 15.714l14.05 12.772a10.625 10.625 0 0 0 13.569.604L238.229 33.436c6.949-5.271 16.93-.315 16.93 8.407v-.61a15.94 15.94 0 0 0-9.024-14.36"
        />
        <path
          fill="#007acc"
          d="m246.135 226.816-52.542 25.298a15.89 15.89 0 0 1-18.123-3.08L3.466 92.207c-4.626-4.218-4.62-11.502.012-15.713l14.05-12.773a10.625 10.625 0 0 1 13.569-.603l207.132 157.135c6.949 5.271 16.93.315 16.93-8.408v.611a15.94 15.94 0 0 1-9.024 14.36"
        />
        <path
          fill="#1f9cf0"
          d="M193.428 252.134a15.89 15.89 0 0 1-18.125-3.083c5.881 5.88 15.938 1.715 15.938-6.603V11.273c0-8.318-10.057-12.483-15.938-6.602a15.89 15.89 0 0 1 18.125-3.084l52.533 25.263a15.94 15.94 0 0 1 9.03 14.363V212.51c0 6.125-3.51 11.709-9.03 14.363z"
        />
        <path fill={`url(#${sheen})`} fillOpacity=".25" d={VSCODE_OUTLINE} />
      </g>
    </svg>
  );
}

/** The apps Concord has a logo for. */
export type AgentApp = 'claude' | 'chatgpt' | 'claude-code' | 'codex' | 'cursor' | 'vscode';

const LOGOS: Record<AgentApp, () => React.JSX.Element> = {
  claude: ClaudeLogo,
  chatgpt: OpenAILogo,
  'claude-code': ClaudeCodeLogo,
  codex: CodexLogo,
  cursor: CursorLogo,
  vscode: VSCodeLogo,
};

/** The names each app registers with, compared after normalizeAgentName. Exact matches only. */
const ALIASES: Record<string, AgentApp> = {
  claude: 'claude',
  'claude code': 'claude-code',
  chatgpt: 'chatgpt',
  codex: 'codex',
  cursor: 'cursor',
  'visual studio code': 'vscode',
  'vs code': 'vscode',
  vscode: 'vscode',
};

/** Lower case, with runs of whitespace (spaces, tabs, non-breaking spaces) collapsed to one space and trimmed. */
export function normalizeAgentName(name: string) {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Which app a connected agent is, from the name it registered with. The whole
 * name must be one of the app's names, optionally followed by one bracketed
 * label: Claude Code registers as "Claude Code (<server name>)". So "Not
 * Claude" or "Cursor-malware" get the generic mark, not an official one.
 *
 * Accepted limit: the name is the app's own claim, and nothing stops another
 * app registering as exactly "Claude". The row already shows that same name as
 * text, so the logo claims no more than the name does. Whether Concord could
 * confirm who made an app is said on the consent page, before it connects.
 */
export function agentAppFor(clientName: string): AgentApp | undefined {
  const name = normalizeAgentName(clientName);
  return ALIASES[name] ?? ALIASES[name.replace(/ ?\([^()]*\)$/, '')];
}

/** The logo for an app, decorative and the same size as in the Connect picker. */
export function AgentLogo({ app }: { app: AgentApp }) {
  const Logo = LOGOS[app];
  return <Logo />;
}
