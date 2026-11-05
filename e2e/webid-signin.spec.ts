import { test, expect, signIn, settle } from './fixtures';

/**
 * Telling testers who reads their feedback, without a Solid server (the main suite
 * runs offline). Signing in with Solid is in sign-in-with-solid.spec.ts; the full
 * Solid sign-in and the pod sharing run against a real Solid server in solid-signin.spec.ts.
 */

test('the feedback page tells testers the alpha team can read what they send', async ({ page }) => {
  await signIn(page, { name: 'Privacy Reader' });
  await page.goto('/feedback');
  await settle(page);
  const notice = page.getByTestId('feedback-privacy');
  await expect(notice).toContainText('Who can read your feedback: the Concord alpha team (this site’s administrators) can read everything you send, including your name and email if you give them. Other testers can’t.');
  // No Solid server here: the copy is kept in private storage.
  await expect(notice).toContainText('we also keep a copy in your private storage');

  await expect(notice).toContainText('If you use the microphone, your browser’s own speech recognition may send the audio to its maker');
  // The offline stand-in runs the interview here, so no outside AI service is named.
  await expect(notice).not.toContainText('Anthropic');
  // No server-side transcription here either.
  await expect(notice).not.toContainText('OpenAI');

  await page.getByRole('button', { name: /Just tell us something/ }).click();
  await expect(page.getByTestId('feedback-privacy')).toBeVisible();
});

test('when Claude runs the interview, the notice says Anthropic receives the conversation before submitting', async ({ page }) => {
  await signIn(page, { name: 'AI Notice Reader' });
  // Pretend this server has Claude switched on (the suite runs offline).
  await page.route('**/api/session', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, llm: { ...body.llm, provider: 'anthropic' } } });
  });
  await page.goto('/feedback');
  await settle(page);
  await expect(page.getByTestId('feedback-privacy')).toContainText('While you chat, what you type or say is sent to Anthropic’s Claude, which runs the interviewer, before you press submit.');
});

test('when the server transcribes recordings, the notice says OpenAI receives them', async ({ page }) => {
  await signIn(page, { name: 'Voice Notice Reader' });
  // Pretend this server has the OpenAI transcription fallback switched on (the suite runs offline).
  await page.route('**/api/session', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, serverTranscription: 'openai' } });
  });
  await page.goto('/feedback');
  await settle(page);
  await expect(page.getByTestId('feedback-privacy')).toContainText('If your browser can’t recognise speech itself, Concord records what you say and sends the recording to OpenAI to turn it into text, before you press submit.');
});
