"""Compare the fresh synthetic fixture's two submissions locally, without APIs.

Usage: python3 scripts/report-two-pass-evaluation.py OUTPUT_DIR
Synthesis text is a controlled reference, not a real-meeting accuracy benchmark.
"""
import difflib
import json
import re
import runpy
import sys
from collections import Counter
from pathlib import Path

output = Path(sys.argv[1])
distance = runpy.run_path(str(Path(__file__).with_name('report-streaming-evaluation.py')))['distance']
truth = json.loads((output / 'three-speaker-ground-truth.json').read_text())
stream = json.loads((output / 'three-speaker-fresh-stream.result.json').read_text())
batch = json.loads((output / 'three-speaker-fresh-batch.provider.json').read_text())

def normalize(text):
    # Ignore case/punctuation and the known spoken-number formatting equivalence.
    value = text.casefold()
    for spoken, numeric in [('zweihundert', '200'), ('two', '2'), ('three', '3')]:
        value = re.sub(r'\b' + spoken + r'\b', numeric, value)
    return re.findall(r'\w+', value)

reference = ' '.join(s['text'] for s in truth['segments'])
expected = normalize(reference)
lines = ['# Fresh synthetic sample: streaming + one final batch pass', '',
         'Exactly the same PCM audio in both submissions. Three sequential synthetic voices; no overlap or real capture.', '',
         '## Synthesis script', '']
for segment in truth['segments']:
    lines += [f'**{segment["startSeconds"]:.2f}–{segment["endSeconds"]:.2f}s · {segment["speaker"]}**', '', segment['text'], '']
metrics = {}
for label, text, words in [
    ('Streaming', ' '.join(t['transcript'] for t in stream['turns']), [w for t in stream['turns'] for w in t.get('words', [])]),
    ('Final batch', batch['text'], batch.get('words', [])),
]:
    actual = normalize(text)
    differences = []
    for op, a, b, c, d in difflib.SequenceMatcher(None, expected, actual, autojunk=False).get_opcodes():
        if op != 'equal':
            differences.append(dict(operation=op, reference=' '.join(expected[a:b]), actual=' '.join(actual[c:d])))
    attribution = []
    for segment in truth['segments']:
        selected = [w for w in words if segment['startSeconds'] * 1000 <= (w['start'] + w['end']) / 2 < segment['endSeconds'] * 1000]
        attribution.append(dict(expectedSpeaker=segment['speaker'], startSeconds=segment['startSeconds'],
                                assignedWords=dict(Counter(str(w.get('speaker')) for w in selected)),
                                text=' '.join(w['text'] for w in selected)))
    outside = [w for w in words if not any(s['startSeconds'] * 1000 - 250 <= (w['start'] + w['end']) / 2 <= s['endSeconds'] * 1000 + 250 for s in truth['segments'])]
    metrics[label] = dict(referenceTokens=len(expected), actualTokens=len(actual), tokenEditDistance=distance(expected, actual),
                          differences=differences, attribution=attribution, wordsInSilenceGaps=outside)
    lines += [f'## {label}', '', text, '', f'Normalized token distance: {distance(expected, actual)}/{len(expected)}. Controlled synthesis reference only.', '']
    for diff in differences:
        lines += [f'- {diff["operation"]}: `{diff["reference"]}` → `{diff["actual"]}`']
    lines += ['', '| Expected voice | Start | Provider labels by word count |', '| --- | ---: | --- |']
    for item in attribution:
        lines += [f'| {item["expectedSpeaker"]} | {item["startSeconds"]:.2f}s | {item["assignedWords"]} |']
    lines += ['', 'Words timed inside padded silence gaps: ' + json.dumps(outside, ensure_ascii=False), '']
(output / 'two-pass-comparison.md').write_text('\n'.join(lines))
(output / 'two-pass-metrics.json').write_text(json.dumps(metrics, indent=2, ensure_ascii=False))
print(json.dumps(metrics, indent=2, ensure_ascii=False))
