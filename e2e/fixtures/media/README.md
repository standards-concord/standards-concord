A stand-in for a release's walkthrough videos, served to the e2e tests through MEDIA_DIR:
a two-second tour with captions and a transcript, and no feedback video, so the welcome
page shows one video and one "being recorded" placeholder.

The feature clips' playlist (concord-clips.json) lists three clips: "validate" has a
video, captions and a transcript, "vote" has only a video, and "missing" has no files, so
the page must leave it out. The clip videos are copies of the two-second tour.
