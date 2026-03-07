from pathlib import Path
text = path.read_text()
if old not in text:
text = text.replace(old, new)
path.write_text(text)
