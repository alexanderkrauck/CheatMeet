/**
 * The consent notice, as data.
 *
 * German law (StGB § 201) requires that everyone whose non-public speech is
 * recorded was informed *specifically* beforehand: a blanket "this call may be
 * recorded" is not enough. The notice must name the purpose, the technical
 * means, the recipients and how long the recording is kept.
 *
 * So the notice is never free prose. `consentFacts` derives the four required
 * elements from the meeting's real configuration, `consentSentences` renders
 * each element as one deterministic sentence, and `assembleConsentText` joins
 * them in a fixed order. An optional `parts` override lets a model rephrase an
 * element warmly; a missing or blank override falls back to the deterministic
 * sentence, so coverage is structural and cannot be lost to a model's wording.
 *
 * Isomorphic and dependency-free: the server drafts with it, the browser
 * assembles and stores with it.
 */

export type ConsentSource = "mic" | "system";
export type ConsentLanguage = "de" | "en";
export type ConsentAddress = "du" | "sie";

export type ConsentElement =
  | "opening"
  | "purpose"
  | "means"
  | "recipients"
  | "retention"
  | "ask";

/** The order the notice is spoken in. `opening` is optional warmth. */
export const CONSENT_ORDER: readonly ConsentElement[] = [
  "opening",
  "purpose",
  "means",
  "recipients",
  "retention",
  "ask",
];

/** Every element the notice must carry to be legally specific. */
export const CONSENT_REQUIRED: readonly ConsentElement[] = [
  "purpose",
  "means",
  "recipients",
  "retention",
  "ask",
];

/**
 * Bump whenever a sentence literal below changes. Every record stores the
 * version it was spoken under, so an old meeting keeps its own wording.
 */
export const CONSENT_TEMPLATE_VERSION = "1";

export interface ConsentProcessor {
  name: string;
  role: "transkription" | "zusammenfassung";
  region: "eu" | "global";
}

/** Streaming and batch both run against the provider's EU endpoints. */
export const ASSEMBLYAI_PROCESSOR: ConsentProcessor = {
  name: "AssemblyAI",
  role: "transkription",
  region: "eu",
};
/** No region is pinned for the summarising model, so the notice must not claim one. */
export const GEMINI_PROCESSOR: ConsentProcessor = {
  name: "Google Gemini",
  role: "zusammenfassung",
  region: "global",
};

export interface RetentionPolicy {
  /** Days until the audio is deleted; null means it is kept indefinitely. */
  audioDays: number | null;
  /** Days until transcript and summary are deleted; null means indefinitely. */
  textDays: number | null;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  audioDays: 30,
  textDays: null,
};
export const MAX_RETENTION_DAYS = 3650;

/**
 * An unusable value becomes `null` — "kept indefinitely". A bad input must
 * over-state retention, never under-state it, so the notice can never promise
 * a deletion that was never configured.
 */
export function retentionDays(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_RETENTION_DAYS
    ? value
    : null;
}

export interface ConsentInput {
  sources: ConsentSource[];
  folderName: string;
  retention: RetentionPolicy;
  recipients?: string[];
  language?: ConsentLanguage;
  address?: ConsentAddress;
  processors?: ConsentProcessor[];
}

export interface ConsentFacts {
  language: ConsentLanguage;
  address: ConsentAddress;
  sources: ConsentSource[];
  processors: ConsentProcessor[];
  storage: { service: "Google Drive"; folder: string };
  recipients: string[];
  retention: RetentionPolicy;
}

const MAX_FOLDER_CHARS = 120;
const MAX_RECIPIENTS = 6;
const MAX_RECIPIENT_CHARS = 80;

/** Total: any input yields facts, so the notice is never blocked by bad data. */
export function consentFacts(input: ConsentInput): ConsentFacts {
  const requested = Array.isArray(input.sources) ? input.sources : [];
  const sources = (["mic", "system"] as const).filter((s) =>
    requested.includes(s),
  );
  const recipients = (Array.isArray(input.recipients) ? input.recipients : [])
    .map((name) => String(name || "").trim().slice(0, MAX_RECIPIENT_CHARS))
    .filter(Boolean)
    .slice(0, MAX_RECIPIENTS);
  return {
    language: input.language === "en" ? "en" : "de",
    address: input.address === "sie" ? "sie" : "du",
    // Capture always opens the microphone, so an empty list is a caller bug
    // rather than a silent recording: say microphone rather than say nothing.
    sources: sources.length ? sources : ["mic"],
    processors: Array.isArray(input.processors)
      ? input.processors
      : [ASSEMBLYAI_PROCESSOR, GEMINI_PROCESSOR],
    storage: {
      service: "Google Drive",
      folder: String(input.folderName || "").trim().slice(0, MAX_FOLDER_CHARS),
    },
    recipients,
    retention: {
      audioDays: retentionDays(input.retention?.audioDays),
      textDays: retentionDays(input.retention?.textDays),
    },
  };
}

const joinList = (items: string[], and: string) =>
  items.length <= 1
    ? items[0] || ""
    : `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;

/* ------------------------------------------------------------------------ *
 * THE SENTENCE LITERALS ARE THE LEGAL ARTIFACT.
 * Editing any wording below requires bumping CONSENT_TEMPLATE_VERSION, so
 * records written before the change keep proving what was actually said.
 * ------------------------------------------------------------------------ */

const GERMAN_ROLE: Record<ConsentProcessor["role"], string> = {
  transkription: "Transkription",
  zusammenfassung: "Zusammenfassung",
};
const ENGLISH_ROLE: Record<ConsentProcessor["role"], string> = {
  transkription: "transcription",
  zusammenfassung: "summarisation",
};

const germanDays = (days: number) => `${days} ${days === 1 ? "Tag" : "Tagen"}`;
const englishDays = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

function germanSentences(facts: ConsentFacts): Record<ConsentElement, string> {
  const processors = facts.processors.map(
    (p) =>
      `${p.name} (${GERMAN_ROLE[p.role]}, ${
        p.region === "eu"
          ? "Server in der EU"
          : "Server außerhalb der EU möglich"
      })`,
  );
  const audio =
    facts.retention.audioDays === null
      ? "Die Audioaufnahme bewahre ich unbefristet auf."
      : `Die Audioaufnahme lösche ich nach ${germanDays(facts.retention.audioDays)}; sie liegt danach noch kurz im Papierkorb meines Drive.`;
  const text =
    facts.retention.textDays === null
      ? "Transkript und Zusammenfassung bewahre ich unbefristet auf."
      : `Transkript und Zusammenfassung lösche ich nach ${germanDays(facts.retention.textDays)}; sie liegen danach noch kurz im Papierkorb meines Drive.`;
  return {
    opening: "",
    purpose:
      "Ich möchte dieses Gespräch aufzeichnen, damit ich mitschreiben kann und nichts Wichtiges verloren geht. Aus der Aufnahme erstelle ich anschließend ein Transkript und eine Zusammenfassung mit den offenen Aufgaben.",
    means:
      (facts.sources.includes("system")
        ? "Aufgenommen wird der Ton meines Mikrofons und der Ton dieses Calls, also auch die Stimmen der anderen Teilnehmenden."
        : "Aufgenommen wird der Ton meines Mikrofons.") +
      (processors.length
        ? ` Verarbeitet wird die Aufnahme von ${joinList(processors, "und")}.`
        : " Die Aufnahme wird von keinem externen Dienst verarbeitet."),
    // No "nur für mich zugänglich": the root folder is user-chosen and its
    // sharing state is never read, so exclusivity cannot honestly be claimed.
    recipients:
      `Die Dateien liegen in meinem Google Drive im Ordner „${facts.storage.folder}“.` +
      (facts.recipients.length
        ? ` Die Zusammenfassung gebe ich an ${joinList(facts.recipients, "und")} weiter.`
        : " Wenn ich die Zusammenfassung weitergeben möchte, sage ich vorher Bescheid."),
    // "lösche ich", never "wird automatisch gelöscht": the sweep only runs
    // while the app is open, and Drive trashes rather than purges.
    retention: `${audio} ${text}`,
    ask:
      facts.address === "sie"
        ? "Sind Sie damit einverstanden, dass ich ab jetzt aufzeichne?"
        : "Bist du damit einverstanden, dass ich ab jetzt aufzeichne?",
  };
}

function englishSentences(facts: ConsentFacts): Record<ConsentElement, string> {
  const processors = facts.processors.map(
    (p) =>
      `${p.name} (${ENGLISH_ROLE[p.role]}, ${
        p.region === "eu"
          ? "servers in the EU"
          : "servers possibly outside the EU"
      })`,
  );
  const audio =
    facts.retention.audioDays === null
      ? "I keep the audio recording indefinitely."
      : `I delete the audio recording after ${englishDays(facts.retention.audioDays)}; it stays in my Drive trash for a short while after that.`;
  const text =
    facts.retention.textDays === null
      ? "I keep the transcript and the summary indefinitely."
      : `I delete the transcript and the summary after ${englishDays(facts.retention.textDays)}; they stay in my Drive trash for a short while after that.`;
  return {
    opening: "",
    purpose:
      "I'd like to record this conversation so I can take notes and nothing important gets lost. Afterwards I turn the recording into a transcript and a summary with the open action items.",
    means:
      (facts.sources.includes("system")
        ? "This records my microphone and the audio of this call, which includes the other participants' voices."
        : "This records my microphone.") +
      (processors.length
        ? ` The recording is processed by ${joinList(processors, "and")}.`
        : " The recording is not processed by any external service."),
    recipients:
      `The files are stored in my Google Drive, in the folder “${facts.storage.folder}”.` +
      (facts.recipients.length
        ? ` I pass the summary on to ${joinList(facts.recipients, "and")}.`
        : " If I want to pass the summary on, I'll say so first."),
    retention: `${audio} ${text}`,
    ask: "Are you okay with me recording from now on?",
  };
}

/** `de` and `en` are the only languages with a deterministic fallback. */
export function consentSentences(
  facts: ConsentFacts,
): Record<ConsentElement, string> {
  return facts.language === "en"
    ? englishSentences(facts)
    : germanSentences(facts);
}

export type ConsentParts = Partial<Record<ConsentElement, string>>;

/**
 * Phrasing may be overridden per element; coverage may not. A blank or missing
 * override falls back to the deterministic sentence, so every required element
 * is present no matter what a model returned.
 */
export function assembleConsentText(
  facts: ConsentFacts,
  parts?: ConsentParts | null,
): string {
  const sentences = consentSentences(facts);
  return CONSENT_ORDER.map(
    (key) => (parts?.[key] || "").trim() || sentences[key],
  )
    .filter(Boolean)
    .join(" ");
}

/** The longest a single rephrased element may be, so a model cannot bury the notice. */
export const MAX_PART_CHARS = 600;

/** What a model is allowed to return: phrasing for each element, nothing else. */
export const consentPartsSchema = {
  type: "object",
  properties: Object.fromEntries(
    CONSENT_ORDER.map((key) => [key, { type: "string" }]),
  ),
  required: [...CONSENT_REQUIRED],
  additionalProperties: false,
} as const;

/**
 * Keeps only known elements with usable text. Never throws: phrasing is an
 * enhancement, and anything it drops falls back to the deterministic sentence,
 * so a bad model response degrades to the notice that always works.
 */
export function validateConsentParts(value: unknown): ConsentParts {
  const raw = (value || {}) as Record<string, unknown>;
  const parts: ConsentParts = {};
  for (const key of CONSENT_ORDER) {
    const text = typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
    if (text) parts[key] = text.slice(0, MAX_PART_CHARS);
  }
  return parts;
}

export type ConsentMethod = "spoken" | "chat" | "calendar" | "other";

export interface ConsentRecord {
  version: 1;
  templateVersion: string;
  facts: ConsentFacts;
  /** The phrasing overrides in force, kept so coverage stays provable. */
  parts: ConsentParts | null;
  /** Verbatim, because templates change and the record must not. */
  text: string;
  obtainedAt: string;
  method: ConsentMethod;
  allInformed: boolean;
  participants?: string[];
  objections?: string;
}

const METHODS: readonly ConsentMethod[] = ["spoken", "chat", "calendar", "other"];

/**
 * Everything the person obtaining consent decides, independent of what the
 * devices ended up capturing. The sources come from the recorder, so the
 * notice on screen and the notice in the record are built from one function
 * and cannot disagree.
 */
export interface ConsentDecision {
  method: ConsentMethod;
  allInformed: boolean;
  language: ConsentLanguage;
  address: ConsentAddress;
  folderName: string;
  retention: RetentionPolicy;
  recipients?: string[];
  participants?: string[];
  objections?: string;
  /** Approved phrasing; coverage still comes from the facts, not from this. */
  parts?: ConsentParts | null;
}

export function decisionFacts(
  decision: ConsentDecision,
  sources: ConsentSource[],
): ConsentFacts {
  return consentFacts({
    sources,
    folderName: decision.folderName,
    retention: decision.retention,
    recipients: decision.recipients,
    language: decision.language,
    address: decision.address,
  });
}

export function buildConsentRecord(
  facts: ConsentFacts,
  meta: {
    obtainedAt: string;
    method: ConsentMethod;
    allInformed: boolean;
    participants?: string[];
    objections?: string;
    parts?: ConsentParts | null;
  },
): ConsentRecord {
  const parts = meta.parts && Object.keys(meta.parts).length ? meta.parts : null;
  return {
    version: 1,
    templateVersion: CONSENT_TEMPLATE_VERSION,
    facts,
    parts,
    text: assembleConsentText(facts, parts),
    obtainedAt: meta.obtainedAt,
    method: METHODS.includes(meta.method) ? meta.method : "other",
    allInformed: !!meta.allInformed,
    ...(meta.participants?.length ? { participants: meta.participants } : {}),
    ...(meta.objections?.trim() ? { objections: meta.objections.trim() } : {}),
  };
}

const fail = (reason: string): never => {
  throw new Error(`Einwilligung unvollständig: ${reason}`);
};

/**
 * Proves a stored record still says what it claims. Coverage is checked
 * against the very facts and parts the text was assembled from, so a truncated
 * or hand-edited text is rejected rather than silently accepted as evidence.
 */
export function validateConsentRecord(value: unknown): ConsentRecord {
  const record = value as ConsentRecord;
  if (!record || typeof record !== "object") fail("kein Datensatz vorhanden.");
  if (record.version !== 1) fail("unbekannte Version.");
  if (!record.templateVersion || typeof record.templateVersion !== "string")
    fail("die Fassung der Vorlage fehlt.");
  const facts = record.facts;
  if (
    !facts ||
    typeof facts !== "object" ||
    !Array.isArray(facts.sources) ||
    !Array.isArray(facts.processors) ||
    !Array.isArray(facts.recipients) ||
    !facts.storage ||
    typeof facts.storage.folder !== "string" ||
    !facts.retention ||
    typeof facts.retention !== "object"
  )
    fail("die zugrunde liegenden Angaben fehlen.");
  if (typeof record.text !== "string" || !record.text.trim())
    fail("der gesprochene Text fehlt.");
  if (!record.obtainedAt || Number.isNaN(Date.parse(record.obtainedAt)))
    fail("der Zeitpunkt fehlt oder ist unlesbar.");
  if (!METHODS.includes(record.method)) fail("die Art der Aufklärung fehlt.");
  if (typeof record.allInformed !== "boolean")
    fail("es ist nicht festgehalten, ob alle Anwesenden informiert waren.");
  const sentences = consentSentences(facts);
  for (const key of CONSENT_REQUIRED) {
    const expected = (record.parts?.[key] || "").trim() || sentences[key];
    if (!expected || !record.text.includes(expected))
      fail(`der Teil „${key}“ kommt im Text nicht vor.`);
  }
  return record;
}
