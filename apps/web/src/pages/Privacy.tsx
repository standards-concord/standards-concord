import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Page } from '../components/Shell';

/**
 * The privacy policy, public at /privacy (no sign-in needed). Google links to it
 * from the sign-in consent screen, so keep it reachable signed out and keep it
 * true: when Concord starts collecting or sharing something new, say so here
 * and move PRIVACY_UPDATED.
 */

/** Where people write to about their data. */
export const PRIVACY_CONTACT = 'jesse.wright@theodi.org';
/** When the wording last changed (shown on the page). */
export const PRIVACY_UPDATED = '5 November 2026';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-line pt-6">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted [&_strong]:font-medium [&_strong]:text-fg [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">{children}</div>
    </section>
  );
}

const mail = <a href={`mailto:${PRIVACY_CONTACT}`} className="text-accent hover:underline">{PRIVACY_CONTACT}</a>;

export function PrivacyPage() {
  return (
    <Page>
      <article className="max-w-3xl space-y-8">
        <header>
          <div className="page-eyebrow mb-1 text-xs font-medium tracking-wide text-muted uppercase">Last updated {PRIVACY_UPDATED}</div>
          <h1 className="page-title text-2xl font-semibold tracking-tight">Privacy policy</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Concord is an alpha prototype, built for the Open Data Institute (ODI), where working groups design open data standards together. This page
            explains what Concord collects about you, where it is kept, who it is shared with, and how to have it deleted. If anything here is unclear, write to {mail}.
          </p>
        </header>

        <Section id="privacy-sign-in" title="When you sign in">
          <p>Concord only asks Google and GitHub for your basic profile, so that other people in a working group can see who said what.</p>
          <ul>
            <li>
              <strong>Google:</strong> your name, your email address (only if Google has verified it), your profile picture and your Google account ID.
            </li>
            <li>
              <strong>GitHub:</strong> your name (or your username if you haven’t set one), your primary verified email address, your profile picture and your GitHub
              user ID.
            </li>
            <li>
              <strong>Try the demo:</strong> nothing about you. Concord makes up a tester account for that browser.
            </li>
          </ul>
          <p>Concord never sees your password, and it can’t read your email, contacts, files or repositories, or act on your Google or GitHub account.</p>
        </Section>

        <Section id="privacy-content" title="What you add">
          <p>Concord keeps what you write and do in it, under your name:</p>
          <ul>
            <li>use cases, interviews with the AI interviewer, and meeting transcripts you upload or that the meeting bot records;</li>
            <li>change requests, comments, reviews and votes;</li>
            <li>answers to the alpha feedback questionnaire and the feedback chat.</li>
          </ul>
          <p>
            Members of an ontology’s working group can see what is added to it. When a working group publishes a version of its ontology, that version, its release notes and
            its use cases are public on the web.
          </p>
        </Section>

        <Section id="privacy-storage" title="Where it is kept">
          <ul>
            <li>
              <strong>Concord’s database.</strong> Your account, the ontologies and everything shared with a working group are kept in Concord’s backend database, on the
              cloud servers that host Concord (Microsoft Azure today, moving to Vercel and Neon).
            </li>
            <li>
              <strong>Your own Solid pod.</strong> Your interview transcripts and a copy of your feedback go to a Solid pod rather than the shared database. Concord
              doesn’t run pods for you: you bring your own, from a pod provider such as solidcommunity.net, which keeps it under its own privacy policy. You control your
              pod and can delete what Concord wrote there yourself; Concord can’t do that for you. Concord gives its administrators read access to the feedback folder it
              writes in your pod. If you haven’t connected a pod, Concord keeps these files on its own servers instead, and deletes them with your account.
            </li>
            <li>
              <strong>Your browser.</strong> Concord sets a sign-in cookie that lasts 30 days, short-lived cookies (10 minutes) while you sign in, and remembers your chosen
              look and walkthrough progress in the browser’s own storage. There is no advertising or tracking, and no analytics service.
            </li>
          </ul>
        </Section>

        <Section id="privacy-sharing" title="Services that process it for us">
          <p>Concord doesn’t sell or rent your data. It sends some of it to these services, only to do the job you asked for:</p>
          <ul>
            <li>
              <strong>Anthropic (Claude)</strong> reads what you write in interviews, the feedback chat, meetings and change requests, to ask follow-up questions, draft
              changes and write summaries.
            </li>
            <li>
              <strong>OpenAI</strong> transcribes your voice when you speak instead of typing, in browsers that can’t do it themselves.
            </li>
            <li>
              <strong>Recall.ai</strong> joins Google Meet calls you invite the meeting bot to, and passes the call’s captions to Concord.
            </li>
            <li>
              <strong>GitHub</strong> hosts the public feedback summaries you choose to post (below).
            </li>
            <li>
              <strong>Microsoft Azure, Vercel and Neon</strong> host Concord’s website, servers and database.
            </li>
          </ul>
        </Section>

        <Section id="privacy-public" title="Public reports and GitHub issues">
          <ul>
            <li>
              <strong>Reporting a problem on a public ontology page.</strong> Anyone can report a problem with a term without signing in. Concord keeps the title and
              description you write, and shows them only to that ontology’s editors, stewards and owners. It doesn’t store your IP address: to stop abuse it keeps a
              scrambled form of it in memory for at most a day, and sets a cookie on that page for one day.
            </li>
            <li>
              <strong>Public feedback summaries (opt-in).</strong> When you send feedback you can tick a box to post a short summary as a GitHub issue on the Concord
              repository, which is public. Only that summary is posted, exactly as you saw it, with links and email addresses removed. Your name, email, answers and the
              conversation are not posted. You can withdraw it later from the same browser: Concord replaces the issue’s text and closes it. GitHub may still show earlier
              versions in the issue’s edit history, so ask us if you need the issue removed entirely.
            </li>
          </ul>
        </Section>

        <Section id="privacy-deletion" title="Getting your data deleted">
          <p>
            Write to {mail} from the email address on your account, or say which Google or GitHub account you signed in with. We will delete your account and what you added
            from Concord’s servers within 30 days, and tell you when it is done. What Concord wrote to your own Solid pod is yours to delete with your pod provider. We will tell you if anything can’t be removed, such as text that is
            part of a version a working group has already published.
          </p>
          <p>You can also ask us for a copy of what Concord holds about you, or to correct it.</p>
        </Section>

        <Section id="privacy-contact" title="Contact">
          <p>
            Questions or requests about your data: {mail}. If this policy changes, the date at the top changes too. You can go back to <Link to="/login" className="text-accent hover:underline">sign in</Link>.
          </p>
        </Section>
      </article>
    </Page>
  );
}
