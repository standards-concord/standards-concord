/**
 * Concord's own release history: the version of the app an alpha tester is
 * using, and what changed in each release. This is about the app, not the
 * ontologies it hosts (those have their own releases).
 *
 * Versions follow semantic-release conventions: nobody picks the number. Each
 * release lists its changes with a Conventional Commits type, and the version
 * is the previous one bumped by the biggest change (breaking → major, feat →
 * minor, fix/perf → patch). `pnpm --filter @concord/server test` checks every
 * entry against that rule and tells you the number to use.
 *
 * To ship a user-facing change, add a release at the top of APP_RELEASES (one
 * per merged pull request, like semantic-release cutting a release per merge).
 * Say which tester roles it matters to and where to try it, so the walkthrough
 * can send returning testers there and the feedback chat can ask about it.
 */

/** The five roles a tester can pick in the walkthrough (see TESTER_ROLES in the web app). */
export type TesterRoleKey = 'steward' | 'contributor' | 'member' | 'odi' | 'agent';
export const TESTER_ROLE_KEYS: TesterRoleKey[] = ['steward', 'contributor', 'member', 'odi', 'agent'];

/** Conventional Commits types that cut a release. */
export type AppChangeType = 'feat' | 'fix' | 'perf' | 'breaking';

export interface AppChange {
  /** Stable id, unique across all releases (used in feedback answers, so never reuse one). */
  id: string;
  type: AppChangeType;
  /** Short, plain-English title a tester would recognise. */
  title: string;
  /** One or two sentences on what's different. */
  detail: string;
  /** Tester roles this matters most to. Empty means everyone. */
  roles: TesterRoleKey[];
  /** Where to try it. `{o}` stands for the demo ontology's path (/o/<id>). */
  to?: string;
  /** Walkthrough tasks (ids from tasksFor in the web app) this change touches. */
  tasks?: string[];
  /** A specific feedback question about this change. Features get a generic one if this is missing. */
  ask?: string;
}

export interface AppRelease {
  version: string;
  /** Release date (YYYY-MM-DD). */
  date: string;
  title: string;
  /** Pull request in standards-concord/standards-concord, if there was one. */
  pr?: number;
  changes: AppChange[];
}

/** Newest first. */
export const APP_RELEASES: AppRelease[] = [
  {
    version: '0.45.0',
    date: '2026-11-10',
    title: 'Worked examples in every release',
    changes: [
      {
        id: 'worked-examples',
        type: 'feat',
        title: 'See the questions a standard can answer',
        detail: 'Public pages show worked examples with answers, queries and downloadable data, frozen with each release. On Validate data, use the version’s example data as a starting point.',
        roles: [],
        to: '/def/volunteering#tab-examples',
      },
    ],
  },
  {
    version: '0.44.1',
    date: '2026-11-07',
    title: 'Validate data takes every value the ontology allows',
    pr: 117,
    changes: [
      {
        id: 'derived-datatypes-validate',
        type: 'fix',
        title: 'Numbers and dates written as a narrower type now pass Validate data',
        detail: 'A minimum age written as "16"^^xsd:unsignedByte, or a time written as an xsd:dateTimeStamp, was reported as the wrong type although the ontology allows it. Datatypes an ontology defines itself are now checked as the type they are based on, with their limits.',
        roles: ['agent', 'contributor'],
        to: '{o}/validate',
      },
    ],
  },
  {
    version: '0.44.0',
    date: '2026-11-07',
    title: 'Read Concord with no connection',
    pr: 116,
    changes: [
      {
        id: 'offline-reading',
        type: 'feat',
        title: 'Pages you have opened work offline',
        detail:
          'Concord now saves the app and the pages you open while signed in on this device. With no connection, or after a reload on a train, it opens as you and shows what it saved: lists, change requests, releases, use cases, meetings, the ontology itself. A notice says you’re offline. Changes still need a connection for now. Only your account can see what was saved, and signing out deletes it.',
        roles: [],
        to: '{o}/changes',
        ask: 'Did Concord show what you expected when you were offline? Was anything missing that you needed?',
      },
    ],
  },
  {
    version: '0.43.0',
    date: '2026-11-07',
    title: 'Fewer words on the welcome page and around the hub',
    changes: [
      {
        id: 'shorter-welcome',
        type: 'feat',
        title: 'A shorter welcome page and walkthrough start',
        detail:
          'The welcome page keeps one paragraph on what Concord is for, the videos and the note not to enter anything confidential; the aim cards, the numbered steps and the closing box are gone. On the walkthrough page, the version picker and the sign-in prompt fold into one “What’s new since you last tested?” link.',
        roles: [],
        to: '/welcome',
        ask: 'Did the welcome page tell you enough to get started?',
      },
      {
        id: 'less-repetition',
        type: 'feat',
        title: 'Less repetition on the overview, use cases, governance and Validate data',
        detail:
          'The overview line just counts classes, properties and use cases. Use case rows say who and when, with the rest on each use case’s page. Governance shows the policy template only while you edit the policy, and Validate data drops its standing line about size limits (an error says when data goes over one).',
        roles: [],
        to: '{o}',
      },
      {
        id: 'drafted-automatically',
        type: 'fix',
        title: 'A release the policy drafted says “Drafted automatically”',
        detail: 'It used to say “Drafted by someone”. FAIR check messages also count properly now (“1 keyword”, not “1 keyword(s)”).',
        roles: ['steward'],
        to: '{o}/releases',
      },
    ],
  },
  {
    version: '0.42.0',
    date: '2026-11-07',
    title: 'Ontologies checked with what they import, and federations',
    pr: 109,
    changes: [
      {
        id: 'import-checks',
        type: 'feat',
        title: 'Every change is checked together with the ontologies it imports',
        detail:
          'An ontology that imports another is now reasoned over with that ontology loaded, so a change that contradicts it is caught, and the checks say which import the problem comes from. Imports that aren’t on Concord are listed as not checked. The Overview shows what an ontology builds on, and anyone signed in can propose importing another.',
        roles: ['steward', 'contributor'],
        to: '{o}#imports-title',
        ask: 'When an import causes a problem, is it clear what to change?',
      },
      {
        id: 'federations',
        type: 'feat',
        title: 'Federations: check that ontologies work together (Advanced features)',
        detail:
          'With Advanced features on, the hub links to Federations: sets of ontologies, each at a chosen release or following its working draft, that are meant to be used together. Concord checks them alone and together and says which pair conflicts. A change to an ontology that follows its draft is checked against each federation it is in; if the ontology’s owners committed it to the federation, a change that breaks it fails.',
        roles: ['steward'],
        to: '/f',
        ask: 'Would you use a federation to keep related standards consistent?',
      },
      {
        id: 'federation-releases',
        type: 'feat',
        title: 'Federation releases pin every ontology to its content hash',
        detail:
          'A federation’s owners can publish a release once every ontology in it is at a release and they work together. It pins each ontology, and everything they import, to its version and an RDFC-1.0 content hash, with the hash of the SHACL shapes derived from them, and is published as an ontology anyone can import at /def/fed/<name>/<version>. The next version is suggested from how the ontologies moved.',
        roles: ['steward'],
        to: '/f',
      },
      {
        id: 'federation-compare',
        type: 'feat',
        title: 'Sub-federations, and comparing two federations term by term',
        detail:
          'A federation can extend another, such as financial services building on government concepts. Compare shows, for every term, whether it is the same, means the same, is refined, loosened or contradicted, or exists on one side only, and how many shared terms the two agree on.',
        roles: ['steward'],
        to: '/f',
        ask: 'Does the comparison tell you whether one federation is safe to use with another?',
      },
      {
        id: 'federation-forks',
        type: 'feat',
        title: 'Fork a federation, propose it back, and hand settled terms upstream',
        detail:
          'Anyone can fork a federation: a development fork tries changes (including an ontology’s development fork as a member) and proposes them back for the original’s owners to accept or decline; a divergent fork goes its own way. A federation that extends another can hand its settled terms upstream: each becomes a change request on an ontology of the federation it extends, re-created there and linked back to the original term.',
        roles: ['steward'],
        to: '/f',
        ask: 'Would handing terms upstream this way work for your standard?',
      },
    ],
  },
  {
    version: '0.41.4',
    date: '2026-11-07',
    title: 'Tidier “Validate from your own code”',
    pr: 104,
    changes: [
      {
        id: 'validate-api-help-tidy',
        type: 'fix',
        title: 'The curl examples on Validate data are highlighted and line up',
        detail:
          'In Validate data’s “Validate from your own code” section, the curl examples are now syntax-highlighted like the rest of Concord’s code, each in one box with its own copy button, and the section no longer runs into the card’s edges. The key facts (address, body, answer, status, limits) are a short list instead of one long paragraph.',
        roles: ['contributor', 'member', 'agent'],
        to: '{o}/validate',
        ask: 'Are the examples easy to read and copy?',
      },
    ],
  },
  {
    version: '0.41.3',
    date: '2026-11-07',
    title: 'Sections you have opened come back at once',
    pr: 102,
    changes: [
      {
        id: 'instant-sections',
        type: 'perf',
        title: 'Moving between sections is instant',
        detail: 'Change requests, releases, meetings, forks, use cases, app checks, agent reports and the overview show what they showed last time straight away when you come back to them, and quietly bring it up to date. The main lists are also fetched in the background once you open an ontology, so even the first visit to Change requests, Releases, Forks, Use cases or Meetings is instant. Nothing is kept for the next person after you sign out.',
        roles: [],
        to: '{o}/changes',
        ask: 'Does moving between sections feel instant now? Did you ever see out-of-date information that confused you?',
      },
    ],
  },
  {
    version: '0.41.2',
    date: '2026-11-06',
    title: 'Concord’s own icon on the connector and in the tab',
    pr: 106,
    changes: [
      {
        id: 'concord-app-icon',
        type: 'fix',
        title: 'Concord’s icon on the MCP connector and the browser tab',
        detail: 'Claude and other agents now show Concord’s plane for the Concord connector instead of a generic plug, and the browser tab shows it in every look, the ODI look included. The ODI logo stays in the ODI look’s header.',
        roles: ['agent'],
        to: '/connect',
      },
    ],
  },
  {
    version: '0.41.1',
    date: '2026-11-06',
    title: 'App checks work from any repository',
    pr: 108,
    changes: [
      {
        id: 'app-check-action-public',
        type: 'fix',
        title: 'The app check workflow uses a public action',
        detail:
          'The workflow on App checks now uses standards-concord/app-check@v1, the action’s own public home. Before, it pointed inside Concord’s repository, which only repositories in the standards-concord organisation can use while that repository is private. If you added the workflow before today, change its uses: line to standards-concord/app-check@v1.',
        roles: ['contributor', 'member', 'steward'],
        to: '{o}/apps',
      },
    ],
  },
  {
    version: '0.41.0',
    date: '2026-11-06',
    title: 'Logos for your connected agents',
    pr: 105,
    changes: [
      {
        id: 'connected-agent-logos',
        type: 'feat',
        title: 'Each connected agent shows its app’s logo',
        detail:
          'Under Connected agents, Claude, Claude Code, ChatGPT, Codex, Cursor and VS Code now show their logos beside their names, so you can see at a glance what you’ve connected. Other apps get a plain agent icon.',
        roles: ['agent'],
        to: '/connect#agents',
      },
    ],
  },
  {
    version: '0.40.0',
    date: '2026-11-06',
    title: 'One picture of the ontology, and a simpler Query',
    changes: [
      {
        id: 'diagram-only',
        type: 'feat',
        title: 'Browse has List and Diagram; the Graph view is gone',
        detail:
          'The Graph view drew the same classes as the Diagram, in a layout that was harder to read. Browse now has two views: List, to find a term, and Diagram, to see what data each class has and how the classes connect. Old links to the Graph open the Diagram.',
        roles: [],
        to: '{o}/browse?view=diagram',
        ask: 'Did you use the Graph view for anything the Diagram doesn’t do?',
      },
      {
        id: 'query-no-dataset-choice',
        type: 'feat',
        title: 'Query runs over your sample data without asking',
        detail:
          'There is no “Run against” choice any more: when your sample data has records, queries run over the ontology plus those records, and the results say so. The keyboard hints moved into a Keyboard shortcuts pop-up beside the editor; “Tab moves to the next control” stays in view.',
        roles: [],
        to: '{o}/query',
        ask: 'Did you ever need to run a query over the ontology alone while you had sample data?',
      },
    ],
  },
  {
    version: '0.39.0',
    date: '2026-11-06',
    title: 'Instant term browsing, and data checked in your browser',
    pr: 92,
    changes: [
      {
        id: 'validate-in-browser',
        type: 'feat',
        title: 'Validate data runs in your browser',
        detail: 'Validate data now checks your data on your own device with sparq, as you type or as soon as you pick a file, in a few milliseconds. There is no Validate button, your data never leaves your device, and it keeps working if the connection drops once the page has loaded. The POST API at the ontology address still runs the same check for tools and agents.',
        roles: ['contributor', 'member', 'agent'],
        to: '{o}/validate',
        ask: 'Does checking as you type feel instant, and is it clear that your data stays on your device?',
      },
      {
        id: 'check-data-merged',
        type: 'feat',
        title: 'Check data is now part of Validate data',
        detail: 'Query no longer has a Check data tab. Validate data starts with the sample records Query runs over, and in Turtle it underlines problems in the editor, lists them with their line (click one to jump there), autocompletes the ontology’s terms and can tidy the layout with Format. Query’s Edit sample data link opens it.',
        roles: ['contributor', 'member'],
        to: '{o}/validate',
        ask: 'Is it clear where to check your data now, and do you miss anything from the old Check data tab?',
      },
      {
        id: 'instant-term-browsing',
        type: 'perf',
        title: 'Clicking between terms is instant',
        detail: 'Term details, what uses each term, and search now come from the ontology the page already holds, so following a link in Browse shows the term at once instead of waiting for the server.',
        roles: [],
        to: '{o}/browse',
      },
    ],
  },
  {
    version: '0.38.0',
    date: '2026-11-06',
    title: 'Connect your app with GitHub, no token needed',
    pr: 98,
    changes: [
      {
        id: 'app-checks-github-app',
        type: 'feat',
        title: 'Connect an app for app checks with GitHub',
        detail:
          'On App checks, Connect with GitHub installs the Concord app on your app’s repository. There’s no token to store: Concord opens the pull request that adds the workflow, and starts a run as soon as a change is proposed or edited instead of every 30 minutes. The token route is still there for other CI.',
        roles: ['contributor', 'member', 'steward'],
        to: '{o}/apps',
        ask: 'Was connecting with GitHub clearer than copying a token and a workflow? Would you install a Concord app on your repository?',
      },
    ],
  },
  {
    version: '0.37.0',
    date: '2026-11-06',
    title: 'Tidier Browse pages and plain type names',
    pr: 93,
    changes: [
      {
        id: 'browse-list-view',
        type: 'feat',
        title: 'Fold away the class list',
        detail: 'In Browse, the class list now folds away like the property lists, and the view is called List (beside Diagram and Graph) instead of Classes.',
        roles: [],
        to: '{o}/browse',
      },
      {
        id: 'plain-datatype-names',
        type: 'fix',
        title: 'Types like Boolean and String, not xsd:boolean',
        detail: 'Property types now read as plain names (Boolean, String, Non-negative integer, Date and time). Hover over one to see the exact XSD type.',
        roles: [],
        to: '{o}/browse',
      },
      {
        id: 'alignment-sweep',
        type: 'fix',
        title: 'Things line up again',
        detail:
          'A long property name that wraps onto two lines stays left-aligned instead of centring. The governance rules start in one column, every governance section has an icon, system events in the activity feed get a round icon, and the Concord name is no longer cut short on a phone.',
        roles: [],
        to: '{o}/browse',
      },
    ],
  },
  {
    version: '0.36.0',
    date: '2026-11-06',
    title: 'Fewer technical details, everywhere',
    changes: [
      {
        id: 'fewer-details',
        type: 'feat',
        title: 'Less about how Concord works, more about the standard',
        detail:
          'Lint is now "Quality checks", and style suggestions only show with Advanced features on. Only editors can open a competency question to its SPARQL. Change requests no longer restate their edits in the AI analysis, and say where they came from only when it isn’t the default. Fork pages lose the MCP tool names and list two formats up front. Source & export keeps Turtle, JSON-LD and SHACL up front, with the rest under More formats. "How many" on a class reads "Optional", "At least one" and so on. The ontology IRI moves into Ontology details, and meeting summaries count only what the call produced.',
        roles: [],
        to: '{o}',
        ask: 'Is there anything you used to rely on that you can no longer find?',
      },
    ],
  },
  {
    version: '0.35.1',
    date: '2026-11-06',
    title: 'Governance is always in the ontology nav',
    pr: 95,
    changes: [
      {
        id: 'governance-always-shown',
        type: 'fix',
        title: 'No more “Show all sections” toggle',
        detail:
          'Governance used to be hidden from the ontology nav unless you were an owner, steward or ODI oversight, with a “Show all sections (Governance)” button to bring it back. Every role now sees Governance, so anyone can read the policy and who holds which role. Only owners can still edit the policy.',
        roles: [],
        to: '{o}/governance',
      },
    ],
  },
  {
    version: '0.35.0',
    date: '2026-11-06',
    title: 'Advanced features, and a diff on every change',
    pr: 94,
    changes: [
      {
        id: 'turtle-diff',
        type: 'feat',
        title: 'See a change as a diff of the Turtle file',
        detail:
          'Each change request has a Diff tab showing the ontology file before and after, line by line, like a code review on GitHub. It replaces the raw Triples view.',
        roles: [],
        to: '{o}/changes',
        ask: 'Does the diff make it clearer what a change really does to the file?',
      },
      {
        id: 'advanced-features',
        type: 'feat',
        title: 'Query is now an advanced feature',
        detail:
          'Settings has a new Advanced features switch, off by default. Turn it on to see Query under Explore. Links straight to a query page still work.',
        roles: [],
        to: '/settings',
        ask: 'Is there anything else you would rather see only when you ask for it?',
      },
      {
        id: 'fewer-geeky-details',
        type: 'feat',
        title: 'Fewer under-the-hood details',
        detail:
          'Reasoner details and Check again in this browser are gone. FAIR and quality check codes now appear when you hover over a tick or cross. Commit hashes on releases and forks, and the canned SPARQL examples menu, have been removed.',
        roles: [],
        to: '{o}#health',
      },
    ],
  },
  {
    version: '0.34.0',
    date: '2026-11-06',
    title: 'See who runs an ontology at a glance',
    pr: 91,
    changes: [
      {
        id: 'role-rings',
        type: 'feat',
        title: 'Coloured rings for owners, stewards and ODI oversight',
        detail:
          'In the members list, owners, the steward (who chairs) and ODI oversight have a coloured ring round their picture, with a small key underneath. Hover over a picture to see their roles. Role chips on the Governance page use the same colours.',
        roles: [],
        to: '{o}',
        ask: 'Could you tell who runs the working group from the rings? Are the colours clear in the look you use?',
      },
    ],
  },
  {
    version: '0.33.0',
    date: '2026-11-06',
    title: 'Coloured workflow file for app checks',
    pr: 90,
    changes: [
      {
        id: 'app-checks-yaml-highlight',
        type: 'feat',
        title: 'The app checks workflow file is colour-coded',
        detail:
          'When you connect an app, the workflow file to add to its repository is now syntax-highlighted like the rest of Concord’s code, so its settings, values and comments are easier to tell apart.',
        roles: ['contributor', 'member', 'steward'],
        to: '{o}/apps',
      },
    ],
  },
  {
    version: '0.32.0',
    date: '2026-11-05',
    title: 'Less to read on every page',
    pr: 86,
    changes: [
      {
        id: 'simpler-wording',
        type: 'feat',
        title: 'Less text, and only what needs your attention',
        detail:
          'FAIR checks list only the failing ones until you choose Show all. Engine names and timings (which reasoner ran, how many milliseconds) are tucked under Reasoner details, and several page introductions are shorter.',
        roles: [],
        to: '{o}#health',
        ask: 'Is there anything on the page you now miss, or anything else that still feels like too much to read?',
      },
    ],
  },
  {
    version: '0.31.0',
    date: '2026-11-05',
    title: 'Profile pictures in the demo',
    pr: 82,
    changes: [
      {
        id: 'demo-avatars',
        type: 'feat',
        title: 'Profile pictures for everyone in the demo',
        detail: 'The simulated working group and your demo account now have profile pictures instead of initials.',
        roles: [],
      },
    ],
  },
  {
    version: '0.30.0',
    date: '2026-11-05',
    title: 'Feature clips on the welcome page',
    pr: 81,
    changes: [
      {
        id: 'welcome-feature-clips',
        type: 'feat',
        title: 'Short clips of single features on the welcome page',
        detail:
          'The welcome page has a playlist of short narrated clips, one feature each: validating data, the use-case interview, meetings, agent reports, voting, and setting the rules. Pick one from the list, or let them play in turn.',
        roles: [],
        to: '/welcome#clips',
        ask: 'Did the clips help you understand features you hadn’t tried yet? Which feature would you most like a clip of next?',
      },
    ],
  },
  {
    version: '0.29.0',
    date: '2026-11-05',
    title: 'App checks and autopilot',
    pr: 17,
    changes: [
      {
        id: 'app-checks',
        type: 'feat',
        title: 'Test your app against every proposed change',
        detail:
          'Connect your app under Changes → App checks, and its CI tests it against every proposed change before the change merges. Results show in each change request’s Checks tab.',
        roles: ['contributor', 'member', 'steward'],
        to: '{o}/apps',
        ask: 'Was it clear how to connect your app’s CI, and would its results on a change request help you decide on the change?',
      },
      {
        id: 'app-autopilot',
        type: 'feat',
        title: 'Autopilot votes yes when your app passes',
        detail:
          'Turn on autopilot for a connected app and Concord approves or votes yes for you when the app passes a change, then takes the yes back if it later fails. Anything you say yourself always wins.',
        roles: ['contributor', 'member', 'steward'],
        to: '{o}/apps',
        ask: 'Would you trust autopilot to approve or vote for you when your app passes? What would you want to see first?',
      },
    ],
  },
  {
    version: '0.28.0',
    date: '2026-11-05',
    title: 'Forks you can build against today',
    pr: 19,
    changes: [
      {
        id: 'development-forks',
        type: 'feat',
        title: 'Fork an ontology and use your new terms straight away',
        detail:
          'Make a personal fork, add the terms your application needs and import it from its own URL in any format (Turtle, JSON-LD, JavaScript classes, an npm package and more) while the terms go through review. Propose the fork upstream in one step; Concord tells you when everything has landed and which URL to switch to. Coding agents can do all of this over MCP.',
        roles: ['contributor', 'agent'],
        to: '{o}/forks',
        ask: 'Would a fork like this let you keep building while a term is reviewed? What would stop you using it?',
      },
    ],
  },
  {
    version: '0.27.0',
    date: '2026-11-05',
    title: 'Review rounds: Resubmit asks reviewers again',
    pr: 47,
    changes: [
      {
        id: 'review-rounds',
        type: 'feat',
        title: 'Resubmitting or changing the edits starts a new review round',
        detail:
          'Approvals and requests for changes from an earlier round are marked as such and no longer count, and reviewers are asked to look again. Objections, and votes against, stand until the person changes them. Reviewers can approve straight from Needs work.',
        roles: ['steward', 'member'],
        to: '{o}/changes',
        ask: 'When a change request came back to you after being resubmitted or edited, was it clear that you needed to review it again?',
      },
      {
        id: 'resubmit-works',
        type: 'fix',
        title: 'Resubmit no longer bounces straight back to Needs work',
        detail: 'After a reviewer asked for changes, Resubmit used to do nothing because the old request for changes still counted. Now the request goes back to review.',
        roles: ['contributor'],
        to: '{o}/changes',
      },
    ],
  },
  {
    version: '0.26.1',
    date: '2026-11-05',
    title: 'Links that look like buttons take one Tab',
    pr: 71,
    changes: [
      {
        id: 'single-link-buttons',
        type: 'fix',
        title: 'One tab stop for each link that looks like a button',
        detail:
          'Sign in, Give feedback, Back to the hub, the walkthrough’s Go and the download buttons were a button inside a link, so the keyboard stopped on them twice and screen readers announced them inconsistently. Each is now a single link.',
        roles: [],
      },
    ],
  },
  {
    version: '0.26.0',
    date: '2026-11-05',
    title: 'Edit a term where you read it',
    pr: 28,
    changes: [
      {
        id: 'inline-term-edit',
        type: 'feat',
        title: 'Edit a term from Browse',
        detail:
          'Next to “Report a problem”, Edit lets you change a term’s label, definition, comment, other names, examples and editorial note in place. Saving opens a change request; nothing changes until it is reviewed and merged.',
        roles: [],
        to: '{o}/browse',
        ask: 'Was it easy to propose a change to a term from Browse, and to find your change request afterwards?',
      },
      {
        id: 'safer-merges',
        type: 'fix',
        title: 'Merges and releases no longer clash',
        detail:
          'A change request or release that two people act on at once is now handled one at a time, so a merge can’t be lost, applied twice, or go out without the approval it was checked against.',
        roles: ['steward'],
        to: '{o}/changes',
      },
    ],
  },
  {
    version: '0.25.0',
    date: '2026-11-05',
    title: 'Ask for a query in plain words',
    pr: 38,
    changes: [
      {
        id: 'query-chat',
        type: 'feat',
        title: 'Describe what you want and the assistant writes the SPARQL',
        detail:
          'The visual query builder is replaced by a chat beside the SPARQL editor: describe what you want to find, and each message writes or refines the query. Read it, then press Run. Start over clears the chat and puts the starting query back.',
        roles: [],
        to: '{o}/query',
        ask: 'Did the assistant write the query you meant? Where did you have to rephrase or fix it by hand?',
      },
      {
        id: 'query-runs-safely',
        type: 'fix',
        title: 'Big or slow queries can be cancelled and no longer freeze the page',
        detail: 'Queries run in the background with a Cancel button, a time limit and a memory cap. Queries that would build enormous values are refused before they run, and very long values are shortened in the results.',
        roles: [],
        to: '{o}/query',
      },
    ],
  },
  {
    version: '0.24.0',
    date: '2026-11-05',
    title: 'Each role sees what it needs, and agents live in one place',
    pr: 37,
    changes: [
      {
        id: 'role-based-views',
        type: 'feat',
        title: 'Your role in brackets, and a nav that fits it',
        detail:
          'The account button shows the role you’re trying Concord as. Governance appears in the ontology nav for stewards, owners and ODI oversight; everyone else gets “Show all sections”, and the policy is summarised where you review and vote.',
        roles: [],
        to: '{o}',
        ask: 'Did the sections you saw fit the role you picked, and could you find the governance rules when you needed them?',
      },
      {
        id: 'connect-agent-hub',
        type: 'feat',
        title: 'Connect an agent, connected agents and tokens on one page',
        detail:
          'The account menu has one “Connect an agent” item. Its page sets up an app and, once you’re signed in, lists the agents you’ve connected and your personal tokens. Appearance has its own page, and the WebID and pod are folded away on Profile.',
        roles: ['agent'],
        to: '/connect',
      },
      {
        id: 'release-approval-record',
        type: 'feat',
        title: 'Releases keep a record of how they were approved',
        detail:
          'A published or rejected release shows the rules, approvals and vote as they stood when it was decided, and says why a rejected one failed. Changing the policy later no longer rewrites that history.',
        roles: ['steward', 'member', 'odi'],
        to: '{o}/releases',
      },
    ],
  },
  {
    version: '0.23.0',
    date: '2026-11-05',
    title: 'Choose who sees your use cases',
    pr: 15,
    changes: [
      {
        id: 'use-case-sharing',
        type: 'feat',
        title: 'Private, working group or public use cases',
        detail:
          'Each use case says who can see it. Interviews start private, calls are shared with the working group, and only public ones can be drafted into changes. You can withdraw one at any time, and whatever came from it is hidden again.',
        roles: ['contributor', 'member', 'steward'],
        to: '{o}/use-cases',
        tasks: ['interview', 'synthesise'],
        ask: 'Was it clear who could see your use case, and how to change that?',
      },
      {
        id: 'use-case-anonymised',
        type: 'feat',
        title: 'Publish an anonymised version of a private use case',
        detail: 'For a private use case, Concord can draft a version without names or details that identify anyone. It is only published if you approve it.',
        roles: ['contributor'],
        to: '{o}/use-cases',
        tasks: ['interview'],
      },
      {
        id: 'use-case-traceability',
        type: 'feat',
        title: 'Follow a use case from a call to a release',
        detail:
          'Calls, use cases, change requests and releases link to each other. A use case moves from triage to closed as the changes made from it ship, and each release has a use cases and requirements document.',
        roles: ['member', 'steward', 'odi'],
        to: '{o}/use-cases',
        tasks: ['meeting', 'merge'],
        ask: 'Could you tell which release addressed a use case, and why?',
      },
    ],
  },
  {
    version: '0.22.0',
    date: '2026-11-05',
    title: 'A new Concord logo',
    pr: 52,
    changes: [
      {
        id: 'concorde-logo',
        type: 'feat',
        title: 'A new Concord logo',
        detail:
          'Concord’s mark is now a supersonic plane in two halves that meet, climbing with a slipstream behind it. It sits beside the ODI logo in the ODI look, on its own in the other looks, and (without the slipstream) in the browser tab.',
        roles: [],
        ask: 'Does the new logo feel right for Concord? Is it clear at the size it appears in the header?',
      },
    ],
  },
  {
    version: '0.21.0',
    date: '2026-11-05',
    title: 'OWL reasoning with sparq, also in your browser',
    pr: 51,
    changes: [
      {
        id: 'sparq-reasoning',
        type: 'perf',
        title: 'Faster, stricter OWL reasoning',
        detail:
          'Consistency and class checks now use sparq’s OWL 2 DL reasoner instead of HermiT, and take milliseconds rather than about a second. When the reasoner can’t finish a check, validation says so and doesn’t pass.',
        roles: [],
        to: '{o}#health',
      },
      {
        id: 'reasoner-in-browser',
        type: 'feat',
        title: 'Check the draft again in your own browser',
        detail:
          'The health panel on an ontology’s overview has a “Check again in this browser” button. It runs the same reasoner on your device and tells you whether it agrees with the server.',
        roles: [],
        to: '{o}#health',
        ask: 'Did the in-browser check agree with the server, and was it clear what it did?',
      },
    ],
  },
  {
    version: '0.20.0',
    date: '2026-11-05',
    title: 'The ODI look, and an overview that reads like a report',
    pr: 42,
    changes: [
      {
        id: 'odi-look',
        type: 'feat',
        title: 'Concord now looks like the ODI',
        detail:
          'The default look follows the ODI brand: Helvetica, black on white, ODI blue and the ODI logo, with no all-caps labels. Settings, Appearance still lets you switch to the other looks.',
        roles: [],
        to: '/settings#appearance',
        ask: 'Does Concord feel like an ODI tool now? Is anything harder to read or find?',
      },
      {
        id: 'overview-report',
        type: 'feat',
        title: 'The ontology overview shows what’s waiting for you',
        detail:
          'Each ontology’s front page opens with one plain sentence of counts, a panel listing the changes waiting for you (review, vote, approve, merge or revise), a table of changes in progress and the draft’s health.',
        roles: ['steward', 'member', 'odi'],
        to: '{o}',
        ask: 'When you open an ontology, can you tell straight away what needs you?',
      },
    ],
  },
  {
    version: '0.19.0',
    date: '2026-11-05',
    title: 'Sign in with Solid',
    pr: 66,
    changes: [
      {
        id: 'solid-provider-picker',
        type: 'feat',
        title: 'Sign in with Solid, choosing your provider',
        detail:
          'The login page now says “Sign in with Solid”, with the Solid logo. It opens the same sign-in window as the other Solid Suite apps: pick solidcommunity.net or another provider, enter your WebID, or type your provider’s address.',
        roles: [],
        to: '/login',
        ask: 'Could you find your provider, and was it clear what to choose if you don’t have a pod yet?',
      },
    ],
  },
  {
    version: '0.18.0',
    date: '2026-11-05',
    title: 'A welcome page for testers, with two short videos',
    pr: 60,
    changes: [
      {
        id: 'welcome-page',
        type: 'feat',
        title: 'A welcome page that explains Concord and how to take part',
        detail:
          'The page to start from: what Concord is for, a narrated tour of the platform, a short video on how to take part and give feedback, and the four steps of the alpha. “Alpha tester? Start here” on the sign-in page leads to it.',
        roles: [],
        to: '/welcome',
        ask: 'Did the welcome page and its videos tell you what you needed before you started?',
      },
    ],
  },
  {
    version: '0.17.1',
    date: '2026-11-05',
    title: 'Every app on the Connect page has its logo',
    pr: 65,
    changes: [
      {
        id: 'connect-agent-logos',
        type: 'fix',
        title: 'Every app on the Connect page shows its own logo',
        detail:
          'ChatGPT, Claude Code, Codex, Cursor and VS Code now show their real logos beside Claude’s, instead of lettered placeholders, so you can spot your app at a glance.',
        roles: ['agent'],
        to: '/connect',
      },
    ],
  },
  {
    version: '0.17.0',
    date: '2026-11-05',
    title: 'A privacy policy',
    pr: 63,
    changes: [
      {
        id: 'privacy-policy',
        type: 'feat',
        title: 'A privacy policy explains what Concord keeps about you',
        detail:
          'A new Privacy policy page, linked from the footer of every page and from the sign-in card, says what Google, GitHub and WebID sign-in share, where your contributions are kept, which services process them, and how to have your data deleted.',
        roles: [],
        to: '/privacy',
        ask: 'Does the privacy policy tell you what you’d want to know before signing in?',
      },
    ],
  },
  {
    version: '0.16.0',
    date: '2026-11-05',
    title: 'Share a public summary of your feedback',
    pr: 44,
    changes: [
      {
        id: 'feedback-public-summary',
        type: 'feat',
        title: 'Optionally post a short public summary of your feedback',
        detail:
          'When you send feedback you can tick “Also post a short public summary as a GitHub issue” and write one. Only that summary is posted, exactly as previewed, with no name or answers. You can withdraw it from the thank-you screen right after sending, or email the alpha team later.',
        roles: [],
        to: '/feedback',
        ask: 'Was it clear what would be made public, and would you tick the box?',
      },
    ],
  },
  {
    version: '0.15.0',
    date: '2026-11-05',
    title: 'Sign in with your WebID',
    pr: 46,
    changes: [
      {
        id: 'solid-signin',
        type: 'feat',
        title: 'Sign in with your own WebID (Solid)',
        detail:
          'Already have a Solid pod? Choose “Sign in with your WebID” on the login page. You sign in with your own Solid provider, and Concord checks that your WebID names that provider.',
        roles: [],
        to: '/login',
        ask: 'If you have a WebID, how easy was it to sign in with it?',
      },
      {
        id: 'feedback-readers',
        type: 'feat',
        title: 'See who can read your feedback',
        detail:
          'The feedback page says who can read what you send: the alpha team. The copy saved in your pod is shared read-only with the team’s WebID, and they read it there as that WebID.',
        roles: [],
        to: '/feedback',
        ask: 'Is it clear who can read your feedback?',
      },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-11-05',
    title: 'Check data explains what’s wrong and where',
    pr: 50,
    changes: [
      {
        id: 'check-data-explained',
        type: 'feat',
        title: 'Check data explains problems and shows where they are',
        detail:
          'Problems read as plain sentences using your own prefixes, are underlined in the editor (hover to read), and clicking one jumps to it. Typos and syntax errors are underlined as you type, and Format tidies the Turtle.',
        roles: [],
        to: '{o}/validate',
        ask: 'When Check data finds a problem, can you tell what’s wrong and where to fix it?',
      },
    ],
  },
  {
    version: '0.13.0',
    date: '2026-11-04',
    title: 'Returning testers see what changed',
    changes: [
      {
        id: 'tester-versions',
        type: 'feat',
        title: 'See what’s new since you last tested',
        detail:
          'The alpha pages show which version you’re testing. Sign in and Concord saves the version and your feedback to your own pod; next time it shows what changed, points your role at the new parts and asks about those rather than everything.',
        roles: [],
        ask: 'How useful is seeing what’s changed since your last visit, rather than starting over?',
      },
    ],
  },
  {
    version: '0.12.2',
    date: '2026-11-04',
    title: 'Fixes found by testing every flow',
    pr: 45,
    changes: [
      {
        id: 'a11y-names',
        type: 'fix',
        title: 'Dialogs, switches and answer boxes are properly named',
        detail:
          'Screen readers now announce each dialog by its title, and policy switches, the new-owner picker, the chat box and feedback answers have names. Chips say whether they’re on.',
        roles: [],
      },
      {
        id: 'review-comment-once',
        type: 'fix',
        title: 'A review comment shows once in the Discussion tab',
        detail: 'A review comment on a change request no longer appears twice in its discussion.',
        roles: ['steward', 'member'],
      },
    ],
  },
  {
    version: '0.12.1',
    date: '2026-11-04',
    title: 'Clearer, safer agent connections',
    pr: 34,
    changes: [
      {
        id: 'oauth-consent',
        type: 'fix',
        title: 'The connect screen says who an app is and where access goes',
        detail:
          'When an agent asks to connect, Concord says whether it can confirm who made the app (an unverified app’s name and website are only its own claims) and exactly where access will be sent, including apps on this device.',
        roles: ['agent'],
        to: '/connect',
      },
      {
        id: 'chatgpt-steps',
        type: 'fix',
        title: 'Up-to-date steps for connecting ChatGPT',
        detail: 'The ChatGPT instructions match ChatGPT’s current screens: create Concord as a plugin, install it, then pick it with @ in a chat.',
        roles: ['agent'],
        to: '/connect',
      },
    ],
  },
  {
    version: '0.12.0',
    date: '2026-11-04',
    title: 'SHACL compact syntax and classes for apps',
    pr: 18,
    changes: [
      {
        id: 'shaclc-classes',
        type: 'feat',
        title: 'Shapes in SHACL compact syntax, and generated classes',
        detail:
          'Source & export adds the SHACL shapes in compact syntax, which is much easier to read, and a JavaScript/TypeScript class for every shape so apps can work with the data as objects. Both are also served at the ontology’s URI.',
        roles: ['agent', 'contributor'],
        to: '{o}/source',
        ask: 'How useful are the compact SHACL view and the generated classes for building against the standard?',
      },
      {
        id: 'value-checks',
        type: 'fix',
        title: 'Data checks handle decimals, string types and patterns exactly',
        detail: 'Validating data now checks exact decimal bounds, string subtypes and XSD patterns, and several datatypes on one property.',
        roles: ['agent'],
      },
    ],
  },
  {
    version: '0.11.3',
    date: '2026-11-04',
    title: 'Room under the ontology header',
    pr: 41,
    changes: [
      {
        id: 'header-gap',
        type: 'fix',
        title: 'A clear gap between the ontology header and the page',
        detail: 'Each ontology page has breathing room between its header and the content below.',
        roles: [],
      },
    ],
  },
  {
    version: '0.11.2',
    date: '2026-11-04',
    title: 'Safer sign-in, and feedback for administrators only',
    pr: 40,
    changes: [
      {
        id: 'signin-hardening',
        type: 'fix',
        title: 'Signing in with Google or GitHub is safer',
        detail:
          'Each Google or GitHub identity has its own account: signing in never joins an account just because the email address matches, and a sign-in that didn’t start in your browser is refused.',
        roles: [],
      },
      {
        id: 'feedback-admins',
        type: 'fix',
        title: 'Only administrators can read testers’ feedback',
        detail:
          'Everyone’s feedback is readable only by this deployment’s administrators, signed in with Google or GitHub. Ontology roles and demo personas no longer count, and Feedback admin is gone from everyone else’s menu.',
        roles: ['odi'],
      },
    ],
  },
  {
    version: '0.11.1',
    date: '2026-11-04',
    title: 'Tidier ontology header',
    pr: 33,
    changes: [
      {
        id: 'header-alignment',
        type: 'fix',
        title: 'Header chips and the health breakdown line up',
        detail: 'The chips in each ontology’s header and the breakdown behind its health status are aligned.',
        roles: [],
      },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-11-04',
    title: 'Source & export, and Query & validate',
    pr: 13,
    changes: [
      {
        id: 'source-export',
        type: 'feat',
        title: 'Pick a format from one dropdown on Source & export',
        detail: 'The Source page is now Source & export, with every format (Turtle, LinkML, JSON-LD, SHACL and the rest) in one dropdown.',
        roles: ['steward', 'contributor', 'agent', 'odi'],
        to: '{o}/source',
        tasks: ['linkml'],
        ask: 'Could you find the format you wanted on Source & export?',
      },
      {
        id: 'query-workspace',
        type: 'feat',
        title: 'Query & validate shows one workspace at a time',
        detail: 'Query & validate puts the query builder, the SPARQL editor and SHACL validation one at a time, and long results are paginated.',
        roles: ['steward', 'agent', 'contributor'],
        to: '{o}/query',
      },
      {
        id: 'query-builder-fixes',
        type: 'fix',
        title: 'Query builder fixes',
        detail: 'Number filters accept every number format, and the builder’s queries match what it shows.',
        roles: [],
      },
    ],
  },
  {
    version: '0.10.0',
    date: '2026-11-04',
    title: 'Clearer change requests and governance',
    pr: 22,
    changes: [
      {
        id: 'cr-decision',
        type: 'feat',
        title: 'Change requests lead with the decision',
        detail:
          'Each change request has Changes, Checks and Discussion views and one Decision card with the next step, what’s blocking it and what you can do. The patch, minor or major level explains itself.',
        roles: ['steward', 'member', 'odi', 'contributor'],
        to: '{o}/changes',
        tasks: ['review', 'vote'],
        ask: 'Could you tell what a change request needed next, and what you could do about it?',
      },
      {
        id: 'governance-edit',
        type: 'feat',
        title: 'Governance policies are easier to read and edit',
        detail: 'Summaries follow the rules that actually apply. Editing is a separate mode with a preview, Save and Discard, and you can compare every level side by side.',
        roles: ['steward', 'odi'],
        to: '{o}/governance',
        tasks: ['governance'],
        ask: 'Did the governance summary match how you expected decisions to be made?',
      },
      {
        id: 'interview-first',
        type: 'feat',
        title: 'Interviews put the conversation first',
        detail: 'The use case interview shows the chat with a progress strip; the document view and side-by-side are there when you want them.',
        roles: ['contributor'],
        to: '{o}/use-cases',
        tasks: ['interview'],
      },
      {
        id: 'checks-incomplete',
        type: 'fix',
        title: '“Checks incomplete” instead of “Healthy” when the reasoner didn’t run',
        detail: 'An ontology is no longer shown as healthy when a required check could not run.',
        roles: [],
      },
    ],
  },
  {
    version: '0.9.1',
    date: '2026-11-04',
    title: 'More private details behind sign-in',
    pr: 31,
    changes: [
      {
        id: 'private-reads-2',
        type: 'fix',
        title: 'Validation, the simulation and member details need sign-in',
        detail: 'Validation reports, the simulation and owner and count details are no longer readable without signing in.',
        roles: [],
      },
    ],
  },
  {
    version: '0.9.0',
    date: '2026-11-04',
    title: 'Connect ChatGPT',
    pr: 30,
    changes: [
      {
        id: 'chatgpt',
        type: 'feat',
        title: 'Connect ChatGPT as well as Claude and Codex',
        detail: 'The Connect page shows how to add Concord to ChatGPT as a custom connector, with the same OAuth sign-in.',
        roles: ['agent'],
        to: '/connect',
        tasks: ['agent'],
        ask: 'If you use ChatGPT, could you connect it to Concord?',
      },
    ],
  },
  {
    version: '0.8.1',
    date: '2026-11-04',
    title: 'Public pages: privacy and accuracy fixes',
    pr: 24,
    changes: [
      {
        id: 'public-pages-rereview',
        type: 'fix',
        title: 'Public pages keep use case drafts private',
        detail: 'Public ontology pages no longer show drafted changes that came from private use cases, and stored release pages and their dates are right.',
        roles: [],
      },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-11-04',
    title: 'Agent reports get their own page',
    pr: 25,
    changes: [
      {
        id: 'agent-pages',
        type: 'feat',
        title: 'Agent reports and “Connect an agent” are separate',
        detail: 'Each ontology now has one page for the gaps agents have reported and another for connecting your own agent.',
        roles: ['agent', 'steward'],
        to: '{o}/agents',
        tasks: ['agent'],
        ask: 'Is it clear where to connect an agent and where to read what agents have reported?',
      },
      {
        id: 'private-reads',
        type: 'fix',
        title: 'Private material stays behind sign-in',
        detail: 'Use cases, meeting transcripts and other non-public material can no longer be read without signing in.',
        roles: [],
      },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-11-04',
    title: 'One-click agent connections',
    pr: 6,
    changes: [
      {
        id: 'mcp-oauth',
        type: 'feat',
        title: 'Connect a coding agent in one click',
        detail: 'The MCP connector signs you in with OAuth, so there are no tokens to copy. The Connect page has install links for Claude, Claude Code and Codex.',
        roles: ['agent'],
        to: '/connect',
        tasks: ['agent'],
        ask: 'How easy was it to connect your coding agent?',
      },
    ],
  },
  {
    version: '0.6.1',
    date: '2026-11-04',
    title: 'Public pages: safety fixes',
    pr: 21,
    changes: [
      {
        id: 'public-pages-safety',
        type: 'fix',
        title: 'Public pages are safer and serve the right format',
        detail: 'Text on public pages is escaped, private material stays out, and asking for RDF gets RDF.',
        roles: [],
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-11-04',
    title: 'A new look',
    pr: 16,
    changes: [
      {
        id: 'looks',
        type: 'feat',
        title: 'A new look, with three to choose from',
        detail: 'Concord now looks like a specification rather than a generic AI app. You can switch between the Specification, Civic grid and Workbench looks under Settings, Appearance.',
        roles: [],
        to: '/settings',
        ask: 'Which look would you want to use day to day, and why?',
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-11-04',
    title: 'Public ontology pages',
    pr: 14,
    changes: [
      {
        id: 'public-pages',
        type: 'feat',
        title: 'Public pages at each ontology and version IRI',
        detail: 'Every ontology and released version has a public page at its IRI that anyone can read without signing in. Tools that ask for Turtle or JSON-LD get that instead.',
        roles: ['steward', 'odi', 'member', 'agent'],
        to: '{o}/releases',
        tasks: ['merge'],
        ask: 'Would the public page work as the place you point people to for a released standard?',
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-11-04',
    title: 'Simpler navigation',
    pr: 10,
    changes: [
      {
        id: 'ia-sections',
        type: 'feat',
        title: 'Simpler navigation inside each ontology',
        detail: 'Ontology pages are grouped into a few sections that follow the lifecycle, and each page starts with a summary before the detail.',
        roles: [],
        to: '{o}',
        ask: 'How easy is it to find your way around an ontology now?',
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-11-04',
    title: 'A principled FAIR score',
    pr: 12,
    changes: [
      {
        id: 'fair-score',
        type: 'feat',
        title: 'FAIR score with a breakdown by principle',
        detail: 'The FAIR score is now worked out per principle (Findable, Accessible, Interoperable, Reusable), and shows what to fix to raise it.',
        roles: ['steward', 'odi', 'member'],
        to: '{o}',
        tasks: ['review'],
        ask: 'Does the FAIR breakdown tell you what to fix?',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-11-04',
    title: 'Highlighting and a query builder',
    pr: 8,
    changes: [
      {
        id: 'syntax-highlighting',
        type: 'feat',
        title: 'Syntax highlighting in every format',
        detail: 'Turtle, JSON-LD, RDF/XML, LinkML, YAML-LD, SHACL and the other views are now highlighted.',
        roles: ['steward', 'contributor', 'agent', 'odi'],
        to: '{o}/source',
        tasks: ['linkml'],
      },
      {
        id: 'query-builder',
        type: 'feat',
        title: 'SPARQL highlighting and a visual query builder',
        detail: 'The Query page highlights SPARQL and can build a query for you from the classes and properties you pick.',
        roles: ['steward', 'agent', 'contributor'],
        to: '{o}/query',
        ask: 'Could you get the answer you wanted out of the Query page?',
      },
      {
        id: 'query-wasm',
        type: 'fix',
        title: 'The Query page loads again',
        detail: 'Fixed the WebAssembly error that stopped queries running in the browser.',
        roles: [],
        to: '{o}/query',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-14',
    title: 'First prototype',
    pr: 1,
    changes: [
      {
        id: 'prototype',
        type: 'feat',
        title: 'The first Concord prototype',
        detail:
          'Use case interviews by chat or voice, meeting transcripts, change requests classified as patch, minor or major, governance policies, releases, coding agents over MCP, and this guided walkthrough.',
        roles: [],
        to: '/alpha',
      },
    ],
  },
];

/** The version of the app this code is. */
export const APP_VERSION = APP_RELEASES[0].version;

/* ------------------------------------------------------------------ semver */

export function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Negative if a < b, 0 if equal, positive if a > b. Unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [-1, -1, -1];
  const pb = parseVersion(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export type BumpLevel = 'major' | 'minor' | 'patch';

/** The bump semantic-release would make for these changes. */
export function bumpFor(changes: Pick<AppChange, 'type'>[]): BumpLevel {
  if (changes.some((c) => c.type === 'breaking')) return 'major';
  if (changes.some((c) => c.type === 'feat')) return 'minor';
  return 'patch';
}

export function bumpVersion(v: string, level: BumpLevel): string {
  const [ma, mi, pa] = parseVersion(v) ?? [0, 0, 0];
  if (level === 'major') return `${ma + 1}.0.0`;
  if (level === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/* ----------------------------------------------------------------- queries */

export const findRelease = (version: string) => APP_RELEASES.find((r) => compareVersions(r.version, version) === 0 && parseVersion(version));

/** Releases after `since` up to and including `upTo` (default: this version), newest first. */
export function releasesSince(since: string, upTo: string = APP_VERSION): AppRelease[] {
  if (!parseVersion(since)) return [];
  return APP_RELEASES.filter((r) => compareVersions(r.version, since) > 0 && compareVersions(r.version, upTo) <= 0);
}

export interface ChangeWithRelease extends AppChange {
  version: string;
  date: string;
}

export function changesSince(since: string, upTo: string = APP_VERSION): ChangeWithRelease[] {
  return releasesSince(since, upTo).flatMap((r) => r.changes.map((c) => ({ ...c, version: r.version, date: r.date })));
}

/** Does this change matter to someone testing as this role? Changes with no roles matter to everyone. */
export const changeIsFor = (c: Pick<AppChange, 'roles'>, role?: TesterRoleKey) => !c.roles.length || !role || c.roles.includes(role);

/** Changes a tester in this role should look at first: features before fixes, and within each, their role's, then everyone's, then other roles'. */
export function changesFor(changes: ChangeWithRelease[], role?: TesterRoleKey): ChangeWithRelease[] {
  const rank = (c: ChangeWithRelease) => (c.type === 'fix' ? 10 : 0) + (role && c.roles.includes(role) ? 0 : !c.roles.length ? 1 : 2);
  return changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

/* -------------------------------------------------------- tester records */

/** One version a tester has used, as saved in their pod (concord/alpha/testing.jsonld). */
export interface TestedVersion {
  version: string;
  /** Git commit of the web build, when known. */
  commit?: string;
  firstAt: string;
  lastAt: string;
  /** Feedback submitted while on this version. */
  feedbackIds: string[];
  /** Tester roles tried on this version. */
  roles?: TesterRoleKey[];
}

export interface AlphaTesterInfo {
  id: string;
  name: string;
  avatarUrl?: string;
  /** Signed in with Google or GitHub, so they can come back from any browser. */
  lasting: boolean;
  providers: string[];
  podUrl?: string;
}

export interface AlphaMe {
  /** The tester's own account (not the persona they are playing). Undefined when nobody is signed in. */
  tester?: AlphaTesterInfo;
  versions: TestedVersion[];
  /** Where the record lives: their Solid pod, or this server's private store when no Solid server is configured. */
  storedIn?: 'solid' | 'local';
  recordUrl?: string;
  /** The copy in their pod is behind (the pod couldn't be written to); it catches up on a later visit. The history here is complete. */
  podBehind?: boolean;
}

/** The newest version a tester used before `current`, if any. */
export function lastTestedBefore(versions: Pick<TestedVersion, 'version'>[], current: string = APP_VERSION): string | undefined {
  return versions
    .map((v) => v.version)
    .filter((v) => parseVersion(v) && compareVersions(v, current) < 0)
    .sort(compareVersions)
    .at(-1);
}
