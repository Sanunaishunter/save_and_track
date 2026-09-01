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

# 8012 產業/市值 Tick 聚合
META_FILE = os.path.join(DATA_DIR, "stock_meta.json")
TICK_DIR = os.path.join(DATA_DIR, "tick")
TICK_LATEST_FILE = os.path.join(DATA_DIR, "tick-latest.json")
TICK_MEMBERS_FILE = os.path.join(DATA_DIR, "tick-members-latest.json")
# 抽樣一旦凍結就不再重算,所以這個檔案是長期狀態,不是每日產出
TICK_SAMPLE_FILE = os.path.join(DATA_DIR, "tick-sample-members.json")

# 每日價格檔的欄位順序(用陣列存,1700 檔一天約 100KB)
# transaction = 成交筆數,8012 的 tick 活躍度代理指標
COLUMNS = ["id", "volume", "open", "high", "low", "close", "transaction"]

# MA20 需要「不含當日的前 20 個交易日」,原本留 25 天當緩衝。
# 8012 的 rebase 圖要顯示 30 天(DISPLAY_DAYS),所以保留天數跟著拉到 30。
MA_WINDOW = 20
KEEP_DAYS = 30

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


def history_is_current(date_str):
    """
    檔案的欄位是否已包含目前需要的全部欄位。

    新增欄位(例如 8012 需要的成交筆數)後,舊檔案會缺欄位。與其手動清掉重抓,
    不如讓抓取流程把「欄位過時」視同「缺漏」,自動重新取得。
    """
    blob = read_json(history_path(date_str))
    if not blob:
        return False
    cols = blob.get("columns") or []
    return all(c in cols for c in COLUMNS)


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
