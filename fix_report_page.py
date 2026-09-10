import re
with open("src/pages/ReportPage.tsx", "r") as f:
    content = f.read()

# Remove Photo component
content = re.sub(r'function Photo\(.*?\}\n\n', '', content, flags=re.DOTALL)
content = re.sub(r'import \{ BlobImage,', 'import { Busy,', content)
content = re.sub(r'  Image,\n', '', content)

# Remove photos logic
content = re.sub(r'  const photos = view\?\.photos.*?\n\n', '\n', content)
content = re.sub(r'<div className="report-subline">.*?</div>\n', '', content, flags=re.DOTALL)
content = re.sub(r'\{photos\.length > 0 && \(.*?\}\)\n', '', content, flags=re.DOTALL)

with open("src/pages/ReportPage.tsx", "w") as f:
    f.write(content)
