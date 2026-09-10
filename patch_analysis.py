with open('shared/analysis.ts', 'r') as f:
    content = f.read()

content = content.replace(
    'required: ["title", "summary", "todos", "takeaways"],',
    'required: ["title", "summary", "transcription", "todos", "takeaways"],'
)

content = content.replace(
    'title: { type: "string" },',
    'title: { type: "string" },\n    transcription: { type: "string", description: "Das vollständige, detaillierte Transkript des Meetings (jedes gesprochene Wort)" },'
)

content = content.replace(
    '): { title: string; summary: string; todos: string[]; takeaways: string[] } {',
    '): { title: string; summary: string; transcription: string; todos: string[]; takeaways: string[] } {'
)

content = content.replace(
    'typeof v.summary !== "string"',
    'typeof v.summary !== "string" ||\n    typeof v.transcription !== "string"'
)

with open('shared/analysis.ts', 'w') as f:
    f.write(content)

