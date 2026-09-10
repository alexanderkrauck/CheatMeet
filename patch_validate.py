import re

with open('shared/analysis.ts', 'r') as f:
    content = f.read()

content = content.replace(
    'summary: v.summary,',
    'summary: v.summary,\n    transcription: v.transcription,'
)

with open('shared/analysis.ts', 'w') as f:
    f.write(content)

