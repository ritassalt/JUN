import json
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "dzhun.db"
BACKUP_DIR = BASE_DIR / "backups"
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
BACKUP_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)
TEMPLATES_DIR.mkdir(exist_ok=True)
MAX_BACKUPS = 3

VALID_STAGES = {"f2", "f3", "chilling", "stored", "consumed", "discarded"}
VALID_MATERIALS = {"glass", "pet", "other"}
VALID_UNITS = {"g", "ml", "pcs"}
JAR_CAPACITY_ML = 2300


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS honeytee (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            title TEXT,
            tea_type TEXT,
            tea_g REAL,
            tea_temp REAL,
            tea_steep_min REAL,
            honey_type TEXT,
            honey_g REAL,
            mead_ml REAL,
            density REAL
        );
        CREATE TABLE IF NOT EXISTS jar (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            honeytee_id INTEGER REFERENCES honeytee(id),
            created_at TEXT NOT NULL,
            title TEXT,
            starter_ml REAL,
            ph REAL,
            final_ph REAL,
            rho_final REAL,
            abv REAL,
            f1_start TEXT,
            f1_end TEXT,
            state TEXT NOT NULL DEFAULT 'f1',
            next_cycle_started INTEGER DEFAULT 0,
            f2_force_ready INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS bottles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            jar_id INTEGER REFERENCES jar(id),
            created_at TEXT NOT NULL,
            title TEXT,
            volume_ml REAL,
            material TEXT,
            filled_ml REAL,
            density REAL,
            abv REAL,
            stage TEXT NOT NULL DEFAULT 'f2',
            notes TEXT,
            has_additives INTEGER DEFAULT 0,
            additives TEXT,
            f2_start TEXT,
            f2_end TEXT,
            pet_state TEXT DEFAULT 'unknown',
            pet_last_check TEXT,
            pet_bottle_id INTEGER,
            carbonation INTEGER,
            sediment INTEGER,
            sediment_note TEXT,
            chill_start TEXT,
            chill_end TEXT
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id INTEGER NOT NULL,
            stage TEXT,
            event_type TEXT NOT NULL,
            payload TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS counters (
            name TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            text TEXT NOT NULL
        );
        """)


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


def log_event(conn, entity_type, entity_id, stage, event_type, payload=None):
    conn.execute(
        "INSERT INTO events(entity_type, entity_id, stage, event_type, payload, created_at) VALUES (?,?,?,?,?,?)",
        (entity_type, entity_id, stage, event_type, json.dumps(payload or {}, ensure_ascii=False), now_iso()),
    )


def make_honeytee_title(created_at_iso, tea_type, honey_type):
    try:
        dt = datetime.fromisoformat(created_at_iso)
        date_part = dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        date_part = created_at_iso
    parts = [date_part]
    if tea_type: parts.append(str(tea_type).strip())
    if honey_type: parts.append(str(honey_type).strip())
    return " · ".join(parts)


def make_jar_title(conn, jar_id, honeytee_id):
    h = conn.execute("SELECT tea_type, honey_type FROM honeytee WHERE id=?", (honeytee_id,)).fetchone()
    tea = h["tea_type"] if h else ""
    honey = h["honey_type"] if h else ""
    parts = [f"#{jar_id}"]
    if tea: parts.append(str(tea).strip())
    if honey: parts.append(str(honey).strip())
    return " · ".join(parts)


# ---------- ABV ----------
def brix_to_sg(brix: float) -> float:
    return (brix / (258.6 - (brix / 258.2) * 227.1)) + 1.0


def calc_abv(rho_start_brix, rho_final_brix):
    if rho_start_brix is None or rho_final_brix is None:
        return None
    try:
        og = brix_to_sg(float(rho_start_brix))
        fg = brix_to_sg(float(rho_final_brix))
    except Exception:
        return None
    if og <= fg:
        return 0.0
    abv = (76.08 * (og - fg) / (1.775 - og)) * (fg / 0.794)
    return round(max(0.0, abv), 1)


# ---------- Backup ----------

def dump_all():
    with db() as conn:
        return {t: [row_to_dict(r) for r in conn.execute(f"SELECT * FROM {t}").fetchall()]
                for t in ("honeytee", "jar", "bottles", "events", "counters", "notes")}


def make_backup():
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    path = BACKUP_DIR / f"backup_{ts}.json"
    path.write_text(json.dumps(dump_all(), ensure_ascii=False, indent=2), encoding="utf-8")
    backups = sorted(BACKUP_DIR.glob("backup_*.json"))
    while len(backups) > MAX_BACKUPS:
        backups[0].unlink()
        backups = sorted(BACKUP_DIR.glob("backup_*.json"))
    return path


def restore_from(data):
    with db() as conn:
        for t in ("events", "bottles", "jar", "honeytee", "counters", "notes"):
            conn.execute(f"DELETE FROM {t}")
        for t in ("honeytee", "jar", "bottles", "events", "counters", "notes"):
            for row in data.get(t, []):
                cols = ",".join(row.keys())
                qs = ",".join("?" * len(row))
                conn.execute(f"INSERT INTO {t}({cols}) VALUES({qs})", list(row.values()))


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(lifespan=lifespan, title="Dzhun Journal")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------- Pydantic ----------

class HoneyteeIn(BaseModel):
    tea_type: Optional[str] = None
    tea_g: Optional[float] = None
    tea_temp: Optional[float] = None
    tea_steep_min: Optional[float] = None
    honey_type: Optional[str] = None
    honey_g: Optional[float] = None
    mead_ml: Optional[float] = None
    density: Optional[float] = None


class JarIn(BaseModel):
    honeytee_id: int
    starter_ml: Optional[float] = None
    ph: Optional[float] = None
    from_jar_id: Optional[int] = None


class JarFinishF1In(BaseModel):
    final_ph: float
    rho_final: Optional[float] = None
    bottles: list[dict]


class AdditiveIn(BaseModel):
    name: str
    amount: float
    unit: str
    note: Optional[str] = None


class BottleIn(BaseModel):
    volume_ml: Optional[float] = None
    filled_ml: Optional[float] = None
    density: Optional[float] = None
    notes: Optional[str] = None


class EventIn(BaseModel):
    entity_type: str
    entity_id: int
    stage: Optional[str] = None
    event_type: str
    payload: Optional[dict[str, Any]] = None


class EventPatch(BaseModel):
    payload: Optional[dict[str, Any]] = None
    event_type: Optional[str] = None


class PetCheckIn(BaseModel):
    bubbled: bool


class JarFinishF2In(BaseModel):
    carbonation: int
    sediment: bool
    sediment_note: Optional[str] = None


class NoteIn(BaseModel):
    text: str


class NotePatch(BaseModel):
    text: str


# ---------- helpers ----------

def bottle_to_dict(b):
    d = row_to_dict(b)
    if d.get("additives"):
        try:
            d["additives"] = json.loads(d["additives"])
        except Exception:
            d["additives"] = []
    else:
        d["additives"] = []
    d["has_additives"] = bool(d.get("has_additives"))
    if d.get("chill_start"):
        try:
            cs = datetime.fromisoformat(d["chill_start"])
            ce = datetime.fromisoformat(d["chill_end"]) if d.get("chill_end") else datetime.now()
            d["chill_hours"] = round((ce - cs).total_seconds() / 3600, 1)
        except Exception:
            d["chill_hours"] = None
    else:
        d["chill_hours"] = None
    return d


def compute_jar_reminder(j):
    state = j.get("state")
    if state == "f1" and j.get("created_at"):
        try:
            created = datetime.fromisoformat(j["created_at"])
        except Exception:
            return None
        days = (datetime.now() - created).days
        if days == 0: return "Проверь через 3 дня значение pH (~3.5)"
        if days == 1: return "Проверь через 2 дня значение pH (~3.5)"
        if days == 2: return "Проверь через 1 день значение pH (~3.5)"
        return "Пора проверить pH (~3.5)"
    return None


def enrich_jar(j, conn):
    d = dict(j)
    d["reminder"] = compute_jar_reminder(d)
    h = conn.execute("SELECT * FROM honeytee WHERE id=?", (j["honeytee_id"],)).fetchone()
    d["honeytee"] = row_to_dict(h) if h else None
    d["rho_start"] = (h["density"] if h else None)
    bottles = conn.execute("SELECT * FROM bottles WHERE jar_id=? ORDER BY id ASC", (j["id"],)).fetchall()
    d["bottles"] = [bottle_to_dict(b) for b in bottles]
    mead_ml = (h["mead_ml"] or 0) if h else 0
    starter_ml = j["starter_ml"] or 0
    total_in = mead_ml + starter_ml
    total_filled = sum((b["filled_ml"] or 0) for b in bottles)
    d["total_in_ml"] = round(total_in, 1)
    d["total_filled_ml"] = round(total_filled, 1)
    d["leftover_ml"] = round(total_in - total_filled, 1)
    return d


# ---------- honeytee ----------

@app.get("/api/honeytee")
def list_honeytee():
    with db() as conn:
        rows = conn.execute("SELECT * FROM honeytee ORDER BY id DESC").fetchall()
        result = []
        for r in rows:
            d = row_to_dict(r)
            used = conn.execute("SELECT COUNT(*) c FROM jar WHERE honeytee_id=?", (r["id"],)).fetchone()["c"]
            d["is_draft"] = is_draft(d)
            d["used"] = used > 0
            result.append(d)
        return result


@app.get("/api/honeytee/{hid}")
def get_honeytee(hid: int):
    with db() as conn:
        r = conn.execute("SELECT * FROM honeytee WHERE id=?", (hid,)).fetchone()
        if not r:
            raise HTTPException(404, "honeytee not found")
        d = row_to_dict(r)
        used = conn.execute("SELECT COUNT(*) c FROM jar WHERE honeytee_id=?", (hid,)).fetchone()["c"]
        d["is_draft"] = is_draft(d)
        d["used"] = used > 0
        return d


@app.post("/api/honeytee")
def create_honeytee(payload: HoneyteeIn):
    created = now_iso()
    title = make_honeytee_title(created, payload.tea_type, payload.honey_type)
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO honeytee
               (created_at, title, tea_type, tea_g, tea_temp, tea_steep_min,
                honey_type, honey_g, mead_ml, density)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (created, title, payload.tea_type, payload.tea_g, payload.tea_temp,
             payload.tea_steep_min,
             payload.honey_type, payload.honey_g, payload.mead_ml, payload.density),
        )
        hid = cur.lastrowid
        log_event(conn, "honeytee", hid, None, "created", payload.model_dump())
        return row_to_dict(conn.execute("SELECT * FROM honeytee WHERE id=?", (hid,)).fetchone())


@app.patch("/api/honeytee/{hid}")
def patch_honeytee(hid: int, payload: HoneyteeIn):
    with db() as conn:
        row = conn.execute("SELECT * FROM honeytee WHERE id=?", (hid,)).fetchone()
        if not row:
            raise HTTPException(404, "honeytee not found")
        used = conn.execute("SELECT COUNT(*) c FROM jar WHERE honeytee_id=?", (hid,)).fetchone()["c"]
        if used:
            raise HTTPException(409, "Нельзя редактировать медочай: по нему уже создана база")

        # ВСЕ поля медочая могут быть обнулены — берём их из payload как есть
        upd = {}
        for k, v in payload.model_dump().items():
            upd[k] = v  # даже None

        # title пересчитываем
        tea = upd.get("tea_type") or row["tea_type"] or ""
        honey = upd.get("honey_type") or row["honey_type"] or ""
        upd["title"] = make_honeytee_title(row["created_at"], tea, honey)

        sets = ", ".join(f"{k}=?" for k in upd)
        conn.execute(f"UPDATE honeytee SET {sets} WHERE id=?", (*upd.values(), hid))
        log_event(conn, "honeytee", hid, None, "edited", upd)
        return row_to_dict(conn.execute("SELECT * FROM honeytee WHERE id=?", (hid,)).fetchone())


def is_draft(h):
    required = ("tea_type", "tea_g", "tea_temp", "tea_steep_min",
                "honey_type", "honey_g", "mead_ml")
    for f in required:
        v = h.get(f)
        if v is None or (isinstance(v, str) and not v.strip()):
            return True
    return False


@app.delete("/api/honeytee/{hid}")
def delete_honeytee(hid: int):
    with db() as conn:
        if not conn.execute("SELECT id FROM honeytee WHERE id=?", (hid,)).fetchone():
            raise HTTPException(404, "honeytee not found")
        deps = conn.execute("SELECT COUNT(*) c FROM jar WHERE honeytee_id=?", (hid,)).fetchone()["c"]
        if deps:
            raise HTTPException(409, f"Нельзя удалить: привязано баз: {deps}")
        conn.execute("DELETE FROM events WHERE entity_type='honeytee' AND entity_id=?", (hid,))
        conn.execute("DELETE FROM honeytee WHERE id=?", (hid,))
        return {"ok": True}


# ---------- jar ----------

@app.get("/api/jars")
def list_jars():
    with db() as conn:
        rows = conn.execute("SELECT * FROM jar ORDER BY id DESC").fetchall()
        return [enrich_jar(row_to_dict(r), conn) for r in rows]


@app.get("/api/jars/{jid}")
def get_jar(jid: int):
    with db() as conn:
        r = conn.execute("SELECT * FROM jar WHERE id=?", (jid,)).fetchone()
        if not r:
            raise HTTPException(404, "jar not found")
        d = enrich_jar(row_to_dict(r), conn)
        events = conn.execute(
            "SELECT * FROM events WHERE entity_type='jar' AND entity_id=? ORDER BY id DESC",
            (jid,)).fetchall()
        d["events"] = [row_to_dict(e) for e in events]
        return d


@app.post("/api/jars")
def create_jar(payload: JarIn):
    if not payload.starter_ml or not payload.ph:
        raise HTTPException(400, "Обязательные поля: starter_ml, ph")
    with db() as conn:
        h = conn.execute("SELECT * FROM honeytee WHERE id=?", (payload.honeytee_id,)).fetchone()
        if not h:
            raise HTTPException(400, "honeytee not found")
        if is_draft(row_to_dict(h)):
            raise HTTPException(409, "Нельзя создать базу из черновика медочая")
        used = conn.execute("SELECT COUNT(*) c FROM jar WHERE honeytee_id=?", (payload.honeytee_id,)).fetchone()["c"]
        if used:
            raise HTTPException(409, "Этот медочай уже использован для другой базы")
        created = now_iso()
        cur = conn.execute(
            """INSERT INTO jar
               (honeytee_id, created_at, title, starter_ml, ph, f1_start, state)
               VALUES (?,?,?,?,?,?,?)""",
            (payload.honeytee_id, created, "", payload.starter_ml, payload.ph, created, "f1"),
        )
        jid = cur.lastrowid
        title = make_jar_title(conn, jid, payload.honeytee_id)
        conn.execute("UPDATE jar SET title=? WHERE id=?", (title, jid))
        log_event(conn, "jar", jid, "f1", "created", payload.model_dump())

        # помечаем родительскую базу как «из неё запущен цикл»
        if payload.from_jar_id:
            parent = conn.execute("SELECT * FROM jar WHERE id=?", (payload.from_jar_id,)).fetchone()
            if parent:
                conn.execute("UPDATE jar SET next_cycle_started=1 WHERE id=?", (payload.from_jar_id,))
                log_event(conn, "jar", payload.from_jar_id, parent["state"], "new_cycle_started", {
                    "new_jar_id": jid,
                })

        return enrich_jar(row_to_dict(conn.execute("SELECT * FROM jar WHERE id=?", (jid,)).fetchone()), conn)


@app.delete("/api/jars/{jid}")
def delete_jar(jid: int):
    with db() as conn:
        if not conn.execute("SELECT id FROM jar WHERE id=?", (jid,)).fetchone():
            raise HTTPException(404, "jar not found")
        deps = conn.execute("SELECT COUNT(*) c FROM bottles WHERE jar_id=?", (jid,)).fetchone()["c"]
        if deps:
            raise HTTPException(409, f"Нельзя удалить: привязано бутылок: {deps}")
        conn.execute("DELETE FROM events WHERE entity_type='jar' AND entity_id=?", (jid,))
        conn.execute("DELETE FROM jar WHERE id=?", (jid,))
        return {"ok": True}


@app.post("/api/jars/{jid}/finish_f1")
def finish_f1(jid: int, payload: JarFinishF1In):
    if payload.final_ph is None:
        raise HTTPException(400, "final_ph обязательно")
    if not payload.bottles:
        raise HTTPException(400, "нужна хотя бы одна бутылка")
    with db() as conn:
        row = conn.execute("SELECT * FROM jar WHERE id=?", (jid,)).fetchone()
        if not row:
            raise HTTPException(404, "jar not found")
        if row["state"] != "f1":
            raise HTTPException(400, "база не в состоянии F1")
        h = conn.execute("SELECT mead_ml, density FROM honeytee WHERE id=?", (row["honeytee_id"],)).fetchone()
        mead_ml = (h["mead_ml"] or 0) if h else 0
        rho_start = (h["density"] if h else None)
        starter_ml = row["starter_ml"] or 0
        total_in = mead_ml + starter_ml
        total_filled = sum((b.get("filled_ml") or 0) for b in payload.bottles)
        if total_filled > total_in:
            raise HTTPException(400, f"Разлито {total_filled} мл больше, чем есть в базе ({total_in} мл)")

        abv = calc_abv(rho_start, payload.rho_final)

        now = now_iso()
        conn.execute(
            "UPDATE jar SET state='bottled', f1_end=?, final_ph=?, rho_final=?, abv=? WHERE id=?",
            (now, payload.final_ph, payload.rho_final, abv, jid),
        )
        log_event(conn, "jar", jid, "f1", "f1_finished",
                  {"final_ph": payload.final_ph, "rho_final": payload.rho_final, "abv": abv})

        # 1) создаём все бутылки без pet_bottle_id
        created_ids = []
        for idx, b in enumerate(payload.bottles, start=1):
            title = f"#{jid}.{idx}"
            cur = conn.execute(
                """INSERT INTO bottles
                   (jar_id, created_at, title, volume_ml, material, filled_ml, density,
                    stage, notes, has_additives, additives, f2_start, abv)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (jid, now, title, b.get("volume_ml"), b.get("material"),
                 b.get("filled_ml"), None, "f2", None,
                 0, "[]", now, abv),
            )
            bid = cur.lastrowid
            created_ids.append((bid, b.get("material")))
            log_event(conn, "bottle", bid, "f2", "bottled", {
                "volume_ml": b.get("volume_ml"),
                "material": b.get("material"),
                "filled_ml": b.get("filled_ml"),
            })
            # добавки
            for a in (b.get("additives") or []):
                conn.execute(
                    "UPDATE bottles SET additives=?, has_additives=1 WHERE id=?",
                    (json.dumps([a], ensure_ascii=False), bid),
                )
                log_event(conn, "bottle", bid, "f2", "additive_added", a)

        # 2) находим ПЭТ и проставляем ссылки
        pet_id = None
        for bid, mat in created_ids:
            if mat == "pet":
                pet_id = bid
                break
        if pet_id is not None:
            for bid, _ in created_ids:
                conn.execute("UPDATE bottles SET pet_bottle_id=? WHERE id=?", (pet_id, bid))

        # 3) событие розлива в базу
        log_event(conn, "jar", jid, "bottled", "bottled", {
            "bottles_count": len(created_ids),
            "total_filled_ml": total_filled,
            "rho_final": payload.rho_final,
        })
        return enrich_jar(row_to_dict(conn.execute("SELECT * FROM jar WHERE id=?", (jid,)).fetchone()), conn)


@app.post("/api/jars/{jid}/new_cycle")
def new_cycle_hint(jid: int):
    with db() as conn:
        j = conn.execute("SELECT * FROM jar WHERE id=?", (jid,)).fetchone()
        if not j:
            raise HTTPException(404, "jar not found")
        available = conn.execute("""
            SELECT h.* FROM honeytee h
            WHERE NOT EXISTS (SELECT 1 FROM jar j WHERE j.honeytee_id = h.id)
            ORDER BY h.id DESC
        """).fetchall()
        return {"available_honeytee": [row_to_dict(r) for r in available]}


@app.post("/api/jars/{jid}/force_f2_ready")
def force_f2_ready(jid: int):
    with db() as conn:
        j = conn.execute("SELECT * FROM jar WHERE id=?", (jid,)).fetchone()
        if not j:
            raise HTTPException(404, "jar not found")
        conn.execute("UPDATE jar SET f2_force_ready=1 WHERE id=?", (jid,))
        log_event(conn, "jar", jid, j["state"], "f2_force_ready")
        return {"ok": True}


# ---------- notes ----------

@app.get("/api/notes")
def list_notes():
    with db() as conn:
        rows = conn.execute("SELECT * FROM notes ORDER BY id DESC").fetchall()
        return [row_to_dict(r) for r in rows]


@app.post("/api/notes")
def create_note(payload: NoteIn):
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "Текст не может быть пустым")
    if len(text) > 10000:
        raise HTTPException(400, "Текст слишком длинный (максимум 10 000 символов)")
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO notes(created_at, text) VALUES (?, ?)",
            (now_iso(), text),
        )
        return row_to_dict(conn.execute("SELECT * FROM notes WHERE id=?", (cur.lastrowid,)).fetchone())


@app.patch("/api/notes/{nid}")
def patch_note(nid: int, payload: NotePatch):
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "Текст не может быть пустым")
    if len(text) > 10000:
        raise HTTPException(400, "Текст слишком длинный (максимум 10 000 символов)")
    with db() as conn:
        if not conn.execute("SELECT id FROM notes WHERE id=?", (nid,)).fetchone():
            raise HTTPException(404, "note not found")
        conn.execute("UPDATE notes SET text=? WHERE id=?", (text, nid))
        return row_to_dict(conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone())


@app.delete("/api/notes/{nid}")
def delete_note(nid: int):
    with db() as conn:
        if not conn.execute("SELECT id FROM notes WHERE id=?", (nid,)).fetchone():
            raise HTTPException(404, "note not found")
        conn.execute("DELETE FROM notes WHERE id=?", (nid,))
        return {"ok": True}


# ---------- bottles ----------

@app.get("/api/bottles")
def list_bottles():
    with db() as conn:
        rows = conn.execute("""
            SELECT b.*, j.title AS jar_title, j.honeytee_id
            FROM bottles b
            LEFT JOIN jar j ON j.id = b.jar_id
            ORDER BY b.id DESC
        """).fetchall()
        return [bottle_to_dict(r) for r in rows]


@app.get("/api/bottles/{bid}")
def get_bottle(bid: int):
    with db() as conn:
        b = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not b:
            raise HTTPException(404, "bottle not found")
        d = bottle_to_dict(b)
        events = conn.execute(
            "SELECT * FROM events WHERE entity_type='bottle' AND entity_id=? ORDER BY id DESC",
            (bid,)).fetchall()
        d["events"] = [row_to_dict(e) for e in events]
        j = conn.execute("SELECT * FROM jar WHERE id=?", (b["jar_id"],)).fetchone()
        d["jar"] = row_to_dict(j) if j else None
        if b["pet_bottle_id"]:
            pet = conn.execute("SELECT * FROM bottles WHERE id=?", (b["pet_bottle_id"],)).fetchone()
            d["pet_bottle"] = bottle_to_dict(pet) if pet else None
        else:
            d["pet_bottle"] = None
        return d


@app.patch("/api/bottles/{bid}")
def patch_bottle(bid: int, payload: BottleIn):
    with db() as conn:
        row = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not row:
            raise HTTPException(404, "bottle not found")
        if row["stage"] in ("consumed", "discarded"):
            raise HTTPException(409, "Нельзя редактировать выпитую или выброшенную бутылку")
        if row["stage"] != "f2" and not row["has_additives"]:
            raise HTTPException(409, "Нельзя редактировать бутылку без добавок после F2")
        upd = {}
        for k in ("filled_ml", "notes"):
            v = getattr(payload, k)
            if v is not None: upd[k] = v
        if not upd:
            raise HTTPException(400, "no fields to update")
        sets = ", ".join(f"{k}=?" for k in upd)
        conn.execute(f"UPDATE bottles SET {sets} WHERE id=?", (*upd.values(), bid))
        log_event(conn, "bottle", bid, row["stage"], "edited", upd)
        return bottle_to_dict(conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone())


@app.delete("/api/bottles/{bid}")
def delete_bottle(bid: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not row:
            raise HTTPException(404, "bottle not found")
        if row["material"] == "pet":
            sisters = conn.execute(
                "SELECT COUNT(*) c FROM bottles WHERE jar_id=? AND id!=?",
                (row["jar_id"], bid)).fetchone()["c"]
            if sisters:
                raise HTTPException(409, f"Нельзя удалить ПЭТ: в партии ещё {sisters} бутылок")
        conn.execute("DELETE FROM events WHERE entity_type='bottle' AND entity_id=?", (bid,))
        conn.execute("DELETE FROM bottles WHERE id=?", (bid,))
        return {"ok": True}


@app.patch("/api/bottles/{bid}/additives/{idx}")
def update_additive(bid: int, idx: int, payload: AdditiveIn):
    if payload.unit not in VALID_UNITS:
        raise HTTPException(400, f"unit must be one of {VALID_UNITS}")
    with db() as conn:
        row = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not row:
            raise HTTPException(404, "bottle not found")
        if row["stage"] in ("consumed", "discarded"):
            raise HTTPException(409, "Нельзя редактировать добавки выпитой или выброшенной бутылки")
        if row["stage"] != "f2" and not row["has_additives"]:
            raise HTTPException(409, "Нельзя менять добавки в бутылке без добавок после F2")
        current = json.loads(row["additives"]) if row["additives"] else []
        if idx < 0 or idx >= len(current):
            raise HTTPException(400, "invalid index")
        old = current[idx]
        current[idx] = {
            "name": payload.name,
            "amount": payload.amount,
            "unit": payload.unit,
            "note": payload.note,
        }
        conn.execute("UPDATE bottles SET additives=? WHERE id=?",
                     (json.dumps(current, ensure_ascii=False), bid))
        log_event(conn, "bottle", bid, row["stage"], "additive_edited", {
            "old": old,
            "new": current[idx],
        })
        return bottle_to_dict(conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone())


@app.post("/api/bottles/{bid}/additives")
def add_additive(bid: int, payload: AdditiveIn):
    if payload.unit not in VALID_UNITS:
        raise HTTPException(400, f"unit must be one of {VALID_UNITS}")
    with db() as conn:
        row = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not row:
            raise HTTPException(404, "bottle not found")
        if row["stage"] != "f2" and not row["has_additives"]:
            raise HTTPException(409, "Нельзя добавлять добавки в бутылку без добавок после F2")
        current = json.loads(row["additives"]) if row["additives"] else []
        item = {"name": payload.name, "amount": payload.amount, "unit": payload.unit, "note": payload.note}
        current.append(item)
        conn.execute("UPDATE bottles SET additives=?, has_additives=1 WHERE id=?",
                     (json.dumps(current, ensure_ascii=False), bid))
        log_event(conn, "bottle", bid, row["stage"], "additive_added", item)
        return bottle_to_dict(conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone())


@app.delete("/api/bottles/{bid}/additives/{idx}")
def remove_additive(bid: int, idx: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not row:
            raise HTTPException(404, "bottle not found")
        if row["stage"] != "f2" and not row["has_additives"]:
            raise HTTPException(409, "Нельзя менять добавки в бутылке без добавок после F2")
        current = json.loads(row["additives"]) if row["additives"] else []
        if idx < 0 or idx >= len(current):
            raise HTTPException(400, "invalid index")
        removed = current.pop(idx)
        has = 1 if current else 0
        conn.execute("UPDATE bottles SET additives=?, has_additives=? WHERE id=?",
                     (json.dumps(current, ensure_ascii=False), has, bid))
        log_event(conn, "bottle", bid, row["stage"], "additive_removed", removed)
        return bottle_to_dict(conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone())


@app.post("/api/bottles/{bid}/pet_check")
def bottle_pet_check(bid: int, payload: PetCheckIn):
    with db() as conn:
        b = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not b:
            raise HTTPException(404, "bottle not found")
        if b["material"] != "pet":
            raise HTTPException(400, "это не контрольная бутылка")
        state = "bubbled" if payload.bubbled else "not_bubbled"
        conn.execute(
            "UPDATE bottles SET pet_state=?, pet_last_check=? WHERE id=?",
            (state, now_iso(), bid),
        )
        log_event(conn, "bottle", bid, "f2", "pet_check", {"bubbled": payload.bubbled})
        return {"ok": True, "pet_state": state}


@app.get("/api/jars/{jid}/pet_status")
def jar_pet_status(jid: int):
    with db() as conn:
        pet = conn.execute(
            "SELECT * FROM bottles WHERE jar_id=? AND material='pet' LIMIT 1",
            (jid,)).fetchone()
        if not pet:
            return {"has_pet": False}
        return {
            "has_pet": True,
            "bottle_id": pet["id"],
            "pet_state": pet["pet_state"] or "unknown",
            "pet_last_check": pet["pet_last_check"],
        }


@app.post("/api/jars/{jid}/finish_f2")
def finish_f2(jid: int, payload: JarFinishF2In):
    if payload.carbonation < 1 or payload.carbonation > 5:
        raise HTTPException(400, "carbonation must be 1..5")
    with db() as conn:
        j = conn.execute("SELECT * FROM jar WHERE id=?", (jid,)).fetchone()
        if not j:
            raise HTTPException(404, "jar not found")
        if j["state"] != "bottled":
            raise HTTPException(400, "jar is not bottled")
        now = now_iso()
        bottles = conn.execute("SELECT * FROM bottles WHERE jar_id=?", (jid,)).fetchall()
        if not bottles:
            raise HTTPException(400, "у партии нет бутылок")
        for b in bottles:
            has_add = bool(b["has_additives"])
            new_stage = "f3" if has_add else "chilling"
            updates = {
                "stage": new_stage,
                "f2_end": now,
                "carbonation": payload.carbonation,
                "sediment": 1 if payload.sediment else 0,
                "sediment_note": payload.sediment_note,
            }
            if new_stage == "chilling":
                updates["chill_start"] = now
            sets = ", ".join(f"{k}=?" for k in updates)
            conn.execute(f"UPDATE bottles SET {sets} WHERE id=?", (*updates.values(), b["id"]))
            log_event(conn, "bottle", b["id"], new_stage, "f2_finished",
                      {"carbonation": payload.carbonation, "sediment": payload.sediment})
        log_event(conn, "jar", jid, "f2", "f2_finished", payload.model_dump())
        return {"ok": True}


@app.post("/api/bottles/{bid}/chill_out")
def chill_out(bid: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not row:
            raise HTTPException(404, "bottle not found")
        if row["stage"] != "chilling":
            raise HTTPException(400, "bottle is not chilling")
        now = now_iso()
        conn.execute("UPDATE bottles SET stage='stored', chill_end=? WHERE id=?", (now, bid))
        log_event(conn, "bottle", bid, "stored", "chill_out")
        return {"ok": True}


@app.post("/api/bottles/{bid}/stage")
def set_bottle_stage(bid: int, payload: dict):
    stage = payload.get("stage")
    if stage not in VALID_STAGES:
        raise HTTPException(400, "invalid stage")
    with db() as conn:
        row = conn.execute("SELECT * FROM bottles WHERE id=?", (bid,)).fetchone()
        if not row:
            raise HTTPException(404, "bottle not found")
        upd = {"stage": stage}
        if stage == "chilling" and not row["chill_start"]:
            upd["chill_start"] = now_iso()
        if stage == "stored" and row["stage"] == "chilling" and not row["chill_end"]:
            upd["chill_end"] = now_iso()
        sets = ", ".join(f"{k}=?" for k in upd)
        conn.execute(f"UPDATE bottles SET {sets} WHERE id=?", (*upd.values(), bid))
        log_event(conn, "bottle", bid, stage, "stage_changed")
        return {"ok": True, "stage": stage}


# ---------- events ----------

@app.post("/api/events")
def add_event(payload: EventIn):
    if payload.entity_type not in ("jar", "bottle", "honeytee"):
        raise HTTPException(400, "invalid entity_type")
    table = {"jar": "jar", "bottle": "bottles", "honeytee": "honeytee"}[payload.entity_type]
    with db() as conn:
        if not conn.execute(f"SELECT id FROM {table} WHERE id=?", (payload.entity_id,)).fetchone():
            raise HTTPException(404, "entity not found")
        log_event(conn, payload.entity_type, payload.entity_id, payload.stage,
                  payload.event_type, payload.payload)
        return {"ok": True}


@app.get("/api/events")
def list_events(entity_type: Optional[str] = None, entity_id: Optional[int] = None):
    with db() as conn:
        if entity_type and entity_id:
            rows = conn.execute(
                "SELECT * FROM events WHERE entity_type=? AND entity_id=? ORDER BY id DESC",
                (entity_type, entity_id)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT 200").fetchall()
        return [row_to_dict(r) for r in rows]


@app.patch("/api/events/{eid}")
def patch_event(eid: int, payload: EventPatch):
    with db() as conn:
        if not conn.execute("SELECT id FROM events WHERE id=?", (eid,)).fetchone():
            raise HTTPException(404, "event not found")
        fields = {}
        if payload.event_type is not None: fields["event_type"] = payload.event_type
        if payload.payload is not None: fields["payload"] = json.dumps(payload.payload, ensure_ascii=False)
        if not fields:
            raise HTTPException(400, "no fields to update")
        sets = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE events SET {sets} WHERE id=?", (*fields.values(), eid))
        return row_to_dict(conn.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone())


@app.delete("/api/events/{eid}")
def delete_event(eid: int):
    with db() as conn:
        if not conn.execute("SELECT id FROM events WHERE id=?", (eid,)).fetchone():
            raise HTTPException(404, "event not found")
        conn.execute("DELETE FROM events WHERE id=?", (eid,))
        return {"ok": True}


# ---------- Backup ----------

@app.post("/api/backup")
def api_backup():
    path = make_backup()
    return {"ok": True, "file": path.name}


@app.get("/api/backups")
def list_backups():
    files = sorted(BACKUP_DIR.glob("backup_*.json"), reverse=True)
    return [{"name": f.name, "size": f.stat().st_size} for f in files]


@app.post("/api/restore")
async def api_restore(file: UploadFile = File(...)):
    try:
        data = json.loads((await file.read()).decode("utf-8"))
    except Exception as e:
        raise HTTPException(400, f"invalid json: {e}")
    restore_from(data)
    return {"ok": True}


@app.get("/api/export")
def api_export():
    make_backup()
    files = sorted(BACKUP_DIR.glob("backup_*.json"), reverse=True)
    return FileResponse(files[0], filename=files[0].name, media_type="application/json")


@app.get("/")
def index():
    return FileResponse(TEMPLATES_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
