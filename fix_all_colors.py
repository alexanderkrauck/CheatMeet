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

def process_file(filename):
    with open(filename, 'r') as f:
        css = f.read()

    def replace_color(match):
        original = match.group(0)
        try:
            h, l, s = hex_to_hls(original)
            # If it has any saturation and its hue is between yellow/orange (0.08) and teal (0.50)
            if 0.08 <= h <= 0.50 and s > 0.03:
                # Shift hue to blue (0.60)
                new_h = 0.60
                new_hex = hls_to_hex(new_h, l, s)
                if len(original) == 9: # keep alpha
                    new_hex += original[7:]
                return new_hex
            
            # If it's very warm white / yellowish grey
            if l > 0.90 and s > 0.02 and h < 0.25:
                # make it crisp white or slightly blue-ish white
                return '#f8fafc'
                
            # If it's a dark greenish gray (low lightness, low sat, green hue)
            if l < 0.3 and s < 0.2 and 0.1 <= h <= 0.5:
                return hls_to_hex(0.60, l, s)
                
        except Exception as e:
            pass
        return original

    new_css = re.sub(r'#[0-9a-fA-F]{3,8}', replace_color, css)
    
    # explicit fallback for the background color seen in record.css and index.css
    new_css = new_css.replace('#f5f5f0', '#f8fafc')
    new_css = new_css.replace('#f4f5f0', '#f8fafc')

    with open(filename, 'w') as f:
        f.write(new_css)

process_file('src/index.css')
process_file('src/pages/record.css')

