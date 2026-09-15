"""Runner for April-2 PolicyImpact sensitivity with robust source parsers.

Two source-format issues are handled here without changing the economic definition:
1. CBP Section 232 PDFs mix 6/8/10-digit HTS patterns.
2. IMF serves the October-2024 WEO country dataset with an Excel MIME type even though
   older WEO downloads have also appeared as tab-delimited text.  We support both forms.
"""

from __future__ import annotations

import csv
import io
import re

import xlrd

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
    # plus occasional 6-digit subheading prefixes.  Longest-first alternatives
    # prevent truncating a 10-digit statistical reporting number to 8 digits.
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


def _resolve_gdp(rows: list[dict[str, object]]) -> tuple[dict[str, float], dict[str, object]]:
    by_name: dict[str, float] = {}
    for row in rows:
        if str(row.get("WEO Subject Code", "")).strip() != "NGDPD":
            continue
        country = str(row.get("Country", "")).strip()
        raw_value = str(row.get("2024", "")).replace(",", "").strip()
        if not country or not raw_value or raw_value in {"--", "nan", "None"}:
            continue
        try:
            value = float(raw_value)
        except ValueError:
            continue
        scale = str(row.get("Scale", "")).strip().lower()
        multiplier = 1e9 if "billion" in scale else 1e6 if "million" in scale else 1.0
        by_name[country] = value * multiplier

    out: dict[str, float] = {}
    resolved_names: dict[str, str] = {}
    for target, aliases in engine.GDP_NAMES.items():
        matches = [(name, by_name[name]) for name in aliases if name in by_name]
        if len(matches) != 1:
            raise ValueError(f"Could not uniquely resolve IMF WEO GDP for {target}: {matches}")
        resolved_names[target] = matches[0][0]
        out[target] = matches[0][1]

    return out, {
        "source": engine.IMF_WEO_OCT24,
        "vintage": "October 2024 WEO",
        "series": "NGDPD: GDP, current prices, U.S. dollars",
        "denominator_year": 2024,
        "resolved_names": resolved_names,
        "point_in_time_rationale": (
            "October-2024 WEO was public before the 2025-04-02 event. The 2024 current-USD GDP "
            "denominator is paired with TTM imports through January 2025 and avoids later GDP revisions."
        ),
    }


def load_weo_gdp_binary_safe() -> tuple[dict[str, float], dict[str, object]]:
    raw = engine.fetch_bytes(engine.IMF_WEO_OCT24, timeout=180)
    rows: list[dict[str, object]] = []
    source_format: str

    # Legacy WEO files sometimes use a .xls suffix for tab-delimited values.
    decoded = raw.decode("utf-8-sig", errors="ignore")
    if "WEO Subject Code" in decoded and "\t" in decoded[:5000]:
        source_format = "tab_delimited_values"
        rows = [dict(row) for row in csv.DictReader(io.StringIO(decoded), delimiter="\t")]
    else:
        source_format = "binary_xls"
        try:
            workbook = xlrd.open_workbook(file_contents=raw)
        except Exception as exc:
            magic = raw[:24].hex()
            raise ValueError(
                f"IMF WEO source is neither recognized TSV nor readable XLS; bytes={len(raw)}, magic={magic}"
            ) from exc

        sheet = workbook.sheet_by_index(0)
        header_row = None
        for r in range(min(sheet.nrows, 25)):
            values = [str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols)]
            if "WEO Subject Code" in values and "Country" in values and "2024" in values:
                header_row = r
                break
        if header_row is None:
            raise ValueError("Could not locate WEO header row containing Country / WEO Subject Code / 2024")

        headers = [str(sheet.cell_value(header_row, c)).strip() for c in range(sheet.ncols)]
        for r in range(header_row + 1, sheet.nrows):
            row: dict[str, object] = {}
            for c, header in enumerate(headers):
                if not header:
                    continue
                cell = sheet.cell_value(r, c)
                if isinstance(cell, float) and cell.is_integer():
                    cell = int(cell)
                row[header] = cell
            rows.append(row)

    gdp, audit = _resolve_gdp(rows)
    audit["source_format"] = source_format
    audit["source_bytes"] = len(raw)
    audit["parsed_rows"] = len(rows)
    return gdp, audit


if __name__ == "__main__":
    engine.extract_numeric_section = extract_numeric_section_mixed_length
    engine.load_weo_gdp = load_weo_gdp_binary_safe
    engine.main()
