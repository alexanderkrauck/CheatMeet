import re

with open('src/pages/RecordPage.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    '"Dein Meeting analysieren … Bitte diese Seite geöffnet lassen."',
    '"Dein Meeting analysieren …"'
)

with open('src/pages/RecordPage.tsx', 'w') as f:
    f.write(content)

