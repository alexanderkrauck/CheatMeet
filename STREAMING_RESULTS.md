Subsequent product decision: the user approved implementing AssemblyAI as the
default, without further generic synthetic benchmarking. Local implementation:
[ASSEMBLYAI_IMPLEMENTATION.md](ASSEMBLYAI_IMPLEMENTATION.md). No deployment or
additional paid evaluation followed this decision. The results below retain the
observed model limitations.

# AssemblyAI streaming evaluation — 2026-09-14

Decision after three rounds: **do not replace production transcription yet**.
Streaming plus one independent final batch pass is the stronger text-quality
candidate. It still needs speaker-identity validation: both modes failed to keep
exactly three consistent identities in the fresh controlled sample.

## Follow-up decision: avoid testing without an actionable change

The user asked whether more tests would actually improve the product and asked
us to continue only if useful. Testing does not train or improve the provider.
No further paid calls were made at this checkpoint; estimated total remains
USD 0.13483. The current diarization guide does not document
`advanced_speaker_segmentation` as a tuning control, although a response example
in the API reference still contains it. We cannot infer from an echoed parameter
that toggling it changes Pro's diarization path. Do not run an A/B test without
establishing that the setting is meaningful.

The guide recommends at least 30 seconds of continuous speech per speaker;
our controlled turns lasted only 8–11 seconds. This is a limitation of the test,
not proof of poor real-meeting performance. Preserve it as a short-turn stress
case, rather than demand perfection on synthesized voices before any prototype.
[Current diarization guidance](https://www.assemblyai.com/docs/pre-recorded-audio/label-speakers)

Recommendation: stop broad synthetic benchmarking and build an opt-in two-pass
prototype after the user's implementation decision. Subsequent tests should
verify concrete application behavior: no duplicated partials, two-submission
accounting, final-text-only summaries, speaker edits, capture and recovery.
Any later provider experiment needs a specific hypothesis and a product decision
its result can change. Real recordings outside the approved StackFuel scope
still need explicit authorization.

## Fresh sample: streaming plus one final batch pass

The user approved exactly this follow-up within the original USD 5 cap. A fresh
80.19 s sample contains six sequential turns: Anna/Nina, Fred/James, Eddy/Leon,
then the same three voices again. Three-second digital silence gaps separate
turns. The script includes German and English, names, a project name, deadlines,
a budget, and explicit negatives about approval and commitments. No voices overlap.

Each audio portion was submitted **exactly twice**: once to Pro streaming with
German/English guidance and once to Pro batch with automatic language detection,
speaker labels and advanced speaker segmentation. Batch received the same PCM
in a WAV container, verified byte-for-byte and by a saved SHA-256 checksum. It
received no live transcript, synthesis script, glossary or speaker-count hint.
Both returned the requested model. All evidence is saved locally; the completed
remote batch experiment was deleted after saving its response.

| Measure | Streaming after final speaker revisions | Independent final batch |
| --- | --- | --- |
| Text differences from synthesis script | Six added tokens; 6/126 normalized token distance | One project-name substitution; 1/126 normalized token distance |
| Meaningful example | “We have not approved the project yet. Purchase.” instead of “We have not approved the purchase.” | Original purchase statement preserved |
| Other additions | “es ein” and “Every day” in fragmented turns | None observed against the script |
| Speaker identities | Nina=A; James and Leon merged as B | Nina=A, James=B, Leon=C, then Leon's final turn split C/D |
| Words timed in silence gaps | None outside a 250 ms boundary tolerance | None outside a 250 ms boundary tolerance |
| Estimated charge | USD 0.012825 | USD 0.005175 |

Batch changed `Morgenstern` to `Nordenstern`; streaming retained the project name.
Batch preserved the script's deadlines, budget and explicit negative commitments.
Thus the final pass improved this sample substantially, but it did not simply
correct every live error without introducing any new one. Token comparison ignores
case, punctuation and the known number-format equivalents zweihundert/200,
two/2 and three/3. This is a controlled synthesis-script comparison, not an
independently listened human-speech accuracy benchmark.

Speaker counts use the saved final **word-level** labels within each known voice
interval. Streaming assigned all 43 Leon words and 52 James words to B. Batch
assigned Leon's last 20 words as 5 C + 15 D despite the same unchanged TTS voice.
This is direct evidence that neither result meets consistent automatic speaker
identity requirements yet. It does not establish performance on real people,
overlapping speech, microphone bleed, or separate microphone/system sources.

Final batch completed in approximately 9.6 seconds after submission. This small
sample does not establish finalization latency for long meetings. No summary was
generated; a future integration must summarize only the chosen final transcript.

**Cumulative estimated spend: USD 0.13483 of USD 5**. Conservative reservations
across all runs total USD 0.18071. No invoice was queried. New rates used are
USD 0.57/connected hour for Pro streaming plus diarization and USD 0.23/audio hour
for Pro batch plus diarization. [Published rates](https://www.assemblyai.com/pricing/)

Reproduce the offline comparison with `scripts/report-two-pass-evaluation.py`.
`scripts/prepare-two-pass-sample.py` preserves the exact synthesis script and
voice choices. `scripts/evaluate-final-batch.mjs` reserves budget before upload,
refuses duplicate case submissions and saves the provider ID for read-only
recovery if polling fails. Never replay this sample: both submissions are spent.
Local details: `output/streaming-evaluation-2026-09-14/two-pass-comparison.md`.

Next pivotal decision: build an opt-in two-pass prototype with explicit speaker
correction tools, or continue validating speaker consistency before integration.
Neither production enablement nor new real-recording uploads are approved by
this experiment.

## Guided-language follow-up

The user approved German + English as editable per-meeting defaults and asked to
test this next. We sent previously unused real audio at 00:00–03:00 and a 41.36 s
locally synthesized sample (Anna in German, Fred in English, Anna in German again,
with silence gaps). Pro received `language_codes=["de","en"]`. The same synthetic
sample's second and last permitted pass used `universal-streaming-multilingual`
with formatted turns and diarization. That model has no equivalent language-list
parameter in the evaluated API, so this is a model comparison, not a controlled
language-setting-only experiment.

| Follow-up case | Result | Estimated charge |
| --- | --- | ---: |
| Pro, guided real opening, 180 s | No unexpected-language text observed; ordinary word errors remain; 6 turns received speaker corrections | USD 0.02866 |
| Pro, guided synthetic bilingual | All three sections retained; speaker order A/B/A correct; added English wording and repeated a fragment | USD 0.00665 |
| Cheaper multilingual, same synthetic | Most English content omitted; one voice split across A/B; returning speaker inconsistent | USD 0.00315 |

**Cumulative estimated cost after that round: USD 0.11683**, versus the USD 5 authorization. Full
session-cap reservations total USD 0.15552. All six sessions terminated normally.
Real intervals remain nonoverlapping; synthetic bilingual audio was sent twice.

The synthetic script ended its English section with “Please send the final report
on Friday.” Pro finalized “Please send the final report to me by Friday.” and then
another turn containing “Report on Friday.” These additions are in provider final
events with distinct turn IDs and word timestamps, not introduced by our renderer.
Speaker revisions did not fix the words. The normalized edit distance against the
synthesis script was 5/69 tokens for Pro and 21/69 for the cheaper model, after
normalizing `einhundert` to `100`. This is a narrow synthetic test, not an overall
model ranking or a real-meeting accuracy benchmark.

Word-label verification: Pro assigned the German sections entirely to A and the
English section to B. The cheaper model split the first German section 11 A/10 B
words and the returning German section 6 A/16 B. These counts use final per-word
labels, not only dominant turn labels.

Language guidance is reasonable to keep, but different real excerpts were used
to respect the submission limit: the absence of language drift in the opening
does not prove guidance fixed the closing excerpt. Production acceptance still
needs stronger evidence, including testing whether a second final pass improves
these failures without exceeding the two-pass limit.

## Test conditions

- User-approved scope: existing StackFuel recording plus synthetic audio, USD 5 cap.
- Model actually acknowledged in `Begin`: `universal-3-5-pro`, `max_accuracy`,
  speaker labels enabled. EU endpoint. Continuous partials explicitly requested.
- No language restriction, glossary, prompting, Voice Focus or secondary LLM pass.
- PCM mono at 16 kHz, replayed in 100 ms frames at real-time speed. This evaluates
  recognition on the existing saved mix, not browser capture or separate streams.
- Real intervals: 09:00–14:00 and 25:00–27:43, nonoverlapping, submitted once each.
  Synthetic: 10 seconds each of digital silence, quiet uniform noise and a tone.
- Original Drive artifacts and the existing batch transcript were not modified.

## Observed results

| Case | Audio sent | Final turns | Speaker-corrected turns | Estimated charge |
| --- | ---: | ---: | ---: | ---: |
| Synthetic non-speech | 30 s | 0 | 0 | USD 0.00475 |
| Previously problematic interval | 300 s | 35 | 6 | USD 0.04766 |
| Closing discussion | 163.05 s | 21 | 7 | USD 0.02597 |

First-round estimate: **USD 0.07838**. Based on returned session durations and the
published USD 0.57/session-hour model-plus-diarization rate; no account invoice
was queried. Token lifetime reservations bounded the maximum for these runs to
USD 0.09960. All three sessions ended with `Termination`; no replay occurred.
[Published rates](https://www.assemblyai.com/pricing/)

The five-minute excerpt followed the curriculum/workshop discussion rather than
the fiction and concert passages in CheatMeet's stored transcript. Synthetic
non-speech generated neither partial nor final transcript events. This is evidence
for these inputs only; it does not establish a universal no-hallucination guarantee
or identify the original failure's exact point in the capture/transcription chain.

The closing excerpt retained the hourly rate, covered travel/accommodation,
possible higher compensation for on-site work and the planned next interview.
It nevertheless rendered several short stretches in unexpected languages. Near
25:00 it emitted Danish-looking text; several backchannels appeared as Chinese
characters. These may reflect language misclassification of audible speech or
backchannels; do not label every such token invented speech without listening.
Ordinary word errors also remain, including a place-name error.

Reference comparison used the existing raw batch result and the previously
reviewed transcript, not a new independent human listening audit. Normalized token
disagreement with raw batch was 6.9% and 15.5%, respectively. These values include
formatting, boundary and recognition differences and **are not WER or accuracy**.

## Live versus final behavior

There were 252 and 131 turn updates in the two real sessions. Median receipt lag
relative to the last word's provider timestamp was approximately 0.19/0.21 seconds
for partial updates and 0.74/0.61 seconds for final turns. These are offline replay
measurements after connection establishment, not browser end-to-end latency or
time until a whole sentence is complete. Final session shutdown took about
1.15/0.48 seconds including the last events.

Both real sessions emitted `SpeakerRevision`. Word-level assignments can change
within a turn; some turns' dominant speaker labels cover words from two people.
Rendering only the dominant label would misattribute replies. The comparison
renderer splits on final word-level labels. Two speaker identities were present
after corrections, but diarization accuracy was not exhaustively scored.

## Next steps and approval point

1. Expected-language behavior was approved: German + English, with an explicit
   way to change the expected languages. The
   provider's language list biases recognition; it is not proof that other-language
   output becomes impossible. Validate rather than assume it cures this failure.
   [Language configuration](https://www.assemblyai.com/docs/streaming/getting-started/optimizing-accuracy-and-latency)
2. The guided test and controlled bilingual comparison are complete (above).
   Do not replay the same real intervals
   automatically: they already have the earlier batch submission and this stream.
3. The approved fresh two-pass test is complete (above). Decide on an opt-in
   prototype or further speaker validation before integration:
   replace partials by turn ID, split on word speakers, apply revisions before
   summary generation, preserve unknown attribution and gaps, and record interval
   submission budgets.
4. Before production: test all four requested speaker/source scenarios, duplicate
   microphone pickup, quiet speech, reconnects, pauses, long sessions, backgrounded
   browsers and real native capture. This test covered one mixed two-person meeting.

## Reproducibility

- Runner: `scripts/evaluate-streaming.mjs`; no production code imports it.
- Offline report generator: `scripts/report-streaming-evaluation.py`.
- Private local evidence: `output/streaming-evaluation-2026-09-14/` (gitignored).
  Contains config without key values, PCM excerpts, raw event JSONL, finalized
  result JSON, comparison Markdown, metrics and the budget ledger.
- The runner refuses to replay an already-reserved case. Session caps reserve
  full worst-case cost, including uncertain failures. Do not delete the ledger
  to bypass the submission or spending limits.
- Validation: JavaScript syntax check, Python compile check, typecheck and
  `git diff --check` passed. The earlier 186 application tests remain the latest
  full application run; this step added only standalone evaluation scripts/docs.
