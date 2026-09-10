import re

with open('shared/analysis.ts', 'r') as f:
    content = f.read()

content = content.replace(
    'required: ["title", "summary", "transcription", "todos", "takeaways"],',
    'required: ["title", "summary", "todos", "takeaways"],'
)

with open('shared/analysis.ts', 'w') as f:
    f.write(content)

