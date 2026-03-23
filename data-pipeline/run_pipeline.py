import hashlib
import os
import re
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Iterable
from urllib.parse import quote_plus
import xml.etree.ElementTree as ET

import pg8000
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

KEYWORDS = [
    "software developer",
    "full stack developer",
    "frontend developer",
    "backend developer",
    "data engineer",
    "data analyst",
    "devops engineer",
    "cloud engineer",
    "cybersecurity analyst",
    "qa engineer",
]
LOCATIONS = ["Ottawa", "Gatineau", "Kanata"]


@dataclass
class JobRecord:
    id: str
    title: str
    company: str
    location_text: str
    source: str
    url: str
    posted_date: str | None
    area: str
    technologies: list[str]
    latitude: float | None = None
    longitude: float | None = None
    geo_precision: str = "none"


def sleep_delay():
    delay = float(os.getenv("SCRAPE_DELAY_SECONDS", "1.2"))
    time.sleep(max(0.1, delay))


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip()


def infer_area(title: str) -> str:
    t = title.lower()
    if "security" in t or "cyber" in t:
        return "Cybersecurity"
    if "full stack" in t or "full-stack" in t or "fullstack" in t:
        return "Full-Stack"
    if "data" in t or "ai" in t or "machine learning" in t:
        return "Data"
    if "qa" in t or "quality" in t or "test" in t:
        return "Quality Assurance"
    if "devops" in t or "cloud" in t or "sre" in t:
        return "Cloud"
    if "front" in t or "react" in t or "angular" in t:
        return "Front-End"
    return "Back-End"


def infer_technologies(title: str) -> list[str]:
    checks = {
        "react": "React",
        "angular": "Angular",
        "vue": "Vue",
        "typescript": "TypeScript",
        "javascript": "JavaScript",
        "node": "Node.js",
        ".net": ".NET",
        "c#": "C#",
        "python": "Python",
        "java": "Java",
        "sql": "SQL",
        "azure": "Azure",
        "aws": "AWS",
        "gcp": "GCP",
        "kubernetes": "Kubernetes",
        "docker": "Docker",
        "terraform": "Terraform",
    }
    lower = title.lower()
    found = [value for key, value in checks.items() if key in lower]
    return found[:6] if found else ["General"]


def make_id(source: str, title: str, company: str, url: str) -> str:
    raw = f"{source}|{title}|{company}|{url}".encode("utf-8", errors="ignore")
    return hashlib.sha1(raw).hexdigest()


def normalize_date(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
    except Exception:
        pass
    try:
        return parsedate_to_datetime(value).date().isoformat()
    except Exception:
        return None


def scrape_indeed_rss(session: requests.Session) -> list[JobRecord]:
    jobs: list[JobRecord] = []
    for keyword in KEYWORDS:
        for location in LOCATIONS:
            url = f"https://ca.indeed.com/rss?q={quote_plus(keyword)}&l={quote_plus(location + ', ON')}"
            response = session.get(url, timeout=int(os.getenv("REQUEST_TIMEOUT_SECONDS", "20")))
            response.raise_for_status()
            root = ET.fromstring(response.text)
            for item in root.findall(".//item"):
                title = normalize_text(item.findtext("title", default=""))
                link = normalize_text(item.findtext("link", default=""))
                description = item.findtext("description", default="")
                company_match = re.search(r"Company:\s*</b>\s*([^<]+)", description, flags=re.IGNORECASE)
                place_match = re.search(r"Location:\s*</b>\s*([^<]+)", description, flags=re.IGNORECASE)
                company = normalize_text(company_match.group(1) if company_match else "Unknown company")
                location_text = normalize_text(place_match.group(1) if place_match else location)
                if "ottawa" not in location_text.lower() and "gatineau" not in location_text.lower() and "kanata" not in location_text.lower():
                    continue
                jobs.append(
                    JobRecord(
                        id=make_id("Indeed", title, company, link),
                        title=title,
                        company=company,
                        location_text=location_text,
                        source="Indeed",
                        url=link,
                        posted_date=normalize_date(item.findtext("pubDate")),
                        area=infer_area(title),
                        technologies=infer_technologies(title),
                    )
                )
            sleep_delay()
    return jobs


def scrape_jobbank(session: requests.Session) -> list[JobRecord]:
    jobs: list[JobRecord] = []
    base = "https://www.jobbank.gc.ca/jobsearch/jobsearch"
    for keyword in KEYWORDS:
        params = {"searchstring": keyword, "locationstring": "Ottawa", "sort": "D"}
        response = session.get(base, params=params, timeout=int(os.getenv("REQUEST_TIMEOUT_SECONDS", "20")))
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        cards = soup.select("article.resultJobItem, article.nocturnal-job")
        for card in cards:
            title_el = card.select_one("h3 a, .resultJobItem-title a")
            if not title_el:
                continue
            title = normalize_text(title_el.get_text(" ", strip=True))
            link = title_el.get("href", "")
            if link.startswith("/"):
                link = f"https://www.jobbank.gc.ca{link}"
            company_el = card.select_one(".business, .resultJobItem-company")
            location_el = card.select_one(".location, .resultJobItem-location")
            company = normalize_text(company_el.get_text(" ", strip=True) if company_el else "Unknown company")
            location_text = normalize_text(location_el.get_text(" ", strip=True) if location_el else "Ottawa")
            lower_loc = location_text.lower()
            if "ottawa" not in lower_loc and "gatineau" not in lower_loc and "kanata" not in lower_loc:
                continue
            jobs.append(
                JobRecord(
                    id=make_id("JobBank", title, company, link),
                    title=title,
                    company=company,
                    location_text=location_text,
                    source="Job Bank",
                    url=link,
                    posted_date=None,
                    area=infer_area(title),
                    technologies=infer_technologies(title),
                )
            )
        sleep_delay()
    return jobs


def scrape_linkedin(session: requests.Session) -> list[JobRecord]:
    jobs: list[JobRecord] = []
    base = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
    for keyword in KEYWORDS:
        for location in LOCATIONS:
            params = {
                "keywords": keyword,
                "location": f"{location}, Ontario, Canada",
                "start": 0,
            }
            response = session.get(base, params=params, timeout=int(os.getenv("REQUEST_TIMEOUT_SECONDS", "20")))
            if response.status_code >= 400:
                continue
            soup = BeautifulSoup(response.text, "html.parser")
            cards = soup.select("li")
            for card in cards:
                title_el = card.select_one(".base-search-card__title")
                company_el = card.select_one(".base-search-card__subtitle")
                location_el = card.select_one(".job-search-card__location")
                link_el = card.select_one("a.base-card__full-link")
                if not title_el or not link_el:
                    continue
                title = normalize_text(title_el.get_text(" ", strip=True))
                company = normalize_text(company_el.get_text(" ", strip=True) if company_el else "Unknown company")
                location_text = normalize_text(location_el.get_text(" ", strip=True) if location_el else location)
                lower_loc = location_text.lower()
                if "ottawa" not in lower_loc and "gatineau" not in lower_loc and "kanata" not in lower_loc:
                    continue
                link = normalize_text(link_el.get("href", ""))
                jobs.append(
                    JobRecord(
                        id=make_id("LinkedIn", title, company, link),
                        title=title,
                        company=company,
                        location_text=location_text,
                        source="LinkedIn",
                        url=link,
                        posted_date=None,
                        area=infer_area(title),
                        technologies=infer_technologies(title),
                    )
                )
            sleep_delay()
    return jobs


def dedupe(records: Iterable[JobRecord]) -> list[JobRecord]:
    unique: dict[str, JobRecord] = {}
    for record in records:
        unique[record.id] = record
    return list(unique.values())


def write_snapshot(records: list[JobRecord]) -> None:
    out_dir = os.path.join(os.path.dirname(__file__), "output")
    os.makedirs(out_dir, exist_ok=True)
    snapshot_name = f"jobs_snapshot_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.jsonl"
    output_path = os.path.join(out_dir, snapshot_name)
    with open(output_path, "w", encoding="utf-8") as file:
        for item in records:
            file.write(f"{asdict(item)}\n")
    print(f"Snapshot saved: {output_path}")


def connect_db():
    return pg8000.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", "5432")),
        database=os.getenv("POSTGRES_DB", "itrack"),
        user=os.getenv("POSTGRES_USER", "postgres"),
        password=os.getenv("POSTGRES_PASSWORD", "postgres"),
    )


def create_table_if_needed(conn):
    sql_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    with open(sql_path, "r", encoding="utf-8") as file:
        sql = file.read()
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def upsert_records(conn, records: list[JobRecord]):
    query = """
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
                query,
                (
                    r.id,
                    r.title,
                    r.company,
                    r.location_text,
                    r.source,
                    r.url,
                    r.posted_date,
                    r.area,
                    r.technologies,
                    r.latitude,
                    r.longitude,
                    r.geo_precision,
                ),
            )
    conn.commit()


def main():
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        }
    )

    print("Collecting Indeed...")
    indeed = scrape_indeed_rss(session)
    print(f"Indeed: {len(indeed)}")

    print("Collecting Job Bank...")
    jobbank = scrape_jobbank(session)
    print(f"Job Bank: {len(jobbank)}")

    print("Collecting LinkedIn...")
    linkedin = scrape_linkedin(session)
    print(f"LinkedIn: {len(linkedin)}")

    records = dedupe([*indeed, *jobbank, *linkedin])
    print(f"Total deduplicated: {len(records)}")
    write_snapshot(records)

    conn = connect_db()
    try:
        create_table_if_needed(conn)
        upsert_records(conn, records)
        print(f"Upsert completed: {len(records)}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
