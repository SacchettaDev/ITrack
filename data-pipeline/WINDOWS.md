# Windows: CMD vs PowerShell

## Prompt **cmd.exe** (o que mostra `C:\Users\...>`)

Ativar venv (só se a pasta `.venv` existir):

```bat
cd C:\Users\GIGABYTE\Documents\ITrack\data-pipeline
py -m venv .venv
.venv\Scripts\activate.bat
```

Pasta dos JSON (não uses `$env:` — isso é PowerShell):

```bat
set ITRACK_IMPORT_DIR=C:\Users\GIGABYTE\Downloads
```

Import:

```bat
python import_curated_sets.py --replace-all
```

## PowerShell

```powershell
cd C:\Users\GIGABYTE\Documents\ITrack\data-pipeline
py -m venv .venv
.\.venv\Scripts\Activate.ps1
$env:ITRACK_IMPORT_DIR = "C:\Users\GIGABYTE\Downloads"
python import_curated_sets.py --replace-all
```

## Erro `password authentication failed for user "postgres"`

1. Cria/edita o ficheiro **`data-pipeline\.env`** (podes copiar `.env.example`).
2. Mete **`POSTGRES_PASSWORD`** (e `POSTGRES_USER` se não for `postgres`) **iguais** ao teu PostgreSQL.
3. No backend, em **`ITrack.api\appsettings.Development.json`**, a connection string **`JobsSnapshotDb`** deve usar a **mesma** password (campo `Password=...`).

O import carrega sempre `.env` da pasta `data-pipeline`, mesmo que corras o comando noutro diretório.
