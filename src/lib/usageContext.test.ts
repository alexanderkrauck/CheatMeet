import { expect, it } from "vitest";
import { usageHeaders } from "./usageContext";

it('sends only bounded meeting identity and an explicit archive namespace', () => {
  expect(usageHeaders({meetingId:'meeting_1',storage:'microsoft'})).toEqual({
    'X-CheatMeet-Meeting-ID':'meeting_1','X-CheatMeet-Storage':'microsoft',
  });
  expect(usageHeaders()).toEqual({});
  expect(usageHeaders({meetingId:'bad/meeting',storage:'google'})).toEqual({});
});
