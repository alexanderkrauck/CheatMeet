import { auth } from "./firebase";
import {
  MAX_QUESTION_CHARS,
  validateInsights,
  type MeetingInsights,
} from "../../shared/analysis";

export const emptyInsights = (): MeetingInsights => ({
  questions: [],
  actions: [],
  decisions: [],
  terms: [],
});

export const hasInsights = (insights: MeetingInsights) =>
  insights.questions.length > 0 ||
  insights.actions.length > 0 ||
  insights.decisions.length > 0 ||
  insights.terms.length > 0;

async function post(route: string, body: unknown, timeoutMs: number) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Bitte erneut anmelden.");
  const response = await fetch(`/api/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Anfrage fehlgeschlagen (${response.status}).`);
  return data;
}

/** Answers a question using only what has been said in the meeting so far. */
export async function askMeeting(
  question: string,
  transcript: string,
): Promise<string> {
  const data = await post(
    "ask",
    { question: question.slice(0, MAX_QUESTION_CHARS), transcript },
    60_000,
  );
  return typeof data.answer === "string" ? data.answer : "";
}

/** Current open questions, commitments, decisions and jargon. */
export async function meetingInsights(
  transcript: string,
): Promise<MeetingInsights> {
  return validateInsights(await post("insights", { transcript }, 60_000));
}
