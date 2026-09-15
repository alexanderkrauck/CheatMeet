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
export const CONSENT_TEMPLATE_VERSION = "2";

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

/** Nothing is deleted unless the user asks for it. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  audioDays: null,
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
        p.region === "eu" ? "EU" : "ggf. außerhalb der EU"
      })`,
  );
  // One sentence when nothing is deleted: saying "unbefristet" twice is the
  // kind of padding that makes people stop listening halfway through.
  const { audioDays, textDays } = facts.retention;
  const retention =
    audioDays === null && textDays === null
      ? "Aufnahme, Transkript und Zusammenfassung behalte ich unbefristet."
      : [
          audioDays === null
            ? "Die Aufnahme behalte ich unbefristet."
            : `Die Aufnahme lösche ich nach ${germanDays(audioDays)}.`,
          textDays === null
            ? "Transkript und Zusammenfassung behalte ich unbefristet."
            : `Transkript und Zusammenfassung lösche ich nach ${germanDays(textDays)}.`,
        ].join(" ");
  return {
    opening: "",
    purpose:
      "Ich zeichne das Gespräch auf, um mitzuschreiben; daraus mache ich ein Transkript und eine Zusammenfassung mit den offenen Aufgaben.",
    means:
      (facts.sources.includes("system")
        ? "Aufgenommen wird mein Mikrofon und der Ton dieses Calls, also auch deine Stimme."
        : "Aufgenommen wird nur mein Mikrofon.") +
      (processors.length
        ? ` Verarbeitet von ${joinList(processors, "und")}.`
        : " Kein externer Dienst verarbeitet die Aufnahme."),
    // No folder name — that is noise to a listener. No "nur für mich
    // zugänglich" either: the root folder is user-chosen and its sharing
    // state is never read, so exclusivity cannot honestly be claimed.
    recipients:
      "Gespeichert wird das in meinem Google Drive." +
      (facts.recipients.length
        ? ` Die Zusammenfassung geht an ${joinList(facts.recipients, "und")}.`
        : " Die Zusammenfassung gebe ich nur mit Ansage weiter."),
    // "lösche ich", never "wird automatisch gelöscht": the sweep only runs
    // while the app is open, and Drive trashes rather than purges.
    retention,
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
        p.region === "eu" ? "EU" : "possibly outside the EU"
      })`,
  );
  const { audioDays, textDays } = facts.retention;
  const retention =
    audioDays === null && textDays === null
      ? "I keep the recording, the transcript and the summary indefinitely."
      : [
          audioDays === null
            ? "I keep the recording indefinitely."
            : `I delete the recording after ${englishDays(audioDays)}.`,
          textDays === null
            ? "I keep the transcript and the summary indefinitely."
            : `I delete the transcript and the summary after ${englishDays(textDays)}.`,
        ].join(" ");
  return {
    opening: "",
    purpose:
      "I'm recording this so I can take notes; it becomes a transcript and a summary with the open action items.",
    means:
      (facts.sources.includes("system")
        ? "That records my microphone and this call's audio, so your voice too."
        : "That records my microphone only.") +
      (processors.length
        ? ` Processed by ${joinList(processors, "and")}.`
        : " No external service processes the recording."),
    recipients:
      "It's stored in my Google Drive." +
      (facts.recipients.length
        ? ` The summary goes to ${joinList(facts.recipients, "and")}.`
        : " I'd only pass the summary on after saying so."),
    retention,
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
    // Over-length is unusable, not trimmable: a sentence cut mid-word would
    // be spoken in place of a complete one.
    if (text && text.length <= MAX_PART_CHARS) parts[key] = text;
  }
  return parts;
}

/** Phrases that claim the other participants are being recorded. */
const SYSTEM_AUDIO_CLAIMS = [
  "call",
  "teilnehm",
  "anderen",
  "participants",
  "meeting",
];

/**
 * Drops any rephrasing that no longer states the fact it replaced.
 *
 * Structural coverage only guarantees that every element is *present*. It
 * cannot stop a warm rewrite from naming the wrong retention period, omitting
 * a processor, or claiming the other participants are recorded when only the
 * microphone is. A dropped element falls back to the deterministic sentence,
 * which is the designed degradation.
 */
export function acceptConsentParts(
  facts: ConsentFacts,
  parts?: ConsentParts | null,
): ConsentParts {
  if (!parts) return {};
  const kept: ConsentParts = {};
  for (const [key, value] of Object.entries(parts) as [
    ConsentElement,
    string,
  ][]) {
    const text = (value || "").trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (key === "retention") {
      const days = [facts.retention.audioDays, facts.retention.textDays];
      // Every promised period must still be named …
      if (days.some((value) => value !== null && !text.includes(String(value))))
        continue;
      // … and an indefinite one must not acquire a deadline.
      if (days.every((value) => value === null) && /\d/.test(text)) continue;
    }
    if (key === "means") {
      if (facts.processors.some((p) => !lower.includes(p.name.toLowerCase())))
        continue;
      if (
        !facts.sources.includes("system") &&
        SYSTEM_AUDIO_CLAIMS.some((claim) => lower.includes(claim))
      )
        continue;
    }
    // Where it is stored is the fact; the folder name is not spoken.
    if (key === "recipients" && !lower.includes("drive")) continue;
    kept[key] = text;
  }
  return kept;
}

export type ConsentMethod = "spoken" | "chat" | "calendar" | "other";

/**
 * What one person actually did after being informed.
 *
 * Two legal standards meet here and they are not the same. For StGB § 201,
 * being properly informed and continuing to take part can carry the day. The
 * GDPR does not accept that where consent is the basis: Art. 4(11) wants an
 * unambiguous affirmative act and Recital 32 rules out silence and inactivity.
 * So "nobody objected" is recorded as exactly that — never as agreement.
 */
export type ConsentStance = "agreed" | "objected" | "silent";

export interface ConsentParticipant {
  name: string;
  stance: ConsentStance;
}

export const CONSENT_RECORD_VERSION = 2;

export interface ConsentRecord {
  /** 1 carried a single "nobody objected" flag; 2 records each person. */
  version: 1 | 2;
  templateVersion: string;
  facts: ConsentFacts;
  /** The phrasing overrides in force, kept so coverage stays provable. */
  parts: ConsentParts | null;
  /** Verbatim, because templates change and the record must not. */
  text: string;
  obtainedAt: string;
  /** How they were informed. An invitation informs; it does not agree. */
  method: ConsentMethod;
  /** Version 2: one entry per person present. */
  participants: ConsentParticipant[];
  /** Version 1 only, kept so old records still read. */
  allInformed?: boolean;
  objections?: string;
}

/** Nobody present may have objected, and at least one person must have agreed. */
export const everyoneAgreed = (participants: ConsentParticipant[]) =>
  participants.length > 0 &&
  participants.every((person) => person.stance === "agreed");

export const objectors = (participants: ConsentParticipant[]) =>
  participants.filter((person) => person.stance === "objected");

const METHODS: readonly ConsentMethod[] = ["spoken", "chat", "calendar", "other"];

/**
 * Everything the person obtaining consent decides, independent of what the
 * devices ended up capturing. The sources come from the recorder, so the
 * notice on screen and the notice in the record are built from one function
 * and cannot disagree.
 */
export interface ConsentDecision {
  method: ConsentMethod;
  /** Everyone present, and what each of them actually said. */
  participants: ConsentParticipant[];
  language: ConsentLanguage;
  address: ConsentAddress;
  folderName: string;
  retention: RetentionPolicy;
  recipients?: string[];
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
    participants: ConsentParticipant[];
    objections?: string;
    parts?: ConsentParts | null;
  },
): ConsentRecord {
  // A rephrasing that no longer states the facts never enters the record.
  const checked = acceptConsentParts(facts, meta.parts);
  const parts = Object.keys(checked).length ? checked : null;
  return {
    version: CONSENT_RECORD_VERSION,
    templateVersion: CONSENT_TEMPLATE_VERSION,
    facts,
    parts,
    text: assembleConsentText(facts, parts),
    obtainedAt: meta.obtainedAt,
    method: METHODS.includes(meta.method) ? meta.method : "other",
    participants: meta.participants
      .map((person) => ({
        name: String(person.name || "").trim().slice(0, MAX_RECIPIENT_CHARS),
        stance: person.stance,
      }))
      .filter((person) => person.name),
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
  if (record.version !== 1 && record.version !== 2)
    fail("unbekannte Version.");
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
  if (record.version === 1) {
    // Written before each person was recorded separately.
    if (typeof record.allInformed !== "boolean")
      fail("es ist nicht festgehalten, ob alle Anwesenden informiert waren.");
  } else if (
    !Array.isArray(record.participants) ||
    !record.participants.length ||
    record.participants.some(
      (person) =>
        !person ||
        typeof person.name !== "string" ||
        !["agreed", "objected", "silent"].includes(person.stance),
    )
  )
    fail("es ist nicht festgehalten, wer zugestimmt hat.");
  // Rebuilt through the clamp: a hand-edited archive file could otherwise
  // hand the sweep an arbitrary deadline and have it trash the audio at once.
  facts.retention = {
    audioDays: retentionDays(facts.retention.audioDays),
    textDays: retentionDays(facts.retention.textDays),
  };
  const sentences = consentSentences(facts);
  // Re-checked against the facts, so a stored record cannot prove itself with
  // a rephrasing that contradicts what it says it agreed to.
  const accepted = acceptConsentParts(facts, record.parts);
  for (const key of CONSENT_REQUIRED) {
    const expected = accepted[key] || sentences[key];
    if (!expected || !record.text.includes(expected))
      fail(`der Teil „${key}“ kommt im Text nicht vor.`);
  }
  return record;
}
