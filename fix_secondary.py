with open('src/pages/record.css', 'r') as f:
    css = f.read()

css = css.replace('color: #646f7f;', 'color: #3b82f6;')

with open('src/pages/record.css', 'w') as f:
    f.write(css)

