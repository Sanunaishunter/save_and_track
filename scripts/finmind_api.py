"""FinMind API 最小封裝。只用標準函式庫,GitHub Actions 上不必 pip install。"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API_URL = "https://api.finmindtrade.com/api/v4/data"

# 未註冊 300 次/小時、註冊會員 600 次/小時。這支程式一天只用個位數次呼叫,
# 只有第一次回補基線會用到 30 次左右,兩種模式都夠。
DEFAULT_TIMEOUT = 60
MAX_RETRY = 4


class FinMindError(RuntimeError):
    pass


def _token():
    return (os.environ.get("FINMIND_TOKEN") or "").strip()


def request(dataset, **params):
    """打一次 FinMind,回傳 data 陣列。失敗會重試(含 402/429 退避)。"""
    query = {"dataset": dataset}
    query.update({k: v for k, v in params.items() if v is not None})
    url = API_URL + "?" + urllib.parse.urlencode(query)

    headers = {"User-Agent": "save_and_track-scanner/1.0"}
    tok = _token()
    if tok:
        headers["Authorization"] = "Bearer " + tok

    last = None
    for attempt in range(MAX_RETRY):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            last = "HTTP %s %s" % (e.code, body)
            # 402 = 超過額度、429 = 太頻繁,退避後重試
            if e.code in (402, 429, 500, 502, 503, 504):
                time.sleep(min(60, 5 * (2 ** attempt)))
                continue
            raise FinMindError("FinMind %s 回應 %s" % (dataset, last))
        except (urllib.error.URLError, TimeoutError) as e:
            last = str(e)
            time.sleep(min(30, 3 * (2 ** attempt)))
            continue

        status = payload.get("status")
        if status != 200:
            msg = payload.get("msg", "")
            last = "status=%s msg=%s" % (status, msg)
            if status in (402, 429):
                time.sleep(min(60, 5 * (2 ** attempt)))
                continue
            raise FinMindError("FinMind %s 失敗:%s" % (dataset, last))

        return payload.get("data") or []

    raise FinMindError("FinMind %s 重試 %d 次仍失敗:%s" % (dataset, MAX_RETRY, last))


def daily_prices(date_str):
    """該日全市場收盤價。不帶 data_id 時 FinMind 會回傳當日所有股票。"""
    return request("TaiwanStockPrice", start_date=date_str, end_date=date_str)


def stock_info():
    """代碼 → 名稱 / 市場別 / 產業別 對照表。"""
    return request("TaiwanStockInfo")
