import re
with open("src/pages/RecordPage.tsx", "r") as f:
    content = f.read()

# Remove addPhotos
content = re.sub(r'async function addPhotos.*?\}\n  async function importAudio', '  async function importAudio', content, flags=re.DOTALL)

# Remove reconcileDraftPhotos usages
content = re.sub(r'let d = reconcileDraftPhotos\(current\.current, current\.current\.photos\);', 'let d = current.current;', content)

# Remove capturePhoto function
content = re.sub(r'function capturePhoto\(\) \{.*?\}\n', '', content, flags=re.DOTALL)

# Remove previewPhotos
content = re.sub(r'const previewPhotos = draft\.photos\.slice\(-3\);\n', '', content)

# Remove photo-strip logic
content = re.sub(r'<div className="walk-photo-strip">.*?</div>\s*</>', '</>', content, flags=re.DOTALL)

# Remove camera button
content = re.sub(r'<button\s*className="walk-camera".*?</button>', '', content, flags=re.DOTALL)

# Remove photo sheet
content = re.sub(r': sheet === "photos"\s*\?.*?<button.*?Foto hinzufügen\s*</button>\s*</>', '', content, flags=re.DOTALL)

# Remove file input for photos
content = re.sub(r'<input\s*type="file"\s*accept="image/jpeg,image/png,image/webp".*?/>', '', content, flags=re.DOTALL)

# Remove camera overlay
content = re.sub(r'\{cameraOpen && \(.*?<RecordingCamera.*?/>\s*\)\}', '', content, flags=re.DOTALL)

# Also remove camera icon from review
content = re.sub(r'<button onClick=\{.*?sheet === "photos".*?Fotos <ArrowRight size=\{14\} />\s*</button>', '', content, flags=re.DOTALL)

with open("src/pages/RecordPage.tsx", "w") as f:
    f.write(content)
