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

# 暴跌掃描:跟爆量掃描完全對稱(同一個 vol_ratio 門檻),只是 close < open
CRASHES_DIR = os.path.join(DATA_DIR, "crashes")
CRASH_LATEST_FILE = os.path.join(DATA_DIR, "crash-latest.json")

# 8012 產業/市值 Tick 聚合
META_FILE = os.path.join(DATA_DIR, "stock_meta.json")
TICK_DIR = os.path.join(DATA_DIR, "tick")
TICK_LATEST_FILE = os.path.join(DATA_DIR, "tick-latest.json")
TICK_MEMBERS_FILE = os.path.join(DATA_DIR, "tick-members-latest.json")
# 抽樣一旦凍結就不再重算,所以這個檔案是長期狀態,不是每日產出
TICK_SAMPLE_FILE = os.path.join(DATA_DIR, "tick-sample-members.json")

# 報價快照:持倉損益要最新收盤價,Kelly 的相關係數要日報酬序列
QUOTES_FILE = os.path.join(DATA_DIR, "quotes-latest.json")

# 題材分類(data/themes.json)是手動維護的靜態清單,不是排程產出,沒有對應的
# fetch 腳本,不需要常數 —— Hugo 判斷資料後直接請 Claude Code 編輯那份檔案

# 籌碼/風險:大盤成交資訊 + 注意股 + 融資融券 + 停資停券預告 + 除權息預告,
# 獨立分頁,跟七步驟/爆量/FOMO/產業流向/部位無關
RISK_FILE = os.path.join(DATA_DIR, "risk-latest.json")

# 大盤九宮格 + 法人融資交叉分析 + 市場情緒 + 拉積盤偵測,放在「籌碼/風險」分頁裡,
# 跟個股獵人九宮格是平行但獨立的功能(參數不共用)
MARKET_GRID_FILE = os.path.join(DATA_DIR, "market-grid-latest.json")

# 匯率(央行開放資料)+ 台指期貨三大法人未平倉(FinMind),放在「籌碼/風險」分頁裡,
# 跟這個分頁其他區塊無關
FX_FUTURES_FILE = os.path.join(DATA_DIR, "fx-futures-latest.json")

# 每日價格檔的欄位順序(用陣列存,1700 檔一天約 100KB)
# transaction = 成交筆數,8012 的 tick 活躍度代理指標
COLUMNS = ["id", "volume", "open", "high", "low", "close", "transaction"]

# MA20 需要「不含當日的前 20 個交易日」,原本留 25 天當緩衝。
# 8012 的 rebase 圖要顯示 30 天(DISPLAY_DAYS),所以保留天數跟著拉到 30。
MA_WINDOW = 20
KEEP_DAYS = 30

# 爆量門檻(沿用 SH2 project102)
VOL_RATIO_THRESHOLD = 1.5

# 絕對量下限(2026-09-09 加入,爆量/暴跌掃描共用)。vol_ratio 只看「比平常
# 放大幾倍」,薄股票平常量只有幾張、放大 1.5 倍還是幾張,一樣會被抓進爆量/
# 暴跌清單,往下傳給 FOMO/暴跌FOMO 當候選池,又被個股查詢隨機抽中拿去打
# FinMind、結果因為個股查詢自己的低活躍度過濾器(見 js/app.js
# LOOKUP_LOW_ACTIVITY_VOLUME_LOTS)整檔濾掉——資料都抓完了才發現沒用,
# 額度白花。門檻跟個股查詢那邊用同一個數字(300 張),在源頭先擋掉這種
# 股票,vol_ratio 篩選跟排名不受影響(只是候選池變乾淨,不是換一套邏輯)。
MIN_VOLUME_LOTS = 300
MIN_VOLUME_SHARES = MIN_VOLUME_LOTS * 1000

# 薄股測試(2026-09-17,使用者用 6957 裕慶-KY 真實線圖抓到的案例)。爆量掃描
# 公式一字不改(vol_ratio > 1.5 且 close > open),只是鎖定「量 < 300 張」這群
# ——現行 MIN_VOLUME_LOTS 門檻會把這群整批濾掉,6957 這次一路到量衝上 390 張
# (2026-09-16)才第一次進爆量掃描名單,同一批公式套用在被濾掉的薄股票身上,
# 9/10(119張)、9/11(162張)甚至更早的 2025-08-19、08-28 等好幾次 vol_ratio
# 早就超過 1.5。全市場回測過(見 CLAUDE.md 第 5 節):這群平均命中率比現有
# 爆量掃描(量>=300張)那群更低、超額報酬更負,不是新發現的獨立優勢,是同一個
# 「爆量看多容易輸」故事的加強版。使用者決定不是要拿這當保證勝率的進場訊號,
# 是「跟著散戶一起抬轎、有紀律地下車」——照樣做成正式訊號、進記分板算勝率,
# 讓使用者自己盯著數字判斷,不是系統幫他下結論說穩賺。
# 下限只是排除接近零成交的雜訊(不是要篩「好」股票),上限沿用 MIN_VOLUME_LOTS
# 讓兩個掃描完全互補、同一天同一檔不會同時出現在兩份清單。
THIN_SCAN_MIN_VOLUME_LOTS = 10
THIN_SCAN_MIN_VOLUME_SHARES = THIN_SCAN_MIN_VOLUME_LOTS * 1000
THIN_SCANS_DIR = os.path.join(DATA_DIR, "thin-scans")
THIN_SCAN_LATEST_FILE = os.path.join(DATA_DIR, "thin-scan-latest.json")
# 出場記分板(2026-09-18,scripts/compute_exit_scorecard.py)
EXIT_SCORECARD_FILE = os.path.join(DATA_DIR, "exit-scorecard-latest.json")

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


# ---------------------------------------------------------------- 2026-09-14 加入
# 永久存檔(不裁掉):data/history 只留 KEEP_DAYS 天,是滾動視窗;回測/記分板
# 需要的是「從有資料那天起全部留著」,所以另存一份按月分檔的壓縮版。
ARCHIVE_DIR = os.path.join(DATA_DIR, "archive")
ARCHIVE_PRICES_DIR = os.path.join(ARCHIVE_DIR, "prices")        # YYYY-MM.json
ARCHIVE_INDEX_FILE = os.path.join(ARCHIVE_DIR, "index.json")     # 大盤指數逐日
ARCHIVE_VALUATION_DIR = os.path.join(ARCHIVE_DIR, "valuation")  # YYYY-MM.json

# 訊號記分板:歷史訊號 → 之後 5/10/20 日超額報酬
SCORECARD_FILE = os.path.join(DATA_DIR, "scorecard-latest.json")
SCORECARD_MIN_N = 60          # 跟 Gate 1 一樣,樣本不到 60 不下結論
FOMO_DIR = os.path.join(DATA_DIR, "fomo")
CRASH_FOMO_DIR = os.path.join(DATA_DIR, "crash-fomo")

# 全市場本益比/淨值比/殖利率(TWSE BWIBBU_ALL,免費)
VALUATION_FILE = os.path.join(DATA_DIR, "valuation-latest.json")

# 事件日曆(手動維護,commit 進 repo;前端另有 localStorage 的個人事件)
EVENTS_FILE = os.path.join(DATA_DIR, "events.json")

# 產業別手動覆蓋(FinMind/TWSE 都把漢翔放在航運業,這種明顯不對的用這份修)
INDUSTRY_OVERRIDES_FILE = os.path.join(DATA_DIR, "industry_overrides.json")


def ma_state(closes_new_to_old):
    """
    價格均線狀態,跟 js/app.js 的 priceMaState() 同一個定義(2026-09-14
    Sonnet 5 做的前端版):MA5/MA10/MA20 都是「含當日」的簡單平均,任一視窗
    不足或有缺值就整組回 None;bull = close > MA5 > MA10 > MA20、bear = 相反、
    其餘 mixed。回傳 {"ma5","ma10","ma20","state"} 或 None。
    """
    c = closes_new_to_old
    if not c or len(c) < 20:
        return None
    win = c[:20]
    if any(v is None for v in win):
        return None
    ma5 = sum(win[:5]) / 5.0
    ma10 = sum(win[:10]) / 10.0
    ma20 = sum(win) / 20.0
    close = win[0]
    if close > ma5 > ma10 > ma20:
        state = "bull"
    elif close < ma5 < ma10 < ma20:
        state = "bear"
    else:
        state = "mixed"
    return {"ma5": round(ma5, 2), "ma10": round(ma10, 2), "ma20": round(ma20, 2), "state": state}


def archive_month_path(ym):
    return os.path.join(ARCHIVE_PRICES_DIR, ym + ".json")


def archive_months():
    if not os.path.isdir(ARCHIVE_PRICES_DIR):
        return []
    out = [n[:-5] for n in os.listdir(ARCHIVE_PRICES_DIR)
           if re.match(r"^\d{4}-\d{2}\.json$", n)]
    out.sort()
    return out


def load_archive_prices(include_history=True):
    """
    回傳 ({date: {code: {open,high,low,close,volume,transaction}}}, dates_sorted)。
    先讀永久存檔,再用 data/history 補存檔還沒收進去的日子(存檔腳本沒跑到
    的情況),同一天以存檔為準。
    """
    days = {}
    for ym in archive_months():
        blob = read_json(archive_month_path(ym)) or {}
        cols = blob.get("columns") or COLUMNS
        idx = {name: i for i, name in enumerate(cols)}
        for ds, rows in (blob.get("days") or {}).items():
            day = {}
            for row in rows:
                try:
                    day[row[idx["id"]]] = {
                        "open": row[idx["open"]], "high": row[idx["high"]],
                        "low": row[idx["low"]], "close": row[idx["close"]],
                        "volume": row[idx["volume"]],
                        "transaction": row[idx["transaction"]] if "transaction" in idx and len(row) > idx["transaction"] else None,
                    }
                except (IndexError, KeyError, TypeError):
                    continue
            days[ds] = day
    if include_history:
        for ds in history_dates():
            if ds in days:
                continue
            blob = read_json(history_path(ds)) or {}
            cols = blob.get("columns") or COLUMNS
            idx = {name: i for i, name in enumerate(cols)}
            day = {}
            for row in blob.get("rows") or []:
                try:
                    day[row[idx["id"]]] = {
                        "open": row[idx["open"]], "high": row[idx["high"]],
                        "low": row[idx["low"]], "close": row[idx["close"]],
                        "volume": row[idx["volume"]],
                        "transaction": row[idx["transaction"]] if "transaction" in idx and len(row) > idx["transaction"] else None,
                    }
                except (IndexError, KeyError, TypeError):
                    continue
            if day:
                days[ds] = day
    return days, sorted(days.keys())
