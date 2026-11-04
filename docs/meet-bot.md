# The Google Meet co-lead bot

The co-lead bot joins a Google Meet as a participant, transcribes it, and raises gaps and follow-up questions while people talk. Afterwards Concord turns the transcript into use cases, terms and a draft change request.

There are three ways to bring it into a call, all from the **Meetings** tab of an ontology:

- **Invite by email.** Add the bot's address to the calendar invite, for one call or a whole recurring series. The bot joins each call when it starts. Moving or cancelling the invite moves or cancels the bot.
- **Paste a Meet link** to send it into a call that is already happening.
- **Upload an invite (.ics)** to schedule it from a calendar file, without the email address.

## Which ontology a call belongs to

A call that arrives by email is filed under, in this order:

1. the ontology named in a plus-address, such as `concord.bot+volunteering@gmail.com` (the dialog shows the right address for each ontology);
2. a tag in the invite's title or description, such as `#volunteering` or `concord: volunteering`;
3. the one ontology whose name or slug the title or description mentions;
4. `MEET_BOT_DEFAULT_ONTOLOGY`, or the demo ontology.

Upcoming calls are listed at the top of the Meetings tab, where anyone can tell the bot to skip one.

## Posting prompts in the Meet chat

By default the bot's prompts only show on the meeting's page in Concord, for the facilitator to raise. Each call has a **Post prompts in the Meet chat** switch (also offered when inviting the bot), and each prompt has a **Post in the Meet chat** button for posting just that one. When the bot joins, it says in the chat which of the two it will do. `MEET_BOT_POST_TO_CHAT=true` makes posting the default for calls that arrive by invite. Google Meet limits chat messages to 500 characters, so longer prompts are shortened.

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

   Optional: `RECALL_REGION`, `MEET_BOT_NAME` (the name shown in the call, "Concord co-facilitator" by default), `MEET_BOT_DEFAULT_ONTOLOGY` and `MEET_BOT_POST_TO_CHAT`.

5. **Check it.** Invite the address to a call in the next two weeks, then open the Meetings tab of the ontology. The call shows under *Upcoming calls* within a minute.

## How it works

Every minute the server reads the bot's calendar feed, lists the calls in the next two weeks that have a Meet link (each week of a recurring series separately, with moved, skipped and cancelled weeks handled), and keeps a scheduled meeting for each. Fifteen minutes before a call it books a Recall.ai bot to join at the start time; Recall.ai asks for ten minutes' notice to guarantee one is free. If the call moves, the booking is cancelled and made again; if it is cancelled, or the bot is taken off the invite, the meeting is removed. Recall.ai sends the live transcript to `/api/webhooks/recall`, which the co-lead bot reads as it arrives. Ten minutes after the call's slot ends and the transcript has gone quiet, the bot leaves and Concord analyses the call.

Reading the calendar as an iCal feed needs no Google sign-in or OAuth app, only the secret address. Google updates that feed within a few minutes of an invite arriving, so book the bot at least a quarter of an hour before a call.

Without `RECALL_API_KEY`, invites are still picked up and listed, but no bot joins, and the meeting says so when the call starts. **Run a simulated live meeting** on the Meetings tab shows what the bot does.
