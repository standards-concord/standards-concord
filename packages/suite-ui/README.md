# @jeswr/suite-ui (pinned copy)

The Solid Suite's shared sign-in card (`SignInCard`), its shadcn/Radix primitives and its
styles, copied from [jeswr/solid-sdk](https://github.com/jeswr/solid-sdk) `packages/suite-ui`
at the commit in [VENDORED.json](VENDORED.json). `packages/pod-auth` holds the suite's list
of Solid providers (`KNOWN_PROVIDERS`) from the same commit.

Every suite app shows the same "Sign in with Solid" modal, so Concord uses the suite's
card rather than its own. Neither package is on npm yet, so this is a pinned copy:

- **Don't edit these files.** `pnpm test` (and CI) runs
  `node scripts/vendor-solid-sdk.mjs --check`, which fails if any file differs from what
  the sync wrote. Fix things upstream in solid-sdk, then re-sync.
- **To update:** check out solid-sdk at the commit you want and run
  `node scripts/vendor-solid-sdk.mjs <path to the checkout>`.
- **Once published:** replace both workspace packages with the npm ones. Concord already
  imports them by their published names and subpaths (`@jeswr/suite-ui/sign-in`,
  `@jeswr/suite-ui/styles/sign-in.css`, `@jeswr/pod-auth/directory`).

The sync drops each file's leading authorship comment and copies only `KNOWN_PROVIDERS`
out of pod-auth's `directory.ts`; everything else is byte for byte. `src/index.ts` is
Concord's (it re-exports the dialog). Concord maps the suite's design tokens onto its
own looks in `apps/web/src/suite-bridge.css`.
