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
T86_URLS = [
    "https://www.twse.com.tw/rwd/zh/fund/T86?date=%s&selectType=ALL&response=json",
    "https://www.twse.com.tw/fund/T86?response=json&date=%s&selectType=ALL",
]

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


def _row(code, name, volume, o, h, l, c, transaction=None):
    """統一成內部格式;缺價量的(當日無成交)回傳 None。"""
    volume = _num(volume)
    o, h, l, c = _num(o), _num(h), _num(l), _num(c)
    if volume is None or c is None or o is None:
        return None
    if h is None:
        h = max(o, c)
    if l is None:
        l = min(o, c)
    t = _num(transaction)
    return {"code": str(code).strip(), "name": str(name or "").strip(),
            "volume": int(volume), "open": o, "high": h, "low": l, "close": c,
            # 成交筆數:STOCK_DAY_ALL 的 Transaction / MI_INDEX 的「成交筆數」
            "transaction": None if t is None else int(t)}


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
                   r.get("LowestPrice"), r.get("ClosingPrice"),
                   r.get("Transaction"))
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
        has_tx = "成交筆數" in idx
        if any(k not in idx for k in need):
            last_err = TWSEError("MI_INDEX 欄位與預期不符:%s" % fields)
            continue

        rows = []
        for d in data:
            try:
                row = _row(d[idx["證券代號"]], d[idx["證券名稱"]], d[idx["成交股數"]],
                           d[idx["開盤價"]], d[idx["最高價"]],
                           d[idx["最低價"]], d[idx["收盤價"]],
                           d[idx["成交筆數"]] if has_tx else None)
            except (IndexError, TypeError):
                continue
            if row:
                rows.append(row)

        date_iso = str(payload.get("date") or ymd)
        date_iso = "%s-%s-%s" % (date_iso[:4], date_iso[4:6], date_iso[6:8])
        return date_iso, rows

    raise TWSEError("MI_INDEX 兩條路徑都失敗:%s" % last_err)


# ---------------------------------------------------------------- 法人買賣超

# T86 的外資欄位是「不含外資自營商」,與 FinMind 的 Foreign_Investor 定義一致。
T86_CODE = "證券代號"
T86_FOREIGN = "外陸資買賣超股數(不含外資自營商)"
T86_TRUST = "投信買賣超股數"


def institutional_by_date(ymd, keep=None):
    """
    指定日期的全市場個股法人買賣超(T86)。

    回傳 (日期, {code: {foreign, trust}}, totals);休市日回傳 (None, {}, {})。
    totals 是「買超個股加總」與「賣超個股加總」,用來當佔比的分母 ——
    不能用市場買賣差額,因為那可能是負數(實測 8/31 外資淨賣超 143 億),
    當分母算出來的百分比沒有意義。

    keep(code) 可指定只納入哪些股票,讓分母與掃描範圍一致。
    """
    last_err = None
    for tpl in T86_URLS:
        try:
            payload = _get_json(tpl % ymd)
        except TWSEError as e:
            last_err = e
            continue

        if payload.get("stat") != "OK":
            return None, {}, {}

        fields = payload.get("fields") or []
        data = payload.get("data") or []
        if not data:
            return None, {}, {}

        idx = {name: i for i, name in enumerate(fields)}
        for need in (T86_CODE, T86_FOREIGN, T86_TRUST):
            if need not in idx:
                last_err = TWSEError("T86 欄位與預期不符:%s" % fields)
                break
        else:
            per_stock = {}
            totals = {"foreign_buy": 0, "foreign_sell": 0,
                      "trust_buy": 0, "trust_sell": 0}
            for row in data:
                try:
                    code = str(row[idx[T86_CODE]]).strip()
                    foreign = _num(row[idx[T86_FOREIGN]])
                    trust = _num(row[idx[T86_TRUST]])
                except (IndexError, TypeError):
                    continue
                if foreign is None and trust is None:
                    continue
                if keep and not keep(code):
                    continue
                per_stock[code] = {"foreign": foreign or 0.0, "trust": trust or 0.0}
                if foreign:
                    key = "foreign_buy" if foreign > 0 else "foreign_sell"
                    totals[key] += abs(foreign)
                if trust:
                    key = "trust_buy" if trust > 0 else "trust_sell"
                    totals[key] += abs(trust)

            date_iso = str(payload.get("date") or ymd)
            date_iso = "%s-%s-%s" % (date_iso[:4], date_iso[4:6], date_iso[6:8])
            return date_iso, per_stock, totals
        continue

    raise TWSEError("T86 兩條路徑都失敗:%s" % last_err)


# ---------------------------------------------------------------- 公司基本資料

COMPANY_INFO_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"

CI_CODE = "公司代號"
CI_NAME = "公司簡稱"
CI_SHARES = "已發行普通股數或TDR原股發行股數"
CI_INDUSTRY = "產業別"


def company_info():
    """
    上市公司基本資料(t187ap03_L),實測 1,095 筆。

    這裡只取發行股數 —— 市值 = 發行股數 × 收盤價,也就是 SH2 在沒有付費
    market_value 欄位時用的免費 fallback。

    這支表的「產業別」是數字代碼("01"),與 SH2 用的中文分類
    (FinMind industry_category)對不起來,所以分組用的產業別仍從 FinMind 取;
    這裡把代碼一併帶出來存查 —— FinMind 對上市電子股幾乎只給「電子工業」
    這個大類,將來若要換成 TWSE 的官方細分類,需要的原料就在這欄。

    這份清單同時是「哪些代碼是上市公司」的權威來源。

    回傳 {code: {"name": 簡稱, "shares": 股數, "twse_industry_code": 代碼}}。
    """
    data = _get_json(COMPANY_INFO_URL)
    if not isinstance(data, list) or not data:
        raise TWSEError("t187ap03_L 回傳空資料")

    out = {}
    for r in data:
        code = str(r.get(CI_CODE) or "").strip()
        if not code:
            continue
        shares = _num(r.get(CI_SHARES))
        out[code] = {
            "name": str(r.get(CI_NAME) or "").strip(),
            "shares": None if shares is None else int(shares),
            "twse_industry_code": str(r.get(CI_INDUSTRY) or "").strip() or None,
        }
    return out
