import { expect, it } from "vitest";
import { suggestSpeakerNames } from "./speakerMatches";
import type { MeetingTranscript, SpeechTurn } from "../../shared/transcription";
const turn = (i: number, speaker: string, text: string): SpeechTurn => ({ id: `t${i}`, speaker, text, startMs: i * 10000, endMs: i * 10000 + 5000, final: true });
const texts = ['Wir haben heute den Vertrag gemeinsam geprüft und noch keine Zusage erteilt', 'Bitte senden Sie uns die aktualisierte Fassung mit allen neuen Konditionen morgen'];
const doc = (turns: SpeechTurn[]): MeetingTranscript => ({ provider: 'assemblyai', phase: 'live', languages: ['de'], turns, speakerNames: {} });
it('suggests a user-entered name from repeated matching text and timing despite different provider labels', () => {
 const live = { ...doc(texts.map((t,i) => turn(i,'mic:0:A',t))), speakerAliases: {'mic:0:A':'Alex'} };
 const final = doc(texts.map((t,i) => turn(i,'batch:C',t)));
 expect(suggestSpeakerNames(live,final)).toEqual({'batch:C':'Alex'});
 expect(final.speakerNames).toEqual({});
});
it('declines to name a final label that merged distinct live speakers or split one speaker', () => {
 const live = { ...doc([...texts,...texts].map((t,i) => turn(i,i < 2 ? 'mic:0:A' : 'system:1:A',t))), speakerAliases: {'mic:0:A':'Alex','system:1:A':'Nina'} };
 expect(suggestSpeakerNames(live,doc(live.turns.map(t=>({...t,speaker:'batch:A'}))))).toEqual({});
 const one = { ...live, turns: live.turns.map(t=>({...t,speaker:'mic:0:A'})) };
 expect(suggestSpeakerNames(one,doc(one.turns.map((t,i)=>({...t,speaker:i<2?'batch:A':'batch:B'}))))).toEqual({});
});
it('does not infer identities from short generic acknowledgments or matching letters alone', () => {
 const live = {...doc([turn(0,'mic:0:A','Ja danke'),turn(1,'mic:0:A','Okay gut')]),speakerAliases:{'mic:0:A':'Alex'}};
 expect(suggestSpeakerNames(live,doc(live.turns.map(t=>({...t,speaker:'batch:A'}))))).toEqual({});
});
