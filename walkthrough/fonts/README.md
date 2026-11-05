# Web fonts for recordings

Copies of the Google Fonts files the Concord web app loads, served to the browser during a recording so it renders the same way without network access (see `lib/fonts.ts`). Files are named by a hash of the URL they were fetched from.

The fonts are published by Google Fonts under the SIL Open Font License 1.1 (https://openfontlicense.org), which permits redistribution with software. Don't edit these files; delete one and re-run `pnpm walkthrough --draft` to fetch it again.
