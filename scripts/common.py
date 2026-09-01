"""共用設定與檔案存取。"""

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
HISTORY_DIR = os.path.join(DATA_DIR, "history")
SCANS_DIR = os.path.join(DATA_DIR, "scans")
NAMES_FILE = os.path.join(DATA_DIR, "stock_names.json")
NO_TRADE_FILE = os.path.join(DATA_DIR, "no_trade_dates.json")
LATEST_FILE = os.path.join(DATA_DIR, "scan-latest.json")

# 每日價格檔的欄位順序(用陣列存,1700 檔一天約 100KB)
COLUMNS = ["id", "volume", "open", "high", "low", "close"]

# MA20 需要「不含當日的前 20 個交易日」,25 天是緩衝
MA_WINDOW = 20
KEEP_DAYS = 25

# 爆量門檻(沿用 SH2 project102)
VOL_RATIO_THRESHOLD = 1.5

# 只要上市普通股:四位數、開頭非 0(排除 00 開頭的 ETF 與六位數權證)
LISTED_CODE = re.compile(r"^[1-9]\d{3}$")


def is_listed_common(stock_id, market_type):
    if market_type is not None and market_type != "twse":
        return False
    return bool(LISTED_CODE.match(str(stock_id or "")))


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (IOError, OSError, ValueError):
        return default


def write_json(path, obj, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def history_path(date_str):
    return os.path.join(HISTORY_DIR, date_str + ".json")


def history_dates():
    """已存在的歷史日期,由舊到新。"""
    if not os.path.isdir(HISTORY_DIR):
        return []
    out = []
    for name in os.listdir(HISTORY_DIR):
        if name.endswith(".json") and re.match(r"^\d{4}-\d{2}-\d{2}\.json$", name):
            out.append(name[:-5])
    out.sort()
    return out
