from __future__ import annotations

import argparse
import csv
import io
import re
import zipfile
from pathlib import Path


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _find_column(fieldnames: list[str], candidates: list[str]) -> str:
    lookup = {_norm(name): name for name in fieldnames}
    for candidate in candidates:
        if _norm(candidate) in lookup:
            return lookup[_norm(candidate)]
    raise ValueError(f"Could not identify any of {candidates}; available columns: {fieldnames}")


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def load_scope(path: Path) -> set[str]:
    return {_digits(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def extract_csv_from_zip(path: Path) -> tuple[str, bytes]:
    with zipfile.ZipFile(path) as zf:
        csv_names = [name for name in zf.namelist() if name.lower().endswith(".csv")]
        if not csv_names:
            raise ValueError("No CSV file found in ZIP archive")
        # Prefer the largest CSV when metadata/readme CSVs coexist.
        name = max(csv_names, key=lambda n: zf.getinfo(n).file_size)
        return name, zf.read(name)


def extract_annex_trade(
    raw_csv: bytes,
    scope: set[str],
    *,
    partner: str = "United States",
) -> tuple[list[dict[str, str]], dict[str, str]]:
    text = raw_csv.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    fields = reader.fieldnames or []

    commodity_col = _find_column(fields, [
        "HS8", "HS 8", "Commodity code", "Commodity Code", "HS code", "HS Code",
        "Harmonized system code", "Harmonized System Code"
    ])
    partner_col = _find_column(fields, [
        "Trading partner", "Trade partner", "Partner", "Country", "Partner country"
    ])
    value_col = _find_column(fields, [
        "Value", "Trade value", "Customs value", "Domestic export value", "Export value"
    ])

    matched: list[dict[str, str]] = []
    for row in reader:
        if row.get(partner_col, "").strip().casefold() != partner.casefold():
            continue
        code = _digits(row.get(commodity_col, ""))
        if len(code) < 8:
            continue
        code8 = code[:8]
        if code8 not in scope:
            continue
        matched.append({
            "htsus_8": f"{code8[:4]}.{code8[4:6]}.{code8[6:]}",
            "trade_value_local": row.get(value_col, "0"),
        })

    return matched, {
        "commodity_column": commodity_col,
        "partner_column": partner_col,
        "value_column": value_col,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Normalize Statistics Canada CIMT domestic-export bulk data to Annex II HTS8 trade values"
    )
    parser.add_argument("--zip", type=Path, required=True, help="Downloaded CIMT domestic exports ZIP")
    parser.add_argument("--scope", type=Path, required=True, help="One HTSUS 8-digit code per line")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--partner", default="United States")
    args = parser.parse_args()

    name, raw = extract_csv_from_zip(args.zip)
    matched, columns = extract_annex_trade(raw, load_scope(args.scope), partner=args.partner)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["htsus_8", "trade_value_local"])
        writer.writeheader()
        writer.writerows(matched)

    print(f"source_csv={name}")
    print(f"detected_columns={columns}")
    print(f"matched_rows={len(matched)}")
    print(f"output={args.output}")


if __name__ == "__main__":
    main()
