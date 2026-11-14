/** Metadata only: neither a meeting's text nor an account identity is sent here.
 * The server gets the owning account exclusively from its verified token. */
export interface MeetingUsageContext {
  meetingId: string;
  storage: "google" | "microsoft";
}
export function usageHeaders(context?: MeetingUsageContext): Record<string, string> {
  return context && /^[a-zA-Z0-9_-]{1,100}$/.test(context.meetingId)
    ? { "X-CheatMeet-Meeting-ID": context.meetingId, "X-CheatMeet-Storage": context.storage }
    : {};
}
