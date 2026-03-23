#!/usr/bin/env python3
"""
Importa todos os JSON curados (Ottawa/Gatineau por área) definidos em curated_sets_manifest.json.

Uso (PowerShell):
  cd data-pipeline
  .venv\\Scripts\\activate
  $env:ITRACK_IMPORT_DIR = "C:\\Users\\GIGABYTE\\Downloads"
  python import_curated_sets.py --replace-all

--replace-all : esvazia job_snapshot antes (recomendado para alinhar com os ficheiros que deste).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from import_external_datasets import (  # noqa: E402
    CANONICAL_AREAS,
    connect_db,
    ensure_schema,
    load_json_array,
    to_records,
    upsert,
)


def load_manifest(path: Path) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["sets"]


def truncate_snapshot(conn):
    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE job_snapshot RESTART IDENTITY;")
    conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser(description="Import curated Ottawa/Gatineau JSON sets from manifest.")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=HERE / "curated_sets_manifest.json",
        help="JSON com lista sets: file, area, region, loc",
    )
    parser.add_argument(
        "--base-dir",
        default=os.environ.get("ITRACK_IMPORT_DIR") or str(Path.home() / "Downloads"),
        help="Pasta onde estão os .json (ou defina ITRACK_IMPORT_DIR)",
    )
    parser.add_argument(
        "--source-prefix",
        default="Curated",
        help="Prefixo do campo source (ex.: Curated → Curated-ottawa-Cloud)",
    )
    parser.add_argument(
        "--replace-all",
        action="store_true",
        help="TRUNCATE job_snapshot antes de importar (limpa dados antigos / APIs).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Só contar linhas, sem gravar na BD.")
    args = parser.parse_args()

    base = Path(args.base_dir)
    if not base.is_dir():
        print(f"ERRO: base-dir não existe: {base}")
        return 1

    sets = load_manifest(args.manifest)
    all_records: dict[str, dict] = {}
    missing: list[str] = []

    for entry in sets:
        fname = entry["file"]
        area = entry["area"]
        region = entry["region"]
        loc = entry["loc"]
        if area not in CANONICAL_AREAS:
            print(f"ERRO: area {area!r} em {fname} não está em CANONICAL_AREAS: {sorted(CANONICAL_AREAS)}")
            return 1
        fp = base / fname
        if not fp.is_file():
            missing.append(str(fp))
            print(f"SKIP (ficheiro em falta): {fp}")
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
        for r in records:
            all_records[r["id"]] = r
        print(f"{fname}: parsed={len(items)} kept_it={len(records)} area={area} loc={loc}")

    if missing:
        print(f"\nAviso: {len(missing)} ficheiros em falta. Coloca-os em {base} ou ajusta o manifest.")

    deduped = list(all_records.values())
    print(f"\nTotal único após dedupe: {len(deduped)}")

    if args.dry_run:
        return 0

    try:
        conn = connect_db()
    except Exception as e:
        msg = str(e).lower()
        if "28p01" in msg or "password authentication failed" in msg or "authentication failed" in msg:
            env_path = HERE / ".env"
            print("\n*** ERRO PostgreSQL: utilizador ou palavra-passe recusados ***")
            print(f"    Edita: {env_path}")
            print("    Define POSTGRES_USER e POSTGRES_PASSWORD iguais ao teu servidor.")
            print("    Se não existir .env:  copy .env.example .env   e altera a password.")
            print("    A API (appsettings.Development.json → JobsSnapshotDb) tem de usar a mesma base/password.\n")
        raise

    try:
        ensure_schema(conn, str(HERE / "schema.sql"))
        if args.replace_all:
            truncate_snapshot(conn)
            print("job_snapshot truncada (--replace-all).")
        upsert(conn, deduped)
    finally:
        conn.close()

    print("Import curated concluído.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
