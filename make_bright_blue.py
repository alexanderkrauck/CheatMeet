import re

with open('src/index.css', 'r') as f:
    css = f.read()

# Replace slate/dark blues with bright blues
css = css.replace('#273954', '#2563eb')  # Button bg -> blue-600
css = css.replace('#344a6a', '#1d4ed8')  # Button hover -> blue-700
css = css.replace('#253042', '#1e3a8a')  # Another dark slate -> blue-900
css = css.replace('#1e3a8a', '#1d4ed8')  # Brighten the darkest blues slightly
css = css.replace('#1e293b', '#2563eb')
css = css.replace('#334155', '#2563eb')
css = css.replace('#1a2b3c', '#1e40af')

with open('src/index.css', 'w') as f:
    f.write(css)

with open('src/pages/record.css', 'r') as f:
    css = f.read()

css = css.replace('#273954', '#2563eb')
css = css.replace('#344a6a', '#1d4ed8')
css = css.replace('#253042', '#1e40af')
css = css.replace('#28384f', '#1d4ed8')
css = css.replace('#192332', '#1e3a8a')
css = css.replace('#141c28', '#1e3a8a')
css = css.replace('#262f3c', '#1e3a8a')
css = css.replace('#303d51', '#2563eb')
css = css.replace('#1d4ed8', '#2563eb')
css = css.replace('#f8fafc', '#ffffff') # Make whites pure white or f0f9ff
css = css.replace('#f0f2f4', '#f0f9ff') # Make light gray a light blue-white
css = css.replace('#e4e9f1', '#e0f2fe')
css = css.replace('#e6eaf1', '#e0f2fe')

with open('src/pages/record.css', 'w') as f:
    f.write(css)

