"""
FinMind API 最小封裝。與 twse_api.py 一樣只用標準函式庫,不需要 pip install。

Token 只從環境變數 FINMIND_TOKEN 讀取(GitHub Secret 注入),
絕不寫進任何會被 commit 或送上 Pages 的檔案。
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API_URL = "https://api.finmindtrade.com/api/v4/data"
TIMEOUT = 60
MAX_RETRY = 4


class FinMindError(RuntimeError):
    pass


def has_token():
    return bool((os.environ.get("FINMIND_TOKEN") or "").strip())


def request(dataset, data_id=None, start_date=None, end_date=None):
    """打一次 FinMind,回傳 data 陣列。402/429 會退避重試。"""
    params = {"dataset": dataset}
    if data_id:
        params["data_id"] = data_id
    if start_date:
        params["start_date"] = start_date
    if end_date:
        params["end_date"] = end_date

    url = API_URL + "?" + urllib.parse.urlencode(params)
    headers = {"User-Agent": "save_and_track-fomo/1.0"}
    tok = (os.environ.get("FINMIND_TOKEN") or "").strip()
    if tok:
        headers["Authorization"] = "Bearer " + tok

    last = None
    for attempt in range(MAX_RETRY):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            last = "HTTP %s %s" % (e.code, body)
            if e.code in (402, 429, 500, 502, 503, 504):
                time.sleep(min(60, 5 * (2 ** attempt)))
                continue
            raise FinMindError("%s:%s" % (dataset, last))
        except Exception as e:
            last = repr(e)
            time.sleep(min(30, 3 * (2 ** attempt)))
            continue

        status = payload.get("status")
        if status != 200:
            last = "status=%s msg=%s" % (status, payload.get("msg"))
            if status in (402, 429):
                time.sleep(min(60, 5 * (2 ** attempt)))
                continue
            raise FinMindError("%s:%s" % (dataset, last))

        return payload.get("data") or []

    raise FinMindError("%s 重試 %d 次仍失敗:%s" % (dataset, MAX_RETRY, last))


def preflight(datasets, sample_stock, start_date, end_date):
    """
    正式開跑前先確認每個 dataset 在目前的帳號等級下真的取得到。

    FinMind 有些查詢是付費功能(例如不帶 data_id 的全市場查詢會回 400
    「Your level is free」),與其跑到一半才炸,不如先用一檔股票各打一次,
    把可用性與實際欄位名稱印出來。
    """
    report = {}
    for ds in datasets:
        try:
            rows = request(ds, data_id=sample_stock,
                           start_date=start_date, end_date=end_date)
            report[ds] = {
                "ok": True,
                "rows": len(rows),
                "fields": sorted(rows[0].keys()) if rows else [],
            }
        except FinMindError as e:
            report[ds] = {"ok": False, "error": str(e)}
        time.sleep(0.3)
    return report
