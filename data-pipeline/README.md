# ITrack Snapshot Scraping Pipeline

This pipeline collects IT jobs from Job Bank, Indeed, and LinkedIn (Ottawa/Gatineau/Kanata), deduplicates them, and loads a static snapshot into PostgreSQL.

**Windows:** se usas **CMD** (não PowerShell), vê [WINDOWS.md](WINDOWS.md) — `set ITRACK_IMPORT_DIR=...` e `activate.bat` em vez de `$env:` e `Activate.ps1`.

## 1) Setup

- Install Python 3.11+
- Create virtual environment
- Install dependencies

```bash
cd data-pipeline
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

## 2) Configure PostgreSQL

Edit `.env` with your PostgreSQL credentials.

## 3) Run one-time snapshot

```bash
python run_pipeline.py
```

This will:
- scrape sources,
- dedupe,
- write `output/jobs_snapshot_*.jsonl`,
- create table `job_snapshot` if missing,
- upsert rows into PostgreSQL.

## 4) Reset completo da BD (recomendado se os filtros/contagens estiverem errados)

1. Garante PostgreSQL a correr e o `.env` do `data-pipeline` correto.
2. Importa de novo com truncagem (apaga **toda** a `job_snapshot` e repõe só os JSON do manifest):

```powershell
cd data-pipeline
.venv\Scripts\activate
$env:ITRACK_IMPORT_DIR = "C:\Users\GIGABYTE\Downloads"
python import_curated_sets.py --replace-all
```

3. Reinicia a API (`ITrack.api`) para limpar caches em memória, se houver.

**Notas:** Cada vaga com `id` do LinkedIn no import curado usa `li-{id}-{region}` (ex.: `…-ottawa`, `…-gatineau`) para a mesma vaga poder existir nos **dois** mercados sem sobrescrever. O filtro **Ottawa** na API mostra só `Curated-ottawa-*`; **Ottawa–Gatineau (NCR)** mostra ambos. A listagem via API **não** corta por `posted_date` no modo snapshot (dump estático).

**Se a UI mostrar ~4–5 vagas Front-End mas o `OttawaFront.json` tiver dezenas:** (1) Confirma que correste `import_curated_sets.py --replace-all` **depois** da alteração aos IDs com sufixo de região — senão o manifest processa Gatineau a seguir a Ottawa e o mesmo `li-{id}` apaga as linhas de Ottawa. (2) Corre `python count_expected_by_area.py --base-dir "%USERPROFILE%\Downloads"` e compara com a UI; se o script mostrar muito mais que a API, a BD não foi reposta ou a API aponta para outra base.

## 4.1) Auditoria de todos os JSON do manifest (TI + bucket por área)

Remove do pipeline o que não é TI (`is_it_job_strict`) e o que não bate com a área do ficheiro (ex.: Linux embebido no `OttawaFront.json`, security puro sem stack web).

```powershell
cd data-pipeline
.venv\Scripts\activate
python audit_curated_sources.py --base-dir "%USERPROFILE%\Downloads"
python audit_curated_sources.py --show-rejected 20
```

Depois de alterares regras, volta a correr `import_curated_sets.py --replace-all`. O import grava **`technologies`** com deteção alargada e preenchimento por área quando o texto é genérico.

## 5) Connect backend to snapshot DB

Set `ConnectionStrings:JobsSnapshotDb` in:
- `backend/ITrack.api/appsettings.Development.json`

Example:

```json
{
  "ConnectionStrings": {
    "JobsSnapshotDb": "Host=localhost;Port=5432;Database=itrack;Username=postgres;Password=postgres"
  }
}
```

When `JobsSnapshotDb` is set, the API serves **only** `job_snapshot` for `/jobs` (no Adzuna/SerpApi mix). Re-import curated JSON after changing data.

## 6) Import curado (todos os Ottawa/Gatineau por área)

1. Coloca os `.json` do LinkedIn na pasta (por defeito `Downloads`) ou define `ITRACK_IMPORT_DIR`.
2. Ajusta nomes em [`curated_sets_manifest.json`](curated_sets_manifest.json) se um ficheiro tiver nome diferente.
3. Importa tudo de uma vez (recomendado **limpar** a tabela antes):

```powershell
cd data-pipeline
.venv\Scripts\activate
$env:ITRACK_IMPORT_DIR = "C:\Users\GIGABYTE\Downloads"
python import_curated_sets.py --replace-all
```

- Cada ficheiro recebe **`area`** fixa (Cloud, Data, Cybersecurity, …) alinhada com os filtros do frontend.
- **`loc`**: `ottawa_metro` vs `gatineau_metro` remove anúncios da região errada.
- **`strict_it`**: remove cargos óbvios de retalho / loja (merchandise, cashier, …).
- `source` fica como `Curated-ottawa-Cloud`, etc.

`--dry-run` só conta linhas sem gravar na BD.

### Auditar ficheiros curados (antes de importar)

Aplica a mesma lógica de localização + `is_it_job_strict` que o import, sem tocar na BD:

```powershell
cd data-pipeline
.venv\Scripts\activate
python audit_curated_sources.py --base-dir "C:\Users\GIGABYTE\Downloads"
```

- `--show-rejected 30` — exemplos de linhas rejeitadas.
- `--show-kept-suspect` — mantidas mas com título “suspeito” (revisão manual).

As **áreas** no manifest devem ser exatamente: `Back-End`, `Cloud`, `Cybersecurity`, `Data`, `Front-End`, `Full-Stack`, `Quality Assurance` (alinhado com o frontend).

## 7) Import LinkedIn-style JSON (um ficheiro por região / papel)

Não é obrigatório “adivinhar” a área pelo texto da vaga. Com ficheiros já separados por nome, define a **área (e opcionalmente a região)** no próprio comando:

**Formato recomendado** — `caminho::Área` ou `caminho::Área::regiao`:

```bash
.venv\Scripts\activate
python import_external_datasets.py "C:\exports\OttawaFullstack.json::Full-Stack::ottawa" --source LinkedIn
python import_external_datasets.py "C:\exports\Gatineau_Cloud.json::Cloud::gatineau" --source LinkedIn
```

- A **área** (`Full-Stack`, `Back-End`, `Data`, …) aplica-se a todas as vagas IT desse ficheiro.
- O **regiao** (terceiro segmento) só entra no rótulo `source` (ex.: `LinkedIn-ottawa`) para distinguir no snapshot.

Para **nunca** inferir área pelo conteúdo (só o que passares no CLI):

```bash
python import_external_datasets.py "C:\exports\OttawaFullstack.json::Full-Stack" --source LinkedIn --no-infer-area
```

Ou uma área global para vários ficheiros sem `::`:

```bash
python import_external_datasets.py ficheiro1.json ficheiro2.json --preset-area "Full-Stack" --no-infer-area
```

Heurística por texto (`infer_area`) continua disponível se **não** usares `::`, `--preset-area` nem `--no-infer-area`.

Depois reinicia a API e atualiza o dashboard.
