import re

with open('shared/analysis.ts', 'r') as f:
    content = f.read()

content = content.replace(
    'typeof v.transcription !== "string" ||',
    ''
)
content = content.replace(
    'transcription: v.transcription,',
    'transcription: typeof v.transcription === "string" ? v.transcription : "",'
)

with open('shared/analysis.ts', 'w') as f:
    f.write(content)

