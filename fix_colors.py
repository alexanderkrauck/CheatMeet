import re
import colorsys

def hex_to_hls(hex_color):
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 3:
        hex_color = ''.join([c*2 for c in hex_color])
    if len(hex_color) == 8: # rgba
        hex_color = hex_color[:6]
    r, g, b = tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
    return colorsys.rgb_to_hls(r/255.0, g/255.0, b/255.0)

def hls_to_hex(h, l, s):
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return '#{:02x}{:02x}{:02x}'.format(int(r*255), int(g*255), int(b*255))

with open('src/index.css', 'r') as f:
    css = f.read()

def replace_color(match):
    original = match.group(0)
    try:
        h, l, s = hex_to_hls(original)
        # If it's a greenish or yellowish color (H between 0.15 and 0.45)
        if 0.15 <= h <= 0.45 and s > 0.05:
            # Shift hue to blue (around 0.58 to 0.65)
            new_h = 0.60
            new_hex = hls_to_hex(new_h, l, s)
            return new_hex
        # Or if it's very warm white (l > 0.9 and s > 0.1 and h < 0.2)
        if l > 0.93 and s > 0.05 and h < 0.25:
            # make it crisp white or slightly blue-ish white
            return '#ffffff'
    except:
        pass
    return original

new_css = re.sub(r'#[0-9a-fA-F]{3,8}', replace_color, css)

# Explicit fix for yellowish off-whites
new_css = new_css.replace('#fafbf6', '#ffffff')
new_css = new_css.replace('#fbfcf8', '#ffffff')
new_css = new_css.replace('#fcfcf9', '#ffffff')
new_css = new_css.replace('#f4f5f0', '#f1f5f9')
new_css = new_css.replace('#f4f5f1', '#f1f5f9')
new_css = new_css.replace('#f7f8f2', '#f8fafc')
new_css = new_css.replace('#f3f6eb', '#f0f9ff')

with open('src/index.css', 'w') as f:
    f.write(new_css)
