import { describe, expect, it, vi } from "vitest";
import express from "express";
import * as metering from "../server/geminiUsage";
import { analyzeTranscript, createAnalysisRouter } from "../server/analysis";
import { createUsageRecorder } from "../server/usage";
import { memoryUsageStore } from "../server/usage/store";

function fixture() {
  const events: any[] = [];
  const recorder = {
    begin: vi.fn(async (input: any) => { events.push({ id: `event-${events.length}`, ...input }); return events.at(-1).id; }),
    finish: vi.fn(async (owner: string, id: string, update: any) => { Object.assign(events.find(e => e.id === id && e.owner === owner), update); }),
    get: vi.fn(async () => null),
  };
  const client = { models: { generateContent: vi.fn(async (_request: any) => ({
    text: '{"summary":"private meeting output"}', responseId: 'provider-response', modelVersion: 'gemini-3.8-flash',
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, thoughtsTokenCount: 7, cachedContentTokenCount: 40, totalTokenCount: 147 },
  })) } };
  const request = { model: 'gemini-3.7-flash', contents: 'private meeting input' };
  const context = { owner: 'alice', meetingId: 'meeting', storage: 'microsoft' as const, operation: 'summary' as const };
  return { events, recorder, client, request, context };
}

describe('actual Gemini consumption', () => {
  it.each(['_meeting', '-meeting'])('meters an existing supported report ID %s through the real HTTP and ledger path', async meetingId => {
    const f = fixture();
    const store = memoryUsageStore();
    const recorder = createUsageRecorder(store, { now: () => Date.parse('2026-11-14T12:00:00Z') });
    f.client.models.generateContent.mockResolvedValueOnce({ text: JSON.stringify({ title: 'Meeting', summary: 'Result', todos: [], takeaways: [] }) } as any);
    const app = express();
    app.use('/api', createAnalysisRouter({ createClient: () => f.client as any, verifyToken: async () => 'alice', usage: recorder }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const form = new FormData(); form.append('transcription', 'Meeting input');
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/analyze`, {
        method: 'POST', headers: { Authorization: 'Bearer alice', 'X-CheatMeet-Meeting-ID': meetingId }, body: form,
      });
      expect(response.status).toBe(200);
      const { events } = await store.query({ owner: 'alice', start: '2026-11-14', end: '2026-11-15', limit: 10 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ owner: 'alice', meetingId, state: 'completed', operation: 'summary' });
      expect(f.client.models.generateContent).toHaveBeenCalledTimes(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('records provider counters and requested/reported model before the caller parses output', async () => {
    const f = fixture();
    const response = await metering.generateMetered(f.client as any, f.request, f.context, f.recorder);
    expect(response.text).toBe('{"summary":"private meeting output"}');
    expect(f.events).toEqual([expect.objectContaining({ owner: 'alice', meetingId: 'meeting', storage: 'microsoft', provider: 'gemini', kind: 'tokens', model: 'gemini-3.7-flash', modelVersion: 'gemini-3.8-flash', operation: 'summary', state: 'completed', evidence: 'provider', providerRequestId: 'provider-response', tokens: { input: 120, output: 20, thinking: 7, cached: 40, total: 147 } })]);
    expect(JSON.stringify(f.events)).not.toContain('private meeting');
    expect(f.recorder.begin.mock.invocationCallOrder[0]).toBeLessThan(f.client.models.generateContent.mock.invocationCallOrder[0]);
  });
  it('decodes omitted proto3 zero scalars only in an otherwise complete provider usage block', async () => {
    const f = fixture();
    f.client.models.generateContent.mockResolvedValueOnce({
      text: 'result', usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, totalTokenCount: 140 },
    } as any);
    await metering.generateMetered(f.client as any, f.request, f.context, f.recorder);
    expect(f.events[0].tokens).toEqual({ input: 120, output: 20, total: 140, thinking: 0, cached: 0 });
  });
  it('retains absent and invalid provider metadata as unknown instead of a zero-cost request', async () => {
    const f = fixture();
    f.client.models.generateContent.mockResolvedValueOnce({text:'result'} as any);
    await metering.generateMetered(f.client as any, f.request, f.context, f.recorder);
    expect(f.events[0]).toMatchObject({state:'completed',evidence:'unknown',tokens:{input:null,output:null,thinking:null,cached:null,total:null}});
    f.client.models.generateContent.mockResolvedValueOnce({text:'result',usageMetadata:{promptTokenCount:-1,candidatesTokenCount:NaN,totalTokenCount:Infinity}} as any);
    await metering.generateMetered(f.client as any, f.request, f.context, f.recorder);
    expect(f.events[1].tokens).toEqual({input:null,output:null,thinking:null,cached:null,total:null});
  });
  it('retains a paid response even if its usage settlement fails', async () => {
    const f = fixture();
    f.recorder.finish.mockRejectedValueOnce(Error('Accounting unavailable'));
    const warn = vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      expect((await metering.generateMetered(f.client as any,f.request,f.context,f.recorder)).responseId).toBe('provider-response');
      expect(f.client.models.generateContent).toHaveBeenCalledTimes(1);
      expect(f.events[0].state).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage_settlement_failed'));
      expect(warn.mock.calls.flat().join('')).not.toContain('private meeting');
    } finally { warn.mockRestore(); }
  });
  it('does not dispatch paid generation without its durable accounting intent', async () => {
    const f = fixture(); f.recorder.begin.mockRejectedValueOnce(Error('Store unavailable'));
    await expect(metering.generateMetered(f.client as any,f.request,f.context,f.recorder)).rejects.toThrow('Store unavailable');
    expect(f.client.models.generateContent).not.toHaveBeenCalled();
  });
  it('records every real retry attempt instead of only the eventual saved summary', async () => {
    const f = fixture();
    f.client.models.generateContent.mockRejectedValueOnce(Object.assign(Error('Provider timeout'),{status:504}));
    f.client.models.generateContent.mockResolvedValueOnce({
      text:JSON.stringify({title:'Meeting',summary:'Result',todos:[],takeaways:[]}),
      usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,thoughtsTokenCount:2,cachedContentTokenCount:0,totalTokenCount:17},
    } as any);
    await analyzeTranscript('Transcript','',{createClient:()=>f.client as any,usage:f.recorder,usageContext:f.context,retryAttempts:2,sleep:async()=>{}});
    expect(f.events).toHaveLength(2);
    expect(f.events[0]).toMatchObject({state:'unknown',evidence:'unknown'});
    expect(f.events[1]).toMatchObject({state:'completed',tokens:{input:10,output:5,thinking:2}});
    expect(f.events[0].id).not.toBe(f.events[1].id);
  });
  it('accounts successful provider work even when the generated report cannot be parsed', async () => {
    const f = fixture(); f.client.models.generateContent.mockResolvedValueOnce({text:'not JSON',usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15}} as any);
    await expect(analyzeTranscript('Transcript','',{createClient:()=>f.client as any,usage:f.recorder,usageContext:f.context})).rejects.toThrow(/vollständigen Bericht/);
    expect(f.events[0]).toMatchObject({state:'completed',tokens:{input:10,output:5,total:15}});
    expect(f.client.models.generateContent).toHaveBeenCalledTimes(1);
  });
  it('meters authenticated HTTP summarization to its actual account and meeting', async () => {
    const f = fixture();
    f.client.models.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({ title: 'Meeting', summary: 'Saved summary', todos: [], takeaways: [] }),
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, thoughtsTokenCount: 7, cachedContentTokenCount: 40, totalTokenCount: 147 },
    } as any);
    const app = express();
    app.use('/api', createAnalysisRouter({ createClient: () => f.client as any, verifyToken: async token => {
      if (token !== 'alice') throw Error('No identity'); return token;
    }, usage: f.recorder } as any));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const form = new FormData(); form.append('transcription', 'Meeting input');
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/analyze`, {
        method: 'POST', headers: { Authorization: 'Bearer alice', 'X-CheatMeet-Meeting-ID': 'meeting', 'X-CheatMeet-Storage': 'microsoft' }, body: form,
      });
      expect(response.status).toBe(200);
      expect(f.events).toHaveLength(1);
      expect(f.events[0]).toMatchObject({ owner: 'alice', meetingId: 'meeting', storage: 'microsoft', operation: 'summary', state: 'completed', tokens: { input: 120 } });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
