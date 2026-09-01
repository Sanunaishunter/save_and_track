"""
台灣證券交易所資料存取。只用標準函式庫,免 token、免額度。

兩個端點(皆已在 Actions 上實測):
  - OpenAPI STOCK_DAY_ALL:最新交易日全市場,回應約 300KB
  - MI_INDEX?date=&type=ALL:指定日期的全市場,回應約 4MB
    (「每日收盤行情(全部)」在 tables 之中,含權證,需自行篩選)
"""

import json
import time
import urllib.error
import urllib.request

OPENAPI_ALL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
MI_INDEX_URLS = [
    "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=%s&type=ALL&response=json",
    "https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=%s&type=ALL",
]

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

TIMEOUT = 90
MAX_RETRY = 3


class TWSEError(RuntimeError):
    pass


def _get_json(url):
    last = None
    for attempt in range(MAX_RETRY):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
        })
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            last = "HTTP %s" % e.code
            # 429/5xx 退避重試;其他直接失敗
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(5 * (2 ** attempt))
                continue
            raise TWSEError("%s 回應 %s" % (url[:80], last))
        except Exception as e:          # 逾時、連線中斷、JSON 壞掉
            last = repr(e)
            time.sleep(3 * (2 ** attempt))
    raise TWSEError("%s 重試 %d 次仍失敗:%s" % (url[:80], MAX_RETRY, last))


def _num(v):
    """把 '36,629,630' / '14.73' 轉成數字;'--'、'' 等無效值回傳 None。"""
    if v is None:
        return None
    s = str(v).replace(",", "").replace(" ", "").strip()
    if s in ("", "--", "---", "X", "N/A"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _roc_to_iso(roc):
    """民國日期 '1150831' → '2026-08-31'。"""
    s = str(roc or "").strip()
    if len(s) != 7 or not s.isdigit():
        return None
    return "%04d-%s-%s" % (int(s[:3]) + 1911, s[3:5], s[5:7])


def _row(code, name, volume, o, h, l, c):
    """統一成內部格式;缺價量的(當日無成交)回傳 None。"""
    volume = _num(volume)
    o, h, l, c = _num(o), _num(h), _num(l), _num(c)
    if volume is None or c is None or o is None:
        return None
    if h is None:
        h = max(o, c)
    if l is None:
        l = min(o, c)
    return {"code": str(code).strip(), "name": str(name or "").strip(),
            "volume": int(volume), "open": o, "high": h, "low": l, "close": c}


def latest_all():
    """最新交易日的全市場。回傳 (日期字串, rows)。"""
    data = _get_json(OPENAPI_ALL)
    if not isinstance(data, list) or not data:
        raise TWSEError("STOCK_DAY_ALL 回傳空資料")

    date_iso = _roc_to_iso(data[0].get("Date"))
    if not date_iso:
        raise TWSEError("STOCK_DAY_ALL 的日期無法解析:%r" % (data[0].get("Date"),))

    rows = []
    for r in data:
        row = _row(r.get("Code"), r.get("Name"), r.get("TradeVolume"),
                   r.get("OpeningPrice"), r.get("HighestPrice"),
                   r.get("LowestPrice"), r.get("ClosingPrice"))
        if row:
            rows.append(row)
    return date_iso, rows


def _find_quote_table(payload):
    """在 MI_INDEX 的 tables 裡找出「每日收盤行情」那張表(不寫死索引)。"""
    for t in payload.get("tables") or []:
        if not isinstance(t, dict):
            continue
        fields = t.get("fields") or []
        if "證券代號" in fields and "收盤價" in fields and t.get("data"):
            return fields, t["data"]
    return None, None


def by_date(ymd):
    """
    指定日期(YYYYMMDD)的全市場。休市日回傳 (None, [])。
    兩條路徑實測回應相同,新版失敗時退回舊版。
    """
    last_err = None
    for tpl in MI_INDEX_URLS:
        try:
            payload = _get_json(tpl % ymd)
        except TWSEError as e:
            last_err = e
            continue

        if payload.get("stat") != "OK":
            return None, []                     # 休市 / 無資料
        fields, data = _find_quote_table(payload)
        if not data:
            return None, []

        idx = {name: i for i, name in enumerate(fields)}
        need = ["證券代號", "證券名稱", "成交股數", "開盤價", "最高價", "最低價", "收盤價"]
        if any(k not in idx for k in need):
            last_err = TWSEError("MI_INDEX 欄位與預期不符:%s" % fields)
            continue

        rows = []
        for d in data:
            try:
                row = _row(d[idx["證券代號"]], d[idx["證券名稱"]], d[idx["成交股數"]],
                           d[idx["開盤價"]], d[idx["最高價"]],
                           d[idx["最低價"]], d[idx["收盤價"]])
            except (IndexError, TypeError):
                continue
            if row:
                rows.append(row)

        date_iso = str(payload.get("date") or ymd)
        date_iso = "%s-%s-%s" % (date_iso[:4], date_iso[4:6], date_iso[6:8])
        return date_iso, rows

    raise TWSEError("MI_INDEX 兩條路徑都失敗:%s" % last_err)
