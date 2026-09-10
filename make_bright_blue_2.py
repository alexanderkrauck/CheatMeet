import re

def repl(filename):
    with open(filename, 'r') as f:
        css = f.read()

    css = css.replace('#cfdaeb', '#dbeafe')
    css = css.replace('#435b80', '#2563eb')
    css = css.replace('#dfe4ed', '#eff6ff')
    css = css.replace('#747d8b', '#3b82f6')
    css = css.replace('#d2d8e2', '#bfdbfe')
    
    # folder button
    css = css.replace('.walk-folder {\n  background: transparent;\n  color: #737b88;', '.walk-folder {\n  background: #f0f9ff;\n  color: #1d4ed8;')

    with open(filename, 'w') as f:
        f.write(css)

repl('src/pages/record.css')

