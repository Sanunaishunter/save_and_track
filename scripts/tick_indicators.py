"""
8012 的 rebase 指標純函式。

原樣移植自 SH2 的 sh2_autorollout/indicators.py,語意不改寫:
  - vals 是「新到舊」排序,vals[0] 是今天
  - 分母為 None 或 0 → 整條回傳 None
  - 分子分母任一為 None → 該格 None,不當 0 算
  - ma 是 all-or-nothing:窗口內任一天缺值就整格 None

8012 每次聚合只取每條序列的 [0](當天那一格),不需要整條 30 天序列
—— 那是 8009 自己的用法。
"""

from typing import List, Optional

WINDOWS = (20, 10, 5)   # 30 已拿掉:Shioaji tick 只留 28 天,30 窗口永遠湊不齊
DISPLAY_DAYS = 30
MA21_WINDOW = 21


def fixed_row(vals: List[Optional[float]], w: int) -> List[Optional[float]]:
    """固定基底 = value[c] / value[w-1],c < w 才有值。"""
    out = [None] * DISPLAY_DAYS
    if w - 1 >= len(vals):
        return out
    base = vals[w - 1]
    if base is None or base == 0:
        return out
    for c in range(min(w, DISPLAY_DAYS)):
        v = vals[c] if c < len(vals) else None
        out[c] = (v / base) if v is not None else None
    return out


def rolling_row(vals: List[Optional[float]], w: int) -> List[Optional[float]]:
    """滾動基底 = value[c] / value[c+w],c<w 且 c+w 在資料範圍內才有值。"""
    out = [None] * DISPLAY_DAYS
    for c in range(min(w, DISPLAY_DAYS)):
        if c >= len(vals) or c + w >= len(vals):
            continue
        v, base = vals[c], vals[c + w]
        if v is not None and base not in (None, 0):
            out[c] = v / base
    return out


def d0_d1_row(vals: List[Optional[float]]) -> List[Optional[float]]:
    """逐日 D0-D1,index c 對齊 vals[c]-vals[c+1]。"""
    out = [None] * DISPLAY_DAYS
    for c in range(min(len(vals), DISPLAY_DAYS)):
        if c + 1 >= len(vals):
            continue
        v, prev = vals[c], vals[c + 1]
        if v is not None and prev is not None:
            out[c] = v - prev
    return out


def ma_row(vals: List[Optional[float]], w: int) -> List[Optional[float]]:
    """固定窗口移動平均,缺任一天 → None(all-or-nothing,不用不完整窗口)。"""
    out = [None] * DISPLAY_DAYS
    for c in range(DISPLAY_DAYS):
        window_vals = vals[c:c + w] if c + w <= len(vals) else []
        if len(window_vals) == w and all(v is not None for v in window_vals):
            out[c] = sum(window_vals) / w
    return out


def today_metrics(vals: List[Optional[float]]) -> dict:
    """8012 每天要寫進 snapshot 的那一格。"""
    out = {
        "d0_d1": d0_d1_row(vals)[0],
        "ma21": ma_row(vals, MA21_WINDOW)[0],
    }
    for w in WINDOWS:
        out["fixed_%d" % w] = fixed_row(vals, w)[0]
        out["rolling_%d" % w] = rolling_row(vals, w)[0]
    return out
