import re

with open('src/lib/workflow.ts', 'r') as f:
    content = f.read()

# Remove the initial check:
content = content.replace(
    'if (!draft.report.transcription) throw new Error("Kein Transkript vorhanden.");',
    'if (!draft.report.transcription && !draft.audio) throw new Error("Weder Transkript noch Audio vorhanden.");'
)

old_fetch = r'const response = await run\(\(\) =>\s*fetch\("/api/analyze", \{\s*method: "POST",\s*headers: \{\s*Authorization: `Bearer \$\{token\}`,\s*"Content-Type": "application/json"\s*\},.*?\n\s*\}\),\s*\);'
new_fetch = '''
  const formData = new FormData();
  if (draft.report.transcription) {
    formData.append("transcription", draft.report.transcription);
  }
  if (draft.audio && !draft.report.transcription) {
    formData.append("audio", draft.audio, "recording" + audioExtension(draft.audio.type));
  }
  if (preferences) {
    formData.append("preferences", preferences);
  }

  const response = await run(() =>
    fetch("/api/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData,
      signal: AbortSignal.timeout(300000), // 5 minutes since audio transcription can take time
    }),
  );
'''

content = re.sub(old_fetch, new_fetch.strip(), content, flags=re.DOTALL)

# Let's ensure the backend actually sets draft.report.transcription to data.transcription
old_data_assignment = r'draft\.report = \{\s*\.\.\.draft\.report,\s*\.\.\.data,\s*\};'
new_data_assignment = '''
    draft.report = {
      ...draft.report,
      ...data,
    };
    if (data.transcription && !draft.report.transcription) {
      draft.report.transcription = data.transcription;
    }
'''
content = content.replace('draft.report = {\n      ...draft.report,\n      ...data,\n    };', new_data_assignment.strip())

with open('src/lib/workflow.ts', 'w') as f:
    f.write(content)

