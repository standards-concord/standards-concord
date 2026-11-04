# The Google Meet co-lead bot

The co-lead bot joins a Google Meet as a participant, transcribes it, and raises gaps and follow-up questions while people talk. Afterwards Concord turns the transcript into use cases, terms and a draft change request.

There are three ways to bring it into a call, all from the **Meetings** tab of an ontology. Only the ontology's owners, stewards and editors can use them, or change a call afterwards; every change is recorded in the activity log.

- **Schedule through Google Calendar.** Add the bot's address to the calendar invite, for one call or a whole recurring series. The bot is booked shortly before each call. Moving or cancelling the invite, or taking the bot off it, moves or cancels the bot.
- **Join a call now.** Paste a Meet link and the bot is sent straight away.
- **Import calendar occurrences.** Upload an .ics file to book the calls in it that fall in the next two weeks. This is a one-off import: later weeks of a series, and later changes to the invite, are not picked up. Use the email address for anything ongoing.

## Who can bring the bot in by invite

The bot's calendar accepts invites from anyone, so an invite only books a bot straight away when its organiser is one of:

- an owner, steward or editor of the ontology the call is filed under, matched by the email on their Concord account;
- an address or domain in `MEET_BOT_ALLOWED_INVITERS`, such as `@theodi.org,kim@example.org`.

Invites from anyone else show under *Upcoming calls* as **Needs approval**, and no bot is booked until a facilitator approves the call. Declined invites are ignored. The ontology tag in an invite only says where the call is filed; it never grants permission.

## Which ontology a call belongs to

A call that arrives by email is filed under, in this order:

1. the ontology named in a plus-address, such as `concord.bot+volunteering@gmail.com`;
2. a tag in the invite's title or description, such as `#volunteering` or `concord: volunteering`;
3. the one ontology whose name or slug the title or description mentions;
4. `MEET_BOT_DEFAULT_ONTOLOGY`, or the demo ontology.

Prefer the plain address with a tag. We haven't yet confirmed with a real Gmail or Workspace account that invites to a plus-address land on the bot's calendar and keep the address, so treat it as a fallback until it has been tried.

Upcoming calls are listed at the top of the Meetings tab, refreshed every 30 seconds, with when the calendar was last checked and whether each bot is booked. Facilitators can tell the bot to skip a call there. If cancelling a booked bot fails, the call says so and Concord keeps retrying.

## Posting prompts in the Meet chat

By default the bot's prompts only show on the meeting's page in Concord, for the facilitator to raise. Each call has a **Post prompts in the Meet chat automatically** switch (also offered when inviting the bot), and each prompt has a **Post in the Meet chat** button for posting just that one. The bot transcribes either way. When it joins, it says in the chat which of the two it will do, and it posts a short notice whenever a facilitator changes the setting during the call. Agree with the people in the call before switching automatic posting on. `MEET_BOT_POST_TO_CHAT=true` makes posting the default for calls that arrive by invite. Google Meet limits chat messages to 500 characters, so longer prompts are shortened.

## Setting it up

1. **Create the bot's Google account**, for example `concord.odi@gmail.com` (a Google Workspace account works too). In its Google Calendar settings, under *Event settings > Add invitations to my calendar*, choose **From everyone**, so invites from people it hasn't met appear on its calendar.
2. **Copy the calendar's secret iCal address.** In Google Calendar settings, open the bot's calendar under *Settings for my calendars*, then *Integrate calendar > Secret address in iCal format*. Anyone with this address can read the bot's calendar, so treat it like a password. (Workspace admins can switch this address off; if it's missing, ask them to allow it.)
3. **Get a Recall.ai API key** from the Recall.ai dashboard, and note its region (`us-west-2` unless you chose another).
4. **Set the keys on the server:**

   ```sh
   ./deploy/azure/set-key.sh RECALL_API_KEY
   ./deploy/azure/set-key.sh MEET_BOT_EMAIL      # concord.odi@gmail.com
   ./deploy/azure/set-key.sh MEET_BOT_ICS_URL    # the secret iCal address
   ```

   Recommended: `MEET_BOT_ALLOWED_INVITERS` (for example `@theodi.org`). Optional: `RECALL_REGION`, `MEET_BOT_NAME` (the name shown in the call, "Concord co-facilitator" by default), `MEET_BOT_DEFAULT_ONTOLOGY` and `MEET_BOT_POST_TO_CHAT`.

   `PUBLIC_URL` must be the server's public HTTPS address, because Recall.ai sends the live transcript to `PUBLIC_URL/api/webhooks/recall`.

5. **Know what joins the call.** The Google account is only the bot's calendar. The participant that joins is Recall.ai's bot, which is not signed in to that account, so it joins as a guest named `MEET_BOT_NAME`. The host may have to admit it, and meetings restricted to people in an organisation can turn it away. Recall.ai's Google Meet FAQ covers signed-in bots if that becomes a problem.

6. **Check it end to end.** As a facilitator, invite the address to a test call 20 minutes or more ahead, tagged `#<ontology>`. Then check that:
   - the call appears under *Upcoming calls* on the Meetings tab (Google can take several minutes to update the feed);
   - it shows **Bot booked** about 15 minutes before the start;
   - the bot asks to join at the start, and you admit it;
   - transcript lines appear on the meeting's page as people talk (if not, Recall.ai can't reach `PUBLIC_URL`);
   - the bot's intro message, and a prompt you post with **Post in the Meet chat**, show in the Meet chat.

## How it works

Every minute the server reads the bot's calendar feed, lists the calls in the next two weeks that have a Meet link and include the bot as an attendee (each week of a recurring series separately, with moved, skipped and cancelled weeks handled), and keeps a scheduled meeting for each. Fifteen minutes before an approved call it books a Recall.ai bot to join at the start time; Recall.ai asks for ten minutes' notice to guarantee one is free. If the call moves, the booking is cancelled and made again; if it is cancelled, or the bot is taken off the invite, the booking is cancelled and the meeting removed. A booking is only forgotten once Recall.ai confirms the cancellation. Recall.ai sends the live transcript to `/api/webhooks/recall`, which the co-lead bot reads as it arrives. Ten minutes after the call's slot ends and the transcript has gone quiet (or three hours after the end at the latest), the bot leaves and Concord analyses the call.

Reading the calendar as an iCal feed needs no Google sign-in or OAuth app, only the secret address. The server never shows that address: errors reading the feed are reported with the address removed. How quickly Google updates the feed isn't guaranteed and can be several minutes or more, so send invites well ahead of a call. If that proves too slow, the next step is reading the calendar through the Google Calendar API instead.

Without `RECALL_API_KEY`, invites are still picked up and listed, but no bot joins, and the meeting says so when the call starts. **Run a simulated live meeting** on the Meetings tab shows what the bot does.
