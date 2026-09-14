"""Create a fresh, reproducible macOS TTS fixture locally; no API requests.

Usage: python3 scripts/prepare-two-pass-sample.py OUTPUT_DIR
Refuses to overwrite an existing sample. Requires macOS say and ffmpeg.
"""
import hashlib
import json
import subprocess
import sys
import wave
from pathlib import Path

output = Path(sys.argv[1]).resolve()
target = output / 'three-speaker-fresh.pcm'
if target.exists():
    raise SystemExit('Sample already exists; refusing to overwrite evaluation evidence')
output.mkdir(parents=True, exist_ok=True)
script = [
    ('Anna', 'Nina', 'Ich bin Nina. Wir besprechen heute das Projekt Morgenstern. Das Budget beträgt zweihundert Euro. Die Freigabe ist noch offen.'),
    ('Fred', 'James', 'My name is James. I will send the test results on Thursday. Please send the final report on Friday. We have not approved the purchase.'),
    ('Eddy (German (Germany))', 'Leon', 'Hier spricht Leon. Ich prüfe den Vertrag bis Dienstag. Die Reisekosten sind enthalten. Für die Übernachtung gibt es noch keine Zusage.'),
    ('Anna', 'Nina', 'Danke, Leon. Ich ändere den Termin auf Mittwoch. Das Budget bleibt unverändert. Wir haben keine weiteren Aufgaben beschlossen.'),
    ('Fred', 'James', 'One correction from James. The tests need two days, not three. Nina will review the results. I cannot confirm a delivery date yet.'),
    ('Eddy (German (Germany))', 'Leon', 'Zum Abschluss noch einmal Leon. Ich verschicke nur den Entwurf. Eine Unterschrift ist heute nicht geplant. Damit endet unsere Besprechung.'),
]
pcm = bytearray(3 * 32000)
segments = []
for index, (voice, speaker, text) in enumerate(script):
    aiff = output / f'fresh-voice-{index}.aiff'
    subprocess.run(['say', '-v', voice, '-r', '155', '-o', str(aiff), text], check=True)
    audio = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(aiff), '-f', 's16le', '-ac', '1', '-ar', '16000', '-'])
    start = len(pcm) / 32000
    pcm.extend(audio)
    segments.append(dict(speaker=speaker, voice=voice, text=text, startSeconds=start, endSeconds=len(pcm) / 32000))
    pcm.extend(bytes(3 * 32000))
target.write_bytes(pcm)
with wave.open(str(output / 'three-speaker-fresh.wav'), 'wb') as wav:
    wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
    wav.writeframes(pcm)
reference = dict(durationSeconds=len(pcm) / 32000, pcmSha256=hashlib.sha256(pcm).hexdigest(), segments=segments,
                 limitations='Synthetic, sequential voices with three-second gaps; no overlap, echo or real capture.')
(output / 'three-speaker-ground-truth.json').write_text(json.dumps(reference, indent=2, ensure_ascii=False))
print(json.dumps(reference, indent=2, ensure_ascii=False))
