"""Summarize recorded streaming events locally; makes no network requests.

Usage: python3 scripts/report-streaming-evaluation.py OUTPUT_DIR BASELINE_JSON
Word disagreement measures agreement with another ASR result, not ground truth WER.
"""
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path


def tokens(text):
    return re.findall(r"\w+", text.casefold())


def distance(left, right):
    row = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        next_row = [i]
        for j, b in enumerate(right, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (a != b)))
        row = next_row
    return row[-1]


def stamp(milliseconds):
    seconds = int(milliseconds / 1000)
    return f"{seconds // 60}:{seconds % 60:02d}"


def summarize(output, baseline):
    reports = []
    for result_path in sorted(output.glob("*.result.json")):
        result = json.loads(result_path.read_text())
        case = result["test"]
        events = [json.loads(line) for line in (output / f'{case["name"]}.events.jsonl').read_text().splitlines()]
        beginning = next((e["receivedMs"] for e in events if e["data"]["type"] == "Begin"), 0)
        offset = case.get("sourceOffsetSeconds", 0) * 1000
        upper = offset + result["sentAudioSeconds"] * 1000
        reference_words = [w for w in baseline.get("words", []) if offset <= w["start"] < upper]
        reference = " ".join(w["text"] for w in reference_words) if case["name"].startswith("stackfuel") else ""
        transcript = " ".join(turn.get("transcript", "") for turn in result["turns"])
        reference_tokens, actual_tokens = tokens(reference), tokens(transcript)
        lags, live_lags, attribution = [], [], Counter()
        for e in events:
            d = e["data"]
            words = d.get("words") or []
            if d["type"] == "Turn" and words:
                lag = e["receivedMs"] - beginning - max(w["end"] for w in words)
                (lags if d.get("end_of_turn") else live_lags).append(lag)
        for turn in result["turns"]:
            for w in turn.get("words", []):
                attribution[str(w.get("speaker", turn.get("speaker_label")))] += 1
        summaries = {
            "case": case["name"], "status": result["status"],
            "durationSeconds": result["sentAudioSeconds"],
            "sourceOffsetSeconds": offset / 1000,
            "speakerWordCounts": dict(attribution),
            "finalTurns": len(result["turns"]),
            "turnUpdates": result["turnUpdateCount"],
            "speakerRevisionEvents": result["speakerRevisionCount"],
            "revisedTurns": sum(len(e["data"].get("revisions", [])) for e in events if e["data"]["type"] == "SpeakerRevision"),
            "medianPartialWordLagMs": statistics.median(live_lags) if live_lags else None,
            "medianFinalWordLagMs": statistics.median(lags) if lags else None,
            "maxFinalWordLagMs": max(lags) if lags else None,
            "finalizeMs": result["finalizeMs"],
            "estimatedUSD": result.get("estimatedUSD"),
            "referenceTokens": len(reference_tokens), "streamingTokens": len(actual_tokens),
            "asrTokenDisagreement": distance(reference_tokens, actual_tokens) / len(reference_tokens) if reference_tokens else None,
            "note": "Token disagreement is against existing raw batch ASR; it is not measured accuracy.",
        }
        lines = [f'# Streaming evaluation: {case["name"]}', '',
                 'Experimental output, not a replacement for the saved meeting transcript.', '',
                 '## Streaming final turns', '']
        for turn in result["turns"]:
            words = turn.get("words") or []
            groups = []
            for word in words:
                speaker = word.get("speaker", turn.get("speaker_label")) or "unknown"
                if not groups or groups[-1]["speaker"] != speaker:
                    groups.append({"speaker": speaker, "start": word["start"], "words": []})
                groups[-1]["words"].append(word["text"])
            if not groups:
                groups = [{"speaker": turn.get("speaker_label") or "unknown", "start": 0, "words": [turn.get("transcript", "")]}]
            for group in groups:
                lines.extend([f'**[{stamp(group["start"] + offset)}] Speaker {group["speaker"]}**', '', ' '.join(group["words"]), ''])
        lines.extend(['## Existing raw batch reference', '', reference, ''])
        (output / f'{case["name"]}.comparison.md').write_text('\n'.join(lines))
        reports.append(summaries)
    (output / 'metrics.json').write_text(json.dumps(reports, indent=2))
    return reports


if __name__ == '__main__':
    print(json.dumps(summarize(Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text())), indent=2))
