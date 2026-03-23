#!/usr/bin/env python3
"""
Varredura de todos os JSON do manifest: conta o que passa / falha o filtro TI (strict).

Uso:
  cd data-pipeline
  python audit_curated_sources.py --base-dir "C:\\Users\\GIGABYTE\\Downloads"
  python audit_curated_sources.py --show-rejected 40   # amostra de títulos rejeitados
  python audit_curated_sources.py --show-kept-suspect  # títulos que passam mas com palavras de risco
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from import_external_datasets import (  # noqa: E402
    CANONICAL_AREAS,
    is_it_job_strict,
    load_json_array,
    matches_curated_bucket,
    matches_location_bucket,
    normalize_text,
)


def load_manifest(path: Path) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)["sets"]


SUSPECT_WORDS = re.compile(
    r"\b(financial|finance|payroll|retail|merchandise|warehouse|driver|nurse|"
    r"teacher|bartender|recruit|sales|marketing|hr |legal )\b",
    re.I,
)


def audit_row(row: dict, loc: str, manifest_area: str) -> tuple[bool, str]:
    title = normalize_text(row.get("title", ""))
    company = normalize_text(row.get("companyName", "")) or "Unknown company"
    location = normalize_text(row.get("location", "")) or "Ottawa, Ontario, Canada"
    work_type = normalize_text(row.get("workType", ""))
    sector = normalize_text(row.get("sector", ""))
    description = normalize_text(row.get("description", ""))
    url = normalize_text(row.get("jobUrl", "") or row.get("applyUrl", ""))

    if not title or not url:
        return False, "sem titulo ou url"
    if not matches_location_bucket(location, loc):
        return False, "localização fora do bucket"
    if not is_it_job_strict(title, description, work_type, sector):
        return False, "não passa filtro TI (strict)"
    if not matches_curated_bucket(manifest_area, title, description):
        return False, "título/descrição não batem com a área do ficheiro (auditoria)"
    return True, "ok"


def main() -> int:
    parser = argparse.ArgumentParser(description="Audita JSON curados contra filtros TI + localização.")
    parser.add_argument("--manifest", type=Path, default=HERE / "curated_sets_manifest.json")
    parser.add_argument(
        "--base-dir",
        default=os.environ.get("ITRACK_IMPORT_DIR") or str(Path.home() / "Downloads"),
    )
    parser.add_argument("--show-rejected", type=int, default=0, metavar="N", help="Mostrar N rejeições por ficheiro")
    parser.add_argument(
        "--show-kept-suspect",
        action="store_true",
        help="Títulos mantidos que contêm palavras frequentemente não-TI (revisão manual)",
    )
    args = parser.parse_args()

    base = Path(args.base_dir)
    if not base.is_dir():
        print(f"ERRO: {base} não existe")
        return 1

    sets = load_manifest(args.manifest)
    total_parsed = 0
    total_kept = 0
    reasons = Counter()
    rejected_samples: dict[str, list[str]] = {}
    suspect_kept: list[tuple[str, str]] = []

    for entry in sets:
        fname = entry["file"]
        area = entry["area"]
        loc = entry["loc"]
        if area not in CANONICAL_AREAS:
            print(f"ERRO manifest: area inválida {area!r} em {fname}")
            return 1
        fp = base / fname
        if not fp.is_file():
            print(f"SKIP ficheiro em falta: {fp}")
            continue
        items = load_json_array(fp)
        kept = 0
        rej: list[str] = []
        for row in items:
            total_parsed += 1
            ok, reason = audit_row(row, loc, area)
            reasons[reason] += 1
            if ok:
                kept += 1
                title = normalize_text(row.get("title", ""))
                if args.show_kept_suspect and SUSPECT_WORDS.search(title):
                    suspect_kept.append((fname, title))
            else:
                if len(rej) < max(args.show_rejected, 0):
                    rej.append(f"{reason}: {normalize_text(row.get('title', ''))[:100]}")
        total_kept += kept
        rejected_samples[fname] = rej
        print(f"{fname}: parsed={len(items)} kept_strict={kept} area={area}")

    print(f"\n--- Resumo global ---")
    print(f"Linhas JSON (vagas): {total_parsed}")
    print(f"Mantidas (strict TI + local): {total_kept}")
    print(f"Rejeitadas: {total_parsed - total_kept}")
    print("Motivos (top):")
    for r, c in reasons.most_common(12):
        print(f"  {c:5}  {r}")

    if args.show_rejected > 0:
        print("\n--- Amostra rejeitados ---")
        for fname, samples in rejected_samples.items():
            if not samples:
                continue
            print(f"\n{fname}:")
            for s in samples[: args.show_rejected]:
                print(f"  - {s}")

    if args.show_kept_suspect and suspect_kept:
        print("\n--- Mantidos com palavra ‘suspeita’ no título (rever) ---")
        for fn, t in suspect_kept[:80]:
            print(f"  {fn}: {t}")
        if len(suspect_kept) > 80:
            print(f"  ... +{len(suspect_kept) - 80} mais")

    print(f"\nÁreas canónicas (filtros UI): {sorted(CANONICAL_AREAS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
