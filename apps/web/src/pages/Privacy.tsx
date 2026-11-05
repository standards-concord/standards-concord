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
export const PRIVACY_CONTACT = 'solid-eng@theodi.org';
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
          <p>Concord only asks for your basic profile, so that other people in a working group can see who said what.</p>
          <ul>
            <li>
              <strong>Google:</strong> your name, your email address (only if Google has verified it), your profile picture and your Google account ID.
            </li>
            <li>
              <strong>GitHub:</strong> your name (or your username if you haven’t set one), your primary verified email address, your profile picture and your GitHub
              user ID.
            </li>
            <li>
              <strong>Your WebID (Solid):</strong> your WebID and the name on your public WebID profile. Concord reads that profile to check which Solid provider
              vouches for you.
            </li>
            <li>
              <strong>Try the demo:</strong> nothing about you. Concord makes up a tester account for that browser.
            </li>
          </ul>
          <p>Concord never sees your password, and it can’t read your email, contacts, files or repositories, or act on your Google or GitHub account. In a Solid pod, it only writes to a <code>concord/</code> folder of its own.</p>
        </Section>

        <Section id="privacy-content" title="What you add">
          <p>Concord keeps what you write and do in it, under your name:</p>
          <ul>
            <li>use cases, interviews with the AI interviewer, and meeting transcripts you upload or that the meeting bot records;</li>
            <li>change requests, comments, reviews and votes;</li>
            <li>answers to the alpha feedback questionnaire and the feedback chat;</li>
            <li>
              your testing history: which versions of Concord you used and when, which roles you tried, and which feedback you sent on each version, so the alpha team
              can ask you about what changed.
            </li>
          </ul>
          <p>
            Members of an ontology’s working group can see what is added to it. When a working group publishes a version of its ontology, that version, its release notes and
            its use cases are public on the web. The alpha team (Concord’s administrators) can read all feedback, including your name and email if you give them; other
            testers can’t.
          </p>
        </Section>

        <Section id="privacy-storage" title="Where it is kept">
          <ul>
            <li>
              <strong>Concord’s servers.</strong> Your account, your interviews, your feedback and testing history, and everything shared with a working group are kept in
              Concord’s backend database; ontologies and their releases are kept as Git repositories. Both are on the cloud servers that host Concord (Microsoft Azure
              today, moving to Vercel and Neon).
            </li>
            <li>
              <strong>Your Solid pod.</strong> When you’re signed in, Concord also writes a copy of your interview transcripts, feedback and testing history to a{' '}
              <code>concord/</code> folder in your Solid pod, and shares its <code>concord/feedback/</code> folder read-only with the alpha team’s WebIDs. We expect you to
              bring your own pod, from a provider such as solidcommunity.net, which keeps it under its own privacy policy; you control it and can delete what Concord
              wrote there yourself. Some Concord test servers still create a pod for you on a pod server Concord runs; if you ask us to delete your account, we delete that pod too (see below). If a pod
              can’t be reached, Concord keeps the copy on its own servers instead.
            </li>
            <li>
              <strong>Your browser.</strong> Concord sets a sign-in cookie that lasts 30 days, a cookie that lasts 30 days and remembers who you are while you switch
              between demo personas, and short-lived cookies (10 minutes) while you sign in. It remembers your chosen look, your walkthrough progress and the link to
              withdraw a public summary in the browser’s own storage.
            </li>
          </ul>
          <p>There is no advertising, and no third-party tracking or analytics.</p>
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
              description you write, and shows them only to that ontology’s editors, stewards and owners. It doesn’t store your IP address with the report: to stop abuse
              it keeps a scrambled form of it in memory only. Entries older than a day are cleared during a later clean-up that a report sets off, or when the server
              restarts. It also sets a cookie on that page for one day.
            </li>
            <li>
              <strong>Public feedback summaries (opt-in).</strong> When you send feedback you can tick a box to post a short summary as a GitHub issue on the Concord
              repository, which is public. Only that summary is posted, exactly as you saw it; your name, email, answers and the conversation are not attached. Concord
              removes links and email addresses from it, but it can’t spot names, so don’t include names, organisations or other details that identify anyone. You can
              withdraw the summary from the thank-you screen straight after sending it: Concord replaces the issue’s title and text and closes it. After you leave that
              screen, or if you need the issue removed entirely (GitHub keeps an edit history), write to us.
            </li>
          </ul>
        </Section>

        <Section id="privacy-deletion" title="Getting your data deleted">
          <p>
            Write to {mail} from the email address on your account, or say which Google, GitHub or WebID account you signed in with. We will delete your account and what you added
            from Concord’s servers within 30 days, and tell you when it is done. That includes a pod Concord created for you on its own pod server. What Concord wrote to a pod you brought yourself is yours to delete with your pod provider. We will tell you if anything can’t be removed, such as text that is
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
