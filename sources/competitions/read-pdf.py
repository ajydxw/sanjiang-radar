import sys
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
if len(reader.pages) > 12:
    raise ValueError("Competition notice exceeds 12 pages")
text = "\n".join(page.extract_text() or "" for page in reader.pages)
if len(text.strip()) < 100 or len(text) > 100000:
    raise ValueError("Competition notice text is unavailable or too large")
print(text)
