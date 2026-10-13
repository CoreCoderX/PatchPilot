def label(text: str) -> str:
    stripped = text.strip()
    return stripped.capitalize() if stripped else "empty"
