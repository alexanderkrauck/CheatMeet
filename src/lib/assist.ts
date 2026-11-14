import { auth } from "./firebase";
import { usageHeaders, type MeetingUsageContext } from "./usageContext";
import {
  MAX_QUESTION_CHARS,
  validateInsights,
  type MeetingInsights,
} from "../../shared/analysis";
/** Both sources can contain meeting participants. Never infer background noise
 * from the capture device or drop remote participants' questions. */
export function speechOnly(transcript: string): string {
  return transcript;
}

export const emptyInsights = (): MeetingInsights => ({
  prompts: [],
  questions: [],
  actions: [],
  decisions: [],
  terms: [],
});

export const hasInsights = (insights: MeetingInsights) =>
  (insights.prompts?.length || 0) > 0 ||
  insights.questions.length > 0 ||
  insights.actions.length > 0 ||
  insights.decisions.length > 0 ||
  insights.terms.length > 0;

async function post(route: string, body: unknown, timeoutMs: number, usage?: MeetingUsageContext) {
  const user = auth.currentUser;
  if (!user) throw new Error("Bitte erneut anmelden.");
  const owner = user.uid;
  const check = () => {
    if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const token = await user.getIdToken();
  check();
  if (!token) throw new Error("Bitte erneut anmelden.");
  const response = await fetch(`/api/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...usageHeaders(usage),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  check();
  const data = await response.json().catch(() => ({}));
  check();
  if (!response.ok)
    throw new Error(data.error || `Anfrage fehlgeschlagen (${response.status}).`);
  return data;
}

/** Answers a question using only what has been said in the meeting so far. */
export async function askMeeting(
  question: string,
  transcript: string,
  usage?: MeetingUsageContext,
): Promise<string> {
  const data = await post(
    "ask",
    {
      question: question.slice(0, MAX_QUESTION_CHARS),
      transcript: speechOnly(transcript),
    },
    60_000,
    usage,
  );
  return typeof data.answer === "string" ? data.answer : "";
}

/** Current open questions, commitments, decisions and jargon. */
export async function meetingInsights(
  transcript: string,
  usage?: MeetingUsageContext,
): Promise<MeetingInsights> {
  return validateInsights(
    await post("insights", { transcript: speechOnly(transcript) }, 60_000, usage),
  );
}
