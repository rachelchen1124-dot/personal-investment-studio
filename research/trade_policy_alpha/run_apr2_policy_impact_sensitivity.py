"""Runner for April-2 PolicyImpact sensitivity with mixed-length HTS PDF parsing.

CBP Section 232 scope PDFs mix 8-digit subheadings such as 7610.10.00 with
10-digit statistical reporting numbers such as 7615.10.2015.  The research
engine must preserve the published pattern length because Census is HTS10 and
matching is by prefix.
"""

from __future__ import annotations

import re

import build_apr2_policy_impact_sensitivity as engine


def extract_numeric_section_mixed_length(
    text: str, start_heading: str, end_heading: str
) -> list[str]:
    start = text.find(start_heading)
    end = text.find(end_heading, start + len(start_heading)) if start >= 0 else -1
    if start < 0 or end < 0 or end <= start:
        raise ValueError(f"Could not bound PDF section {start_heading} -> {end_heading}")

    section = text[start + len(start_heading) : end]

    # Published HTS forms encountered in CBP scope attachments include:
    # 7610.10.00 (8 digits), 7615.10.2015 (10 digits), 8708.10.60 (8 digits),
    # and occasionally 6-digit heading/subheading prefixes.  Longest-first
    # alternatives prevent truncating 10-digit reporting numbers to 8 digits.
    raw = re.findall(
        r"(?<!\d)(?:\d{4}\.\d{2}\.\d{4}|\d{4}\.\d{2}\.\d{2}|\d{4}\.\d{2}|\d{4})(?!\d)",
        section,
    )

    out: list[str] = []
    seen: set[str] = set()
    for token in raw:
        code = token.replace(".", "")
        if code.startswith("9903") or not code.isdigit() or len(code) not in {4, 6, 8, 10}:
            continue
        chapter = int(code[:2])
        if not 1 <= chapter <= 97:
            continue
        if code not in seen:
            seen.add(code)
            out.append(code)
    return out


if __name__ == "__main__":
    engine.extract_numeric_section = extract_numeric_section_mixed_length
    engine.main()
