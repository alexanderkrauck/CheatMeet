with open('src/pages/record.css', 'r') as f:
    css = f.read()

css = css.replace('color: #45566f;', 'color: #1e40af;') # text
css = css.replace('border: 1px solid #d2d8e3;', 'border: 1px solid #bfdbfe;')

with open('src/pages/record.css', 'w') as f:
    f.write(css)

