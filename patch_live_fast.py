import re

with open('src/lib/liveTranscription.ts', 'r') as f:
    content = f.read()

# Change 30000 to 15000 (every 15 seconds)
content = content.replace(
    'if (now - this.lastProcessTime < 30000) return;',
    'if (now - this.lastProcessTime < 15000) return;'
)

with open('src/lib/liveTranscription.ts', 'w') as f:
    f.write(content)

