export type UsageOperation =
  | 'summary' | 'ask' | 'insights' | 'consent'
  | 'legacy-transcribe' | 'legacy-stitch'
  | 'live-transcription' | 'batch-transcription';

export type UsageTokens = {
  input: number | null;
  output: number | null;
  thinking: number | null;
  cached: number | null;
  total: number | null;
};

export type UsageStart = {
  owner: string;
  ownerLabel?: string;
  meetingId?: string;
  storage?: 'google' | 'microsoft';
  operation: UsageOperation;
  provider: 'gemini' | 'assemblyai';
  kind: 'tokens' | 'streaming' | 'batch';
  model: string;
  source?: 'mic' | 'system';
  session?: number;
  features?: string[];
};

export type UsageFinish = {
  state: 'completed' | 'failed' | 'unknown';
  /** Browser evidence is an authenticated relay, not server-verified billing. */
  evidence: 'provider' | 'browser' | 'unknown';
  tokens?: UsageTokens;
  audioSeconds?: number;
  sessionSeconds?: number;
  providerRequestId?: string;
  modelVersion?: string;
};

export type UsageCost = {
  usd: number | null;
  currency: 'USD';
  rateId?: string;
  rateSource?: string;
  rateCheckedAt?: string;
  reason?: string;
};

export type UsageEvent = UsageStart & {
  id: string;
  startedAt: string;
  updatedAt: string;
  state: 'pending' | 'completed' | 'failed' | 'unknown';
  evidence: 'provider' | 'browser' | 'unknown';
  tokens?: UsageTokens;
  audioSeconds?: number;
  sessionSeconds?: number;
  providerRequestId?: string;
  modelVersion?: string;
  cost: UsageCost;
};

export type UsagePageData = {
  events: UsageEvent[];
  nextCursor: string | null;
  trackingSince: string | null;
  historyComplete: false;
};

export type UsageRecorder = {
  begin(input: UsageStart, id?: string): Promise<string>;
  finish(owner: string, id: string, update: UsageFinish): Promise<void>;
  get(owner: string, id: string): Promise<UsageEvent | null>;
};
