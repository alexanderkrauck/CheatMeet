import re

with open('server/analysis.ts', 'r') as f:
    content = f.read()

content = content.replace(
    'res.status(500).json({ error: "Analyse fehlgeschlagen." });',
    'res.status(error instanceof RequestError ? error.status : 500).json({ error: error instanceof RequestError ? error.message : "Analyse fehlgeschlagen." });'
)

with open('server/analysis.ts', 'w') as f:
    f.write(content)

