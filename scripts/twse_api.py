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


# ---------------------------------------------------------------- 大盤成交資訊

MARKET_SUMMARY_URL = "https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK"


def market_summary():
    """
    集中市場每日市場成交資訊,實測回應只含最近兩個交易日。

    回傳 [{date(西元 ISO), taiex, change, trade_value, trade_volume,
           transaction}, ...],新到舊。
    """
    data = _get_json(MARKET_SUMMARY_URL)
    if not isinstance(data, list) or not data:
        raise TWSEError("FMTQIK 回傳空資料")

    out = []
    for r in data:
        date_iso = _roc_to_iso(r.get("Date"))
        if not date_iso:
            continue
        out.append({
            "date": date_iso,
            "taiex": _num(r.get("TAIEX")),
            "change": _num(r.get("Change")),
            "trade_value": _num(r.get("TradeValue")),
            "trade_volume": _num(r.get("TradeVolume")),
            "transaction": _num(r.get("Transaction")),
        })
    out.sort(key=lambda x: x["date"], reverse=True)
    return out


# ---------------------------------------------------------------- 大盤指數歷史(日期可定址)
#
# 2026-09-10 probe 確認(scripts/probe_market_index_history.py,結論見
# data/README.md):MI_INDEX?date=&type=ALL 的 tables 裡,除了 by_date()
# 在用的「每日收盤行情」個股表之外,還有三張表有用:
#   - 「OO年OO月OO日 價格指數(臺灣證券交易所)」:56 檔指數的當日收盤/漲跌,
#     「發行量加權股價指數」那一列就是 TAIEX——但**只有收盤,沒有開高低**,
#     TWSE 的日報表本來就沒公布指數的開高低。
#   - 「OO年OO月OO日 大盤統計資訊」:依證券類別分類的官方成交金額/股數/
#     筆數,「1.一般股票」那列最接近「上市普通股」。
#   - 「漲跌證券數合計」:官方漲跌家數統計,「股票」欄位(不是「整體市場」,
#     那個含 ETF/權證等),格式「259(8)」= 259 家(其中 8 家漲停)。
# 這三張表跟個股報價是同一次 MI_INDEX 回應,理論上可以合併省一次呼叫,
# 但目前用途分開(這支給大盤九宮格,by_date() 給個股回補),各自獨立呼叫
# 比較不會互相牽動,MI_INDEX 免費無額度限制,重複呼叫不是問題。

TAIEX_NAME = "發行量加權股價指數"
TURNOVER_ROW_LABEL = "1.一般股票"


def _find_table(payload, required_fields):
    for t in payload.get("tables") or []:
        if not isinstance(t, dict):
            continue
        fields = t.get("fields") or []
        if all(f in fields for f in required_fields):
            return fields, (t.get("data") or [])
    return None, None


def _num_comma(v):
    """把 '46,940.49' 這種千分位字串轉成 float,格式不對回傳 None。"""
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _breadth_num(v):
    """漲跌證券數合計的格式是 '259(8)'(家數(其中漲跌停家數)),只取前面的家數。"""
    s = str(v or "").split("(")[0].replace(",", "").strip()
    try:
        return int(s)
    except ValueError:
        return None


def market_index_by_date(ymd):
    """
    指定日期(YYYYMMDD)的大盤指數收盤/漲跌 + 官方成交金額/股數/筆數 +
    官方漲跌證券數。休市日回傳 None。

    回傳 dict:
      date, idx_close, idx_change, idx_change_pct,
      turnover_amount, turnover_shares, turnover_tx,
      advancing, declining, unchanged

    沒有 idx_open/idx_high/idx_low——TWSE 的日報表沒有公布指數開高低,
    不是這支漏抓。
    """
    last_err = None
    for tpl in MI_INDEX_URLS:
        try:
            payload = _get_json(tpl % ymd)
        except TWSEError as e:
            last_err = e
            continue

        if payload.get("stat") != "OK":
            return None

        date_iso = str(payload.get("date") or ymd)
        date_iso = "%s-%s-%s" % (date_iso[:4], date_iso[4:6], date_iso[6:8])

        out = {
            "date": date_iso, "idx_close": None, "idx_change": None, "idx_change_pct": None,
            "turnover_amount": None, "turnover_shares": None, "turnover_tx": None,
            "advancing": None, "declining": None, "unchanged": None,
        }

        idx_fields, idx_data = _find_table(payload, ["指數", "收盤指數", "漲跌點數", "漲跌百分比(%)"])
        if idx_data:
            idx_i = {name: i for i, name in enumerate(idx_fields)}
            for row in idx_data:
                try:
                    name = row[idx_i["指數"]]
                except (IndexError, TypeError):
                    continue
                if name != TAIEX_NAME:
                    continue
                out["idx_close"] = _num_comma(row[idx_i["收盤指數"]])
                pct = _num_comma(row[idx_i["漲跌百分比(%)"]])
                pts = _num_comma(row[idx_i["漲跌點數"]])
                out["idx_change_pct"] = pct
                if pts is not None and pct is not None:
                    out["idx_change"] = -pts if pct < 0 else pts
                break

        to_fields, to_data = _find_table(payload, ["成交統計", "成交金額(元)", "成交股數(股)", "成交筆數"])
        if to_data:
            to_i = {name: i for i, name in enumerate(to_fields)}
            for row in to_data:
                try:
                    label = row[to_i["成交統計"]]
                except (IndexError, TypeError):
                    continue
                if label != TURNOVER_ROW_LABEL:
                    continue
                out["turnover_amount"] = _num_comma(row[to_i["成交金額(元)"]])
                out["turnover_shares"] = _num_comma(row[to_i["成交股數(股)"]])
                out["turnover_tx"] = _num_comma(row[to_i["成交筆數"]])
                break

        bd_fields, bd_data = _find_table(payload, ["類型", "整體市場", "股票"])
        if bd_data:
            bd_i = {name: i for i, name in enumerate(bd_fields)}
            for row in bd_data:
                try:
                    label, val = row[bd_i["類型"]], row[bd_i["股票"]]
                except (IndexError, TypeError):
                    continue
                if label == "上漲(漲停)":
                    out["advancing"] = _breadth_num(val)
                elif label == "下跌(跌停)":
                    out["declining"] = _breadth_num(val)
                elif label == "持平":
                    out["unchanged"] = _breadth_num(val)

        return out

    raise TWSEError("MI_INDEX 兩條路徑都失敗:%s" % last_err)


# ---------------------------------------------------------------- 注意股

ATTENTION_URL = "https://openapi.twse.com.tw/v1/announcement/notice"


def attention_stocks():
    """
    集中市場當日公布注意股票。

    實測沒有資料時回傳一筆全空欄位的 placeholder(Code 是空字串),
    不是 HTTP 錯誤也不是空陣列 —— 濾掉這種列,但沒辦法區分「今天真的
    沒有注意股」跟「還沒公布」,兩種情況回應長得一模一樣,呼叫端要自己
    決定怎麼講給使用者聽。

    回傳 [{code, name, closing_price, pe, notice_count, reason}, ...]。
    """
    data = _get_json(ATTENTION_URL)
    if not isinstance(data, list):
        raise TWSEError("announcement/notice 回傳格式不是陣列")

    out = []
    for r in data:
        code = str(r.get("Code") or "").strip()
        if not code:
            continue
        out.append({
            "code": code,
            "name": str(r.get("Name") or "").strip(),
            "closing_price": _num(r.get("ClosingPrice")),
            "pe": _num(r.get("PE")),
            "notice_count": _num(r.get("NumberOfAnnouncement")),
            "reason": str(r.get("TradingInfoForAttention") or "").strip(),
        })
    return out


# ---------------------------------------------------------------- 融資融券餘額

MARGIN_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN"


def margin_balance():
    """
    集中市場融資融券餘額,全市場一次拿到(含非普通股,呼叫端自行篩選)。

    回傳 {code: {name, margin_today, margin_prev, margin_buy, margin_sell,
                 margin_cash_repay, margin_limit, short_today, short_prev,
                 short_buy, short_sell, short_stock_repay, short_limit,
                 offset}}。
    """
    data = _get_json(MARGIN_URL)
    if not isinstance(data, list) or not data:
        raise TWSEError("MI_MARGN 回傳空資料")

    out = {}
    for r in data:
        code = str(r.get("股票代號") or "").strip()
        if not code:
            continue
        out[code] = {
            "name": str(r.get("股票名稱") or "").strip(),
            "margin_today": _num(r.get("融資今日餘額")),
            "margin_prev": _num(r.get("融資前日餘額")),
            "margin_buy": _num(r.get("融資買進")),
            "margin_sell": _num(r.get("融資賣出")),
            "margin_cash_repay": _num(r.get("融資現金償還")),
            "margin_limit": _num(r.get("融資限額")),
            "short_today": _num(r.get("融券今日餘額")),
            "short_prev": _num(r.get("融券前日餘額")),
            "short_buy": _num(r.get("融券買進")),
            "short_sell": _num(r.get("融券賣出")),
            "short_stock_repay": _num(r.get("融券現券償還")),
            "short_limit": _num(r.get("融券限額")),
            "offset": _num(r.get("資券互抵")),
        }
    return out


# ---------------------------------------------------------------- 停資停券預告

SUSPENSION_URL = "https://openapi.twse.com.tw/v1/exchangeReport/BFI84U"


def margin_suspension():
    """
    集中市場停資停券預告表。

    回傳 [{code, name, start(西元 ISO), end(西元 ISO), reason}, ...]。
    """
    data = _get_json(SUSPENSION_URL)
    if not isinstance(data, list):
        raise TWSEError("BFI84U 回傳格式不是陣列")

    out = []
    for r in data:
        code = str(r.get("Code") or "").strip()
        if not code:
            continue
        out.append({
            "code": code,
            "name": str(r.get("Name") or "").strip(),
            "start": _roc_to_iso(r.get("StartDate")),
            "end": _roc_to_iso(r.get("EndDate")),
            "reason": str(r.get("Reason") or "").strip(),
        })
    return out


# ---------------------------------------------------------------- 除權除息預告

EXDIV_URL = "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL"


def exdividend_calendar():
    """
    上市股票除權除息預告表。

    回傳 [{code, name, date(西元 ISO), kind, cash_dividend}, ...]。
    kind 是 Exdividend 原文("息"/"權"/"權息"),照原樣存查,不轉譯。
    """
    data = _get_json(EXDIV_URL)
    if not isinstance(data, list):
        raise TWSEError("TWT48U_ALL 回傳格式不是陣列")

    out = []
    for r in data:
        code = str(r.get("Code") or "").strip()
        if not code:
            continue
        out.append({
            "code": code,
            "name": str(r.get("Name") or "").strip(),
            "date": _roc_to_iso(r.get("Date")),
            "kind": str(r.get("Exdividend") or "").strip(),
            "cash_dividend": _num(r.get("CashDividend")),
        })
    return out
