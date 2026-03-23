import argparse
import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path

import pg8000
from dotenv import load_dotenv

# Carregar .env junto a este ficheiro (funciona mesmo que o cwd não seja data-pipeline)
_PIPELINE_DIR = Path(__file__).resolve().parent
load_dotenv(_PIPELINE_DIR / ".env")

# Alinhado com SupportedAreas (backend) e areaOptions (frontend)
CANONICAL_AREAS = frozenset(
    {
        "Cybersecurity",
        "Back-End",
        "Front-End",
        "Data",
        "Cloud",
        "Full-Stack",
        "Quality Assurance",
    }
)

# Usado só em infer_area (texto longo); NÃO usar lista solta em descrições completas para is_it_job.
IT_KEYWORDS = [
    "developer", "engineer", "software", "frontend", "front-end", "backend", "back-end",
    "full stack", "full-stack", "data", "cloud", "devops", "security", "cyber",
    "qa", "test", "sre", ".net", "java", "python", "react", "angular", "node", "sql",
    "analyst", "architect", "it ", "programmer", "machine learning", "scientist",
    "kubernetes", "terraform", "scrum", "agile", "api ", "apis", "database",
]

# Cargos claramente NÃO-TI (cozinha, loja, saúde clínica, ofícios, etc.)
NON_IT_TITLE_REGEXES = [
    re.compile(r"\b(general )?merchandise\b", re.I),
    re.compile(r"\bretail associate\b", re.I),
    re.compile(r"\bcashier\b", re.I),
    re.compile(r"\bbarista\b", re.I),
    re.compile(r"\bwarehouse (worker|associate|clerk)\b", re.I),
    re.compile(r"\b(deli|produce) clerk\b", re.I),
    re.compile(r"\bstore associate\b", re.I),
    re.compile(r"\bsales associate\b", re.I),
    re.compile(r"\bstock (clerk|associate)\b", re.I),
    re.compile(r"\bdelivery driver\b", re.I),
    re.compile(r"\btruck driver\b", re.I),
    re.compile(r"\buber\b|\blyft\b", re.I),
    re.compile(r"\bnurse\b", re.I),
    re.compile(r"\bphysiotherapist\b", re.I),
    re.compile(r"\bdental hygienist\b", re.I),
    re.compile(r"\b(line )?cook\b", re.I),
    re.compile(r"\b(head |executive |sous |pastry )chef\b", re.I),
    re.compile(r"\bbaker\b", re.I),
    re.compile(r"\bwait(er|ress)\b", re.I),
    re.compile(r"\bhost(ess)?\b", re.I),
    re.compile(r"\bbartender\b", re.I),
    re.compile(r"\bdishwasher\b", re.I),
    re.compile(r"\bhousekeeper\b", re.I),
    re.compile(r"\bcleaner\b", re.I),
    re.compile(r"\bjanitor\b|\bcustodian\b", re.I),
    re.compile(r"\bsecurity (guard|officer)\b", re.I),
    re.compile(r"\blandscap(er|ing)\b", re.I),
    re.compile(r"\bplumber\b|\belectrician\b|\bcarpenter\b|\broofer\b", re.I),
    re.compile(r"\bmechanic\b|\bautomotive technician\b", re.I),
    re.compile(r"\bforklift\b", re.I),
    re.compile(r"\blas(er|ing) technician\b", re.I),
    re.compile(r"\bphlebotomist\b", re.I),
    re.compile(r"\bmedical office assistant\b", re.I),
    re.compile(r"\bpersonal support worker\b|\bpsw\b", re.I),
    # Ensino: não bloquear tutores/professores de TI (ex.: "JavaScript Tutor"). Só cargos claramente não-tech.
    re.compile(
        r"\b(elementary|kindergarten|preschool|primary|secondary|high school|middle school|substitute|"
        r"physical education|special education)\s+teacher\b",
        re.I,
    ),
    re.compile(
        r"\b(math|mathematics|english|french|spanish|calculus|algebra|geometry|statistics|physics|chemistry|"
        r"biology|history|geography|social studies|literacy|reading|writing|esol|esl|music|piano|guitar|art|drama|"
        r"economics|psychology|sat|act|gmat|gre|lsat)\s+(teacher|tutor|instructor)\b",
        re.I,
    ),
    re.compile(
        r"\b(teacher|tutor|instructor)\s+[-–—]\s*(math|mathematics|english|french|spanish|music|science)\b",
        re.I,
    ),
    re.compile(
        r"\b(tuteur|tutrice)\s+(en\s+)?(français|anglais|espagnol|mathématiques|mathematiques|musique|histoire|"
        r"physique|chimie|biologie|philosophie)\b",
        re.I,
    ),
    re.compile(r"\buniversity professor\b|\btenure[\s-]track professor\b", re.I),
    re.compile(r"\bchildcare\b|\bdaycare\b", re.I),
    re.compile(r"\breal estate agent\b|\brealtor\b", re.I),
    re.compile(r"\bhair stylist\b|\bhairstylist\b|\bbarber\b", re.I),
    re.compile(r"\bmanicurist\b|\besthetician\b", re.I),
    re.compile(r"\bfitness instructor\b|\bpersonal trainer\b", re.I),
    re.compile(r"\baccountant\b|\bbookkeeper\b", re.I),
    re.compile(
        r"\b(financial|finance|accounting|payroll|billing|budget|treasury|hr|human resources|"
        r"people operations|legal|procurement|purchasing|office|executive|facilities|"
        r"business operations|loan|credit|mortgage)\s+administrator\b",
        re.I,
    ),
    re.compile(r"\badministrative assistant\b|\boffice manager\b", re.I),
    re.compile(r"\bparalegal\b", re.I),
    re.compile(r"\breceptionist\b", re.I),
    re.compile(r"\bwarehouse operator\b", re.I),
    re.compile(r"\bfarm worker\b|\bharvest\b", re.I),
    re.compile(r"\b(business|corporate|partnership|channel|sales|commercial)\s+developer\b", re.I),
    re.compile(
        r"\b(payroll|billing|accounts payable|accounts receivable|a/r|a/p|treasury|grant|fiscal)\s+"
        r"(specialist|coordinator|clerk|analyst|officer)\b",
        re.I,
    ),
    re.compile(r"\b(call center|contact centre|customer service)\s+(agent|representative)\b", re.I),
    re.compile(r"\binsurance (agent|broker|adjuster)\b", re.I),
    re.compile(r"\brecruiter\b|\brecruitment consultant\b", re.I),
    re.compile(r"\bcopywriter\b|\bcontent writer\b|\bjournalist\b", re.I),
    re.compile(r"\btranslator\b|\binterpreter\b", re.I),
    re.compile(r"\bwarehouse (worker|associate|clerk|manager|supervisor|lead)\b", re.I),
    re.compile(r"\bship(ping)? receiver\b", re.I),
]

# Francês (Outaouais) — cargos TI explícitos
IT_ROLE_FRENCH = [
    re.compile(r"\b(développeur|developpeur|programmeur)\b", re.I),
    re.compile(r"\b(ingénieur|ingenieur)\s+(logiciel|données|donnees|cloud|sécurité|securité|devops)\b", re.I),
    re.compile(r"\b(ingénieur|ingenieur)\s+d[ée]veloppement\b", re.I),
    re.compile(
        r"\b(tuteur|tutrice|tuteur\.trice)\s+(en\s+)?(programmation|développement web|developpement web|"
        r"informatique|python|javascript|java|html|css|react|données|donnees|cybersécurité|cybersecurité)\b",
        re.I,
    ),
    re.compile(
        r"\b(programmation|développement web|developpement web|informatique|python|javascript)\s+(tuteur|tutrice)\b",
        re.I,
    ),
]

# Padrões de cargo TI: aplicados ao TÍTULO e ao início da descrição (evita "data" no rodapé legal)
IT_ROLE_IN_TITLE_OR_HEADLINE = [
    re.compile(
        r"\b(software|application|web|mobile|ios|android|embedded|full[\s-]?stack|front[\s-]?end|back[\s-]?end)\s+(developer|engineer|dev)\b",
        re.I,
    ),
    re.compile(r"\b(developer|programmer)\b", re.I),
    re.compile(r"\bdevops\b", re.I),
    re.compile(r"\bsite reliability\b|\bsre\b", re.I),
    re.compile(r"\bdata (engineer|scientist|analyst|architect)\b", re.I),
    re.compile(r"\b(bi developer|bi analyst|business intelligence)\b", re.I),
    re.compile(r"\b(qa |quality assurance|test (automation )?engineer|sdet)\b", re.I),
    # Não usar só "information security" solto — aparece em qualquer política de RH; exige cargo explícito
    re.compile(r"\b(cybersecurity|cyber security|cyber defence|cyber defense)\b", re.I),
    re.compile(
        r"\b(information security|infosec)\s+(engineer|analyst|architect|manager|consultant|specialist|lead|director)\b",
        re.I,
    ),
    re.compile(r"\b(application|network|cloud|software)\s+security\s+(engineer|architect|analyst|specialist)\b", re.I),
    re.compile(r"\bchief information security officer\b|\bciso\b", re.I),
    # engineer/architect — sem "application" solto (evita "job application" + "Engineer" no título)
    re.compile(
        r"\b(software|cloud|data|network|systems|security|platform|infrastructure|database|automation|machine learning|ml |ai )\s*(engineer|architect)\b",
        re.I,
    ),
    re.compile(r"\b(application|web|mobile)\s+(software\s+)?(engineer|architect|developer)\b", re.I),
    re.compile(r"\b(software|solutions|technical|enterprise|cloud|data|security)\s+architect\b", re.I),
    re.compile(r"\bdatabase\s+administrator\b|\bdba\b", re.I),
    # Administradores claramente de TI / infra (frases explícitas)
    re.compile(
        r"\b(network|systems|cloud|windows|linux|azure|aws|kubernetes|servicenow|"
        r"active directory|identity|o365|office 365|exchange|sharepoint|intune|vmware|citrix)\s+administrator\b",
        re.I,
    ),
    re.compile(r"\b(salesforce|dynamics|workday|sap)\s+(administrator|admin|consultant)\b", re.I),
    re.compile(r"\b(it|ict)\s+administrator\b", re.I),
    re.compile(r"\bit (engineer|architect|administrator|admin|manager|director|lead|consultant)\b", re.I),
    re.compile(r"\btechnical (lead|manager|director|architect|consultant|specialist)\b", re.I),
    re.compile(r"\b(support|implementation|integration|customer|platform)\s+engineer\b", re.I),
    re.compile(r"\btechnical implementation specialist\b", re.I),
    re.compile(r"\b(solutions|technical)\s+consultant\b", re.I),
    re.compile(r"\b(senior|staff|principal|lead)?\s*(software|platform|cloud)\s+engineer\b", re.I),
    re.compile(r"\b(scrum master|agile coach|release manager)\b", re.I),
    re.compile(r"\bproduct owner\b", re.I),
    re.compile(r"\bux designer\b|\bui designer\b|\bproduct designer\b", re.I),
    re.compile(r"\bpen(?:etration)? tester\b|\bred team\b", re.I),
    # Tutoria / ensino explícito em tecnologia (título)
    re.compile(
        r"\b(web design|web development|software development|software|programming|coding|"
        r"full[\s-]?stack|front[\s-]?end|back[\s-]?end|html|css|javascript|typescript|"
        r"react|angular|vue\.?js|node\.?js|python|java|sql|\.net|\bc#\b|php|ruby|\bgo\b|rust|swift|kotlin|"
        r"aws|azure|gcp|devops|kubernetes|docker|terraform|ansible|jenkins|"
        r"data science|machine learning|\bml engineering\b|cloud computing|cybersecurity|cyber security|"
        r"supabase|firebase|mongodb|postgresql|postgres|mysql|graphql|redis|wordpress|shopify|"
        r"computer science|informatics|informatique)\s+tutor\b",
        re.I,
    ),
    re.compile(
        r"\b(tech|technology|computer|digital|coding|programming|software|web|data|cloud|devops|"
        r"cyber|security)\s+(tutor|instructor|coach|mentor)\b",
        re.I,
    ),
    re.compile(r"\b(it|ict)\s+(tutor|instructor|trainer)\b", re.I),
    re.compile(
        r"\b(tutor|instructor|trainer)\s+[-–—,]\s*(html|css|javascript|typescript|python|java|react|sql|aws|azure)\b",
        re.I,
    ),
    re.compile(r"\bcomputer science\s+(teacher|tutor|instructor)\b", re.I),
    re.compile(r"\b(cs|ict)\s+(teacher|tutor)\b", re.I),
]

# Engenheiros claramente fora de TI (fábrica, obras, etc.)
NON_IT_ENGINEERING_TITLE = re.compile(
    r"\b(mechanical|civil|structural|industrial|manufacturing|mining|nuclear|aerospace|biomedical|chemical|"
    r"environmental|geotechnical|petroleum|automotive|mechatronics|process control)\s+engineer\b",
    re.I,
)

# Chip / hardware digital — não são vagas de software (passavam por "engineer" + sector semiconductor)
HARDWARE_CHIP_DESIGN_TITLE = re.compile(
    r"\b(asic|vlsi|verilog|system[\s-]?verilog|rfic|fpga|"
    r"physical\s+design|mask\s+design|mixed[\s-]?signal|"
    r"analog\s+(ic\s+)?(design|engineer)|"
    r"layout\s+engineer|dft\s+engineer)\b",
    re.I,
)


def normalize_text(value):
    return re.sub(r"\s+", " ", (value or "")).strip()


def _signals_full_stack(t: str) -> bool:
    """Match LinkedIn-style titles/descriptions; must run BEFORE Front-End (React etc.)."""
    t = t.lower()
    return (
        "full stack" in t
        or "full-stack" in t
        or "fullstack" in t
        or "full‑stack" in t  # unicode hyphen
    )


def infer_area(title, text):
    t = f"{title} {text}".lower()
    if "security" in t or "cyber" in t:
        return "Cybersecurity"
    # Full-Stack before Front-End: many full-stack JDs mention React/Angular in the body.
    if _signals_full_stack(f"{title} {text}"):
        return "Full-Stack"
    if "data" in t or "ai" in t or "machine learning" in t:
        return "Data"
    if "qa" in t or "quality" in t or "test" in t:
        return "Quality Assurance"
    if "devops" in t or "cloud" in t or "sre" in t:
        return "Cloud"
    if "front-end" in t or "frontend" in t or "react" in t or "angular" in t or "vue" in t:
        return "Front-End"
    return "Back-End"


def _padded_blob(title: str, description: str, max_desc: int = 2000) -> str:
    """Espaços à volta para detetar palavras curtas (react vs reactive)."""
    return f" {normalize_text(title)} {normalize_text(description)[:max_desc]} ".lower()


def matches_front_end_curated_bucket(title: str, description: str) -> bool:
    """Vagas que fazem sentido no ficheiro Front-End curado (auditoria)."""
    if HARDWARE_CHIP_DESIGN_TITLE.search(title or ""):
        return False
    tl = (title or "").lower()
    # Security puro não é Front-End (ficheiro errado / export misturado)
    if "security engineer" in tl and "front" not in tl and "react" not in tl and "ui " not in tl:
        return False
    combo = f"{title} {description[:4500]}".lower()
    if _signals_full_stack(combo):
        return True
    h = _padded_blob(title, description, 4500)
    phrase_hits = (
        "front-end",
        "frontend",
        "front end",
        "next.js",
        "nextjs",
        "react native",
        "typescript",
        "javascript",
        "web developer",
        "ui developer",
        "ux developer",
        "gatsby",
        "ember.js",
        "svelte",
        "nuxt",
        "storybook",
        "tailwind",
        "webpack",
        "graphql",
        "redux",
        "responsive",
        "single-page",
        "single page",
        "flutter",
        "swiftui",
        "swift ui",
        "android developer",
        "ios developer",
        "mobile developer",
    )
    if any(p in h for p in phrase_hits):
        return True
    for tok in (" react ", " angular ", " vue ", " html ", " css ", " sass ", " scss "):
        if tok in h:
            return True
    if ("engineer" in tl or "developer" in tl) and any(
        x in h for x in (" web ", " ui ", " ux ", "client-side", "client side", " browser ", " spa ")
    ):
        return True
    # Export “Front” do LinkedIn muitas vezes inclui full stack / software dev genérico com stack web no corpo
    if (
        "software developer" in tl
        or "software engineer" in tl
        or (" developer" in tl and "software" in tl)
    ) and any(
        x in h
        for x in (
            "javascript",
            "typescript",
            "react",
            "angular",
            " vue",
            "css",
            "html",
            "web ",
            " front",
            " ui ",
            "node",
            "webpack",
            "graphql",
            "full stack",
            "full-stack",
            "fullstack",
            "responsive",
            "web application",
            "component",
            "figma",
        )
    ):
        return True
    if "engineering intern" in tl or " intern" in tl:
        if any(x in h for x in ("software", "computer", "web", "react", "javascript", "developer", "frontend")):
            return True
    return False


def matches_curated_bucket(preset_area: str, title: str, description: str) -> bool:
    """
    Cada JSON do manifest diz a área TI esperada — rejeita linhas que não batem com o título/descrição
    (evita ASIC em Front-End, marketing em Cloud, etc.).
    """
    pa = (preset_area or "").strip()
    if not pa:
        return True
    h = _padded_blob(title, description, 4000)

    if pa == "Front-End":
        return matches_front_end_curated_bucket(title, description)

    if pa == "Back-End":
        if matches_front_end_curated_bucket(title, description):
            return any(
                x in h
                for x in (
                    "back-end",
                    "backend",
                    "back end",
                    "api ",
                    " microservice",
                    "server-side",
                    "server side",
                    " java ",
                    " python ",
                    ".net",
                    "c#",
                    " node",
                    " kotlin",
                    " ruby ",
                    " php ",
                    "spring",
                    "django",
                    "fastapi",
                    "postgresql",
                    "mongodb",
                    "redis",
                    "kafka",
                )
            )
        return True

    if pa == "Full-Stack":
        blob_fs = f"{title} {normalize_text(description)[:4000]}".lower()
        return _signals_full_stack(blob_fs) or (
            ("front" in h or " react " in h or " angular " in h or " vue " in h)
            and ("back" in h or "api" in h or " node" in h or " java " in h or ".net" in h or " python " in h)
        )

    if pa == "Cloud":
        return any(
            x in h
            for x in (
                "cloud",
                "devops",
                "kubernetes",
                "docker",
                "terraform",
                "ansible",
                " aws ",
                " azure",
                " gcp",
                "google cloud",
                "sre",
                "platform engineer",
                "infrastructure",
                "openshift",
                "jenkins",
                "ci/cd",
                "cicd",
                "site reliability",
            )
        )

    if pa == "Data":
        return any(
            x in h
            for x in (
                "data engineer",
                "data scientist",
                "data analyst",
                "machine learning",
                "ml engineer",
                "analytics",
                "etl",
                "dbt",
                "snowflake",
                "databricks",
                "apache spark",
                "power bi",
                "warehouse",
                "business intelligence",
            )
        )

    if pa == "Cybersecurity":
        return any(
            x in h
            for x in (
                "security",
                "cyber",
                "soc ",
                "penetration",
                "infosec",
                "threat",
                "siem",
                "identity",
                "iam ",
                "ciso",
                "governance",
            )
        )

    if pa == "Quality Assurance":
        return any(
            x in h
            for x in (
                "qa ",
                "quality assurance",
                "test engineer",
                "test analyst",
                "sdet",
                "automation engineer",
                "cypress",
                "playwright",
                "selenium",
            )
        )

    return True


def infer_technologies(title, description):
    blob = _padded_blob(title, description, 2400)
    # (needle_with_spaces, label) — espaços reduzem falsos positivos em palavras curtas
    spaced = [
        (" react ", "React"),
        (" react,", "React"),
        ("(react)", "React"),
        (" angular ", "Angular"),
        (" vue ", "Vue"),
        ("next.js", "Next.js"),
        ("nextjs", "Next.js"),
        ("typescript", "TypeScript"),
        ("javascript", "JavaScript"),
        (" node", "Node.js"),
        ("node.js", "Node.js"),
        (".net", ".NET"),
        (" c#", "C#"),
        ("csharp", "C#"),
        (" python ", "Python"),
        (" java ", "Java"),
        (" kotlin", "Kotlin"),
        (" swift ", "Swift"),
        (" golang ", "Go"),
        (" go ", "Go"),
        (" rust ", "Rust"),
        (" ruby ", "Ruby"),
        (" php ", "PHP"),
        (" graphql ", "GraphQL"),
        ("redux", "Redux"),
        ("tailwind", "Tailwind CSS"),
        (" sass ", "Sass"),
        ("webpack", "Webpack"),
        (" sql ", "SQL"),
        ("postgresql", "PostgreSQL"),
        ("postgres", "PostgreSQL"),
        ("mysql", "MySQL"),
        ("mongodb", "MongoDB"),
        ("redis", "Redis"),
        ("kafka", "Kafka"),
        ("snowflake", "Snowflake"),
        ("terraform", "Terraform"),
        ("ansible", "Ansible"),
        ("kubernetes", "Kubernetes"),
        (" docker ", "Docker"),
        ("azure", "Azure"),
        (" aws ", "AWS"),
        (" gcp", "GCP"),
        ("google cloud", "GCP"),
        ("playwright", "Playwright"),
        ("cypress", "Cypress"),
        ("selenium", "Selenium"),
        ("jenkins", "Jenkins"),
        ("figma", "Figma"),
        ("flutter", "Flutter"),
        ("django", "Django"),
        ("fastapi", "FastAPI"),
        ("spring", "Spring"),
    ]
    found: list[str] = []
    for needle, label in spaced:
        if needle in blob:
            if label not in found:
                found.append(label)
    return found[:10] if found else ["General"]


def finalize_technologies(area: str, title: str, description: str) -> list[str]:
    """Garante tags úteis para filtros da UI quando o texto é genérico."""
    base = infer_technologies(title, description)
    if base != ["General"]:
        return base
    h = _padded_blob(title, description, 1200)
    a = (area or "").strip()
    extra: list[str] = []

    if a == "Front-End":
        if " react " in h or "(react)" in h:
            extra.append("React")
        if " angular " in h:
            extra.append("Angular")
        if " vue " in h:
            extra.append("Vue")
        if "typescript" in h:
            extra.append("TypeScript")
        if "next.js" in h or "nextjs" in h:
            extra.append("Next.js")
        if not extra:
            extra = ["JavaScript", "HTML", "CSS"]
    elif a == "Back-End":
        if " java " in h:
            extra.append("Java")
        if " python " in h:
            extra.append("Python")
        if ".net" in h or " c#" in h:
            extra.append(".NET")
        if " node" in h:
            extra.append("Node.js")
        if " sql " in h or "postgresql" in h:
            extra.append("SQL")
        if not extra:
            extra = ["SQL", "General"]
    elif a == "Cloud":
        extra = ["Docker", "Kubernetes", "Azure"]
    elif a == "Data":
        extra = ["Python", "SQL"]
    elif a == "Cybersecurity":
        extra = ["Python", "Azure"]
    elif a == "Quality Assurance":
        extra = ["Playwright", "Cypress"]
    elif a == "Full-Stack":
        extra = ["React", "TypeScript", "Node.js", "SQL"]

    return extra[:10]


def is_blocked_non_it_title(title: str) -> bool:
    if not title:
        return True
    return any(rx.search(title) for rx in NON_IT_TITLE_REGEXES)


def _headline_for_role_check(title: str, description: str, max_chars: int = 900) -> str:
    """Primeiros parágrafos da descrição — não o texto legal completo."""
    d = (description or "")[:max_chars]
    return f"{title}\n{d}"


def _matches_it_role_pattern(headline: str) -> bool:
    if any(rx.search(headline) for rx in IT_ROLE_FRENCH):
        return True
    return any(rx.search(headline) for rx in IT_ROLE_IN_TITLE_OR_HEADLINE)


def is_it_job(title, description, work_type, sector):
    """
    TI de verdade: padrão de cargo no título ou no topo da descrição.
    Não basta a palavra "data"/"test" aparecer no fim do anúncio.
    """
    if is_blocked_non_it_title(title):
        return False
    if NON_IT_ENGINEERING_TITLE.search(title):
        return False
    if HARDWARE_CHIP_DESIGN_TITLE.search(title or ""):
        return False
    tl = (title or "").lower()
    # Synthesis + STA no mesmo título = quase sempre timing físico de chip, não software
    if "synthesis" in tl and "sta" in tl and "software" not in tl and "front" not in tl:
        return False

    headline = _headline_for_role_check(title, description)
    if _matches_it_role_pattern(headline):
        return True

    tl = (title or "").lower()
    wt = (work_type or "").lower()
    sec = (sector or "").lower()

    # Engenheiro/Developer com função LinkedIn claramente tech
    if ("engineer" in tl or "developer" in tl) and not NON_IT_ENGINEERING_TITLE.search(title):
        if any(
            x in wt
            for x in (
                "information technology",
                "engineering",
                "technology",
                "research",
            )
        ) and any(
            x in sec
            for x in (
                "software",
                "it services",
                "computer software",
                "information technology",
                "technology, information",
                "internet",
                "computer networking",
                "telecommunications",
            )
        ):
            return True

    return False


def is_it_job_strict(title, description, work_type, sector):
    """Import curado: mesma base + regras extra para manager/analyst ambíguos."""
    if not is_it_job(title, description, work_type, sector):
        return False
    text = f"{title} {description[:1200]} {work_type} {sector}".lower()
    tl = title.lower()
    if "analyst" in tl and not any(
        x in text for x in ("data", "software", "system", "security", "business intelligence", "bi ", "sql", "python")
    ):
        return False
    if "manager" in tl and not any(
        x in tl for x in ("engineering", "software", "development", "devops", "it ", "technical", "product", "program")
    ):
        if "engineer" not in tl and "developer" not in tl:
            if any(x in tl for x in ("marketing", "sales", "hr ", "human resources", "recruit")):
                return False
    return True


def matches_location_bucket(location: str, bucket: str | None) -> bool:
    """None = NCR genérico (comportamento antigo)."""
    l = (location or "").lower()
    if not bucket:
        return "ottawa" in l or "gatineau" in l or "kanata" in l

    if bucket == "gatineau_metro":
        return any(x in l for x in ("gatineau", "hull", "aylmer", "masson", "buckingham", "chelsea", "cantley"))

    if bucket == "ottawa_metro":
        gat_only = any(x in l for x in ("gatineau", "hull", "aylmer")) and "ottawa" not in l and "kanata" not in l
        if gat_only:
            return False
        return any(
            x in l
            for x in (
                "ottawa",
                "kanata",
                "nepean",
                "orleans",
                "gloucester",
                "barrhaven",
                "stittsville",
                "carp",
                "manotick",
                "rockland",
                "carleton place",
                "arnprior",
                "kemptville",
                "prescott",
                "smiths falls",
                "perth",
            )
        )

    return True


def parse_date(value):
    if not value:
        return None
    v = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(v, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def stable_id(
    source,
    source_id,
    title,
    company,
    url,
    region_suffix: str | None = None,
):
    """
    Com id do LinkedIn/export: li-{id} por defeito.
    Com region_suffix (import curado Ottawa vs Gatineau): li-{id}-{region} para a mesma vaga
    poder existir nos dois mercados sem um sobrescrever o outro na BD.
    Sem id, hash inclui source+url.
    """
    if source_id is not None and str(source_id).strip() != "":
        base = f"li-{source_id}"
        if region_suffix and str(region_suffix).strip():
            rs = str(region_suffix).strip().lower().replace(" ", "-")
            return f"{base}-{rs}"
        return base
    raw = f"{source}|{title}|{company}|{url}".encode("utf-8", errors="ignore")
    return hashlib.sha1(raw).hexdigest()


def load_json_array(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def split_file_arg(arg: str) -> tuple[str, str | None, str | None]:
    """
    Parse CLI file arguments. Use :: so the importer does not guess area from job text.

    Examples (Windows paths are fine; drive letter is a single ':'):
      C:\\data\\OttawaFullstack.json::Full-Stack
      ./exports/Gatineau_Cloud.json::Cloud::gatineau

    Returns: (filesystem_path, preset_area_or_none, region_tag_or_none)
    Region tag is appended to --source for traceability (e.g. LinkedIn-ottawa).
    """
    if "::" not in arg:
        return arg.strip(), None, None
    parts = arg.split("::")
    fs_path = parts[0].strip()
    area = parts[1].strip() if len(parts) > 1 else None
    region = parts[2].strip() if len(parts) > 2 else None
    if not area:
        area = None
    if not region:
        region = None
    return fs_path, area, region


def to_records(
    items,
    source_name,
    preset_area: str | None = None,
    location_bucket: str | None = None,
    strict_it: bool = False,
    id_region: str | None = None,
):
    out = []
    it_fn = is_it_job_strict if strict_it else is_it_job
    for row in items:
        title = normalize_text(row.get("title", ""))
        company = normalize_text(row.get("companyName", "")) or "Unknown company"
        location = normalize_text(row.get("location", "")) or "Ottawa, Ontario, Canada"
        work_type = normalize_text(row.get("workType", ""))
        sector = normalize_text(row.get("sector", ""))
        description = normalize_text(row.get("description", ""))
        url = normalize_text(row.get("jobUrl", "") or row.get("applyUrl", ""))

        if not title or not url:
            continue

        if not matches_location_bucket(location, location_bucket):
            continue

        if not it_fn(title, description, work_type, sector):
            continue

        area_ctx = f"{work_type} {sector} {description[:2400]}"
        pa = (preset_area or "").strip()
        if pa and not matches_curated_bucket(pa, title, description):
            continue

        area_val = pa if pa else infer_area(title, area_ctx)
        record = {
            "id": stable_id(source_name, row.get("id"), title, company, url, region_suffix=id_region),
            "title": title,
            "company": company,
            "location_text": location,
            "source": source_name,
            "url": url,
            "posted_date": parse_date(row.get("publishedAt")),
            "area": area_val,
            "technologies": finalize_technologies(area_val, title, description),
            "latitude": None,
            "longitude": None,
            "geo_precision": "none",
        }
        out.append(record)
    return out


def connect_db():
    return pg8000.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", "5432")),
        database=os.getenv("POSTGRES_DB", "itrack"),
        user=os.getenv("POSTGRES_USER", "postgres"),
        password=os.getenv("POSTGRES_PASSWORD", "postgres"),
    )


def ensure_schema(conn, schema_path):
    with open(schema_path, "r", encoding="utf-8") as f:
        sql = f.read()
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def upsert(conn, records):
    sql = """
    INSERT INTO job_snapshot
    (id, title, company, location_text, source, url, posted_date, area, technologies, latitude, longitude, geo_precision, ingested_at)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
    ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        company = EXCLUDED.company,
        location_text = EXCLUDED.location_text,
        source = EXCLUDED.source,
        url = EXCLUDED.url,
        posted_date = EXCLUDED.posted_date,
        area = EXCLUDED.area,
        technologies = EXCLUDED.technologies,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        geo_precision = EXCLUDED.geo_precision,
        ingested_at = NOW();
    """
    with conn.cursor() as cur:
        for r in records:
            cur.execute(
                sql,
                (
                    r["id"], r["title"], r["company"], r["location_text"], r["source"], r["url"],
                    r["posted_date"], r["area"], r["technologies"], r["latitude"], r["longitude"], r["geo_precision"]
                ),
            )
    conn.commit()


def main():
    parser = argparse.ArgumentParser(
        description="Import LinkedIn-like JSON datasets into job_snapshot. "
        "Prefer path::Area or path::Area::region so area is not inferred from descriptions."
    )
    parser.add_argument(
        "files",
        nargs="+",
        help='JSON paths, optionally path::Area or path::Area::region (e.g. OttawaFullstack.json::Full-Stack::ottawa)',
    )
    parser.add_argument("--source", default="LinkedIn", help="Base source label (per-file region appends as Source-region)")
    parser.add_argument(
        "--preset-area",
        default=None,
        help='Apply this area to every file that does not use path::Area (overrides inference unless --no-infer-area).',
    )
    parser.add_argument(
        "--no-infer-area",
        action="store_true",
        help="Do not infer area from title/description; each file must specify ::Area or use --preset-area.",
    )
    args = parser.parse_args()

    all_records = {}
    for raw_arg in args.files:
        path, file_area, region_tag = split_file_arg(raw_arg)
        preset = (file_area or args.preset_area or "").strip()
        if args.no_infer_area and not preset:
            parser.error(
                f"Area obrigatória para {raw_arg!r}: use caminho::Full-Stack (ou outra área) ou --preset-area."
            )

        source_label = args.source
        if region_tag:
            source_label = f"{args.source}-{region_tag}"

        items = load_json_array(path)
        records = to_records(items, source_label, preset_area=preset if preset else None)
        for r in records:
            all_records[r["id"]] = r
        display = Path(path).name
        mode = "fixed-area" if preset else "infer-area"
        print(f"{display}: parsed={len(items)} kept_it_region={len(records)} ({mode})")

    deduped = list(all_records.values())
    print(f"Total deduplicated kept rows: {len(deduped)}")

    here = Path(__file__).parent
    conn = connect_db()
    try:
        ensure_schema(conn, str(here / "schema.sql"))
        upsert(conn, deduped)
    finally:
        conn.close()
    print("Import completed.")


if __name__ == "__main__":
    main()
