import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ user: null as any }));
vi.mock('./firebase', () => ({ auth: { get currentUser() { return f.user; } } }));
import { askMeeting, meetingInsights } from './assist';
beforeEach(() => {
  f.user = { uid: 'alice', getIdToken: async () => 'identity' };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answer: 'Answer' })));
});
afterEach(() => vi.unstubAllGlobals());
it('binds assistant requests to their meeting and provider namespace', async () => {
  await askMeeting('Question', 'Transcript', {meetingId:'meeting',storage:'microsoft'});
  await meetingInsights('Transcript', {meetingId:'meeting',storage:'microsoft'});
  for (const [,init] of vi.mocked(fetch).mock.calls) {
    expect(init?.headers).toMatchObject({'X-CheatMeet-Meeting-ID':'meeting','X-CheatMeet-Storage':'microsoft'});
    expect(JSON.parse(init?.body as string).owner).toBeUndefined();
  }
});
it('does not dispatch an old meeting request after the signed-in account changes during token lookup', async () => {
  f.user.getIdToken = async () => { f.user = {uid:'bob',getIdToken:async()=> 'other'}; return 'identity'; };
  await expect(askMeeting('Question','Transcript',{meetingId:'meeting',storage:'google'})).rejects.toThrow(/Konto.*geändert/);
  expect(fetch).not.toHaveBeenCalled();
});
