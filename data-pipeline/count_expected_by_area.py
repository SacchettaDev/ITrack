#!/usr/bin/env python3
"""
Replica a lógica de import_curated_sets (manifest + to_records + dedupe li-{id}-{region})
e imprime contagens por área — útil para saber quantos resultados o filtro Front-End deve mostrar.

Uso:
  cd data-pipeline
  python count_expected_by_area.py --base-dir "%USERPROFILE%\\Downloads"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from import_external_datasets import CANONICAL_AREAS, load_json_array, to_records  # noqa: E402


def load_manifest(path: Path) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)["sets"]


def main() -> int:
    p = argparse.ArgumentParser(description="Contar vagas esperadas por área após dedupe do manifest.")
    p.add_argument("--manifest", type=Path, default=HERE / "curated_sets_manifest.json")
    p.add_argument(
        "--base-dir",
        default=os.environ.get("ITRACK_IMPORT_DIR") or str(Path.home() / "Downloads"),
    )
    p.add_argument("--source-prefix", default="Curated")
    args = p.parse_args()

    base = Path(args.base_dir)
    if not base.is_dir():
        print(f"ERRO: base-dir não existe: {base}")
        return 1

    sets = load_manifest(args.manifest)
    all_records: dict[str, dict] = {}
    missing: list[str] = []
    per_file: list[tuple[str, str, int, int]] = []  # file, area, parsed, kept

    for entry in sets:
        fname = entry["file"]
        area = entry["area"]
        region = entry["region"]
        loc = entry["loc"]
        if area not in CANONICAL_AREAS:
            print(f"ERRO: area inválida {area!r} em {fname}")
            return 1
        fp = base / fname
        if not fp.is_file():
            missing.append(str(fp))
            continue
        source_label = f"{args.source_prefix}-{region}-{area.replace(' ', '-')}"
        items = load_json_array(fp)
        records = to_records(
            items,
            source_label,
            preset_area=area,
            location_bucket=loc,
            strict_it=True,
            id_region=region,
        )
        per_file.append((fname, area, len(items), len(records)))
        for r in records:
            all_records[r["id"]] = r

    by_area = Counter(r["area"] for r in all_records.values())

    print("=== Por ficheiro (antes dedupe global) ===")
    for fname, area, parsed, kept in per_file:
        mark = "  <-- Front-End" if area == "Front-End" else ""
        print(f"  {fname}: parsed={parsed} kept_strict={kept} area={area}{mark}")

    if missing:
        print(f"\nAVISO: {len(missing)} ficheiros em falta em {base}:")
        for m in missing:
            print(f"  - {m}")

    print(f"\n=== Após dedupe global (chave li-{{id}}-{{region}} por entrada curada) ===")
    print(f"  Total linhas únicas na BD simulada: {len(all_records)}")
    print("\n  Por área (isto é o que cada filtro da UI deve mostrar):")
    for a in sorted(by_area.keys()):
        print(f"    {a}: {by_area[a]}")

    fe = by_area.get("Front-End", 0)
    print(f"\n>>> Front-End esperado: {fe} vagas <<<")
    print("    (Ottawa e Gatineau já não colidem no mesmo li-id; filtro Ottawa na API")
    print("     mostra só Curated-ottawa-*; NCR mostra ambos.)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
