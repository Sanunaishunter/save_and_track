"""
個股 FOMO(散戶追高風險)計分。

純函式、不碰網路,方便離線驗證。所有門檻集中在 THRESHOLDS,不散落各處。
"""

# ---------------------------------------------------------------- 門檻常數

MARGIN_CHANGE_HIGH = 20      # 融資 5 日增幅(%)過熱
MARGIN_CHANGE_WARN = 15      # 融資 5 日增幅警戒
MARGIN_CHANGE_NOTICE = 10    # 融資 5 日增幅注意
PBR_HIGH = 2.5               # 股價淨值比偏高
PBR_REAL_RALLY_MAX = 2.0     # 真漲可接受的 PBR 上限
PBR_MID = 1.5                # 股價淨值比中段
SHORT_MARGIN_BULL = 15       # 券資比(%)低於此視為籌碼偏多
FOREIGN_CONSECUTIVE = 3      # 外資連續買超天數門檻

REAL_RALLY_PASS = 60         # 真漲成立分數
FAKE_RALLY_PASS = 60         # 虛漲成立分數

THRESHOLDS = {
    "MARGIN_CHANGE_HIGH": MARGIN_CHANGE_HIGH,
    "MARGIN_CHANGE_WARN": MARGIN_CHANGE_WARN,
    "MARGIN_CHANGE_NOTICE": MARGIN_CHANGE_NOTICE,
    "PBR_HIGH": PBR_HIGH,
    "PBR_REAL_RALLY_MAX": PBR_REAL_RALLY_MAX,
    "PBR_MID": PBR_MID,
    "SHORT_MARGIN_BULL": SHORT_MARGIN_BULL,
    "FOREIGN_CONSECUTIVE": FOREIGN_CONSECUTIVE,
    "REAL_RALLY_PASS": REAL_RALLY_PASS,
    "FAKE_RALLY_PASS": FAKE_RALLY_PASS,
}


def _clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))


def judge_real_rally(m):
    """
    真漲判斷。m 是 metrics dict;缺的欄位一律不給分,並記錄在 missing。
    回傳 {score, is_real_rally, reasons, missing}
    """
    score = 0
    reasons = []
    missing = []

    v = m.get("foreign_consecutive_buy_days")
    if v is None:
        missing.append("外資連續買超天數")
    elif v >= FOREIGN_CONSECUTIVE:
        score += 40
        reasons.append("外資連續買超 %d 天(≥%d)" % (v, FOREIGN_CONSECUTIVE))

    v = m.get("margin_change_5d_pct")
    if v is None:
        missing.append("融資5日增幅")
    elif v < MARGIN_CHANGE_NOTICE:
        score += 20
        reasons.append("融資5日增幅 %.1f%%(<%d%%,散戶未過度追價)"
                       % (v, MARGIN_CHANGE_NOTICE))

    v = m.get("short_margin_ratio")
    if v is None:
        missing.append("券資比")
    elif v < SHORT_MARGIN_BULL:
        score += 20
        reasons.append("券資比 %.1f%%(<%d%%,空方壓力低)" % (v, SHORT_MARGIN_BULL))

    v = m.get("pbr")
    if v is None:
        missing.append("PBR")
    elif v < PBR_REAL_RALLY_MAX:
        score += 20
        reasons.append("PBR %.2f(<%.1f,評價未偏高)" % (v, PBR_REAL_RALLY_MAX))

    return {
        "score": _clamp(score),
        "is_real_rally": score >= REAL_RALLY_PASS,
        "reasons": reasons,
        "missing": missing,
    }


def judge_fake_stock_rally(m):
    """虛漲判斷。回傳 {score, is_fake_rally, reasons, missing}"""
    score = 0
    reasons = []
    missing = []

    v = m.get("margin_change_5d_pct")
    if v is None:
        missing.append("融資5日增幅")
    elif v > MARGIN_CHANGE_WARN:
        score += 30
        reasons.append("融資5日增幅 %.1f%%(>%d%%,散戶追價明顯)"
                       % (v, MARGIN_CHANGE_WARN))

    v = m.get("foreign_net")
    if v is None:
        missing.append("外資買賣超")
    elif v <= 0:
        score += 20
        reasons.append("外資賣超或中性(%s 股)" % format(int(v), ","))

    v = m.get("pbr")
    if v is None:
        missing.append("PBR")
    elif v > PBR_HIGH:
        score += 20
        reasons.append("PBR %.2f(>%.1f,評價偏高)" % (v, PBR_HIGH))

    vol, prev = m.get("volume"), m.get("prev_volume")
    if vol is None or prev is None:
        missing.append("成交量")
    elif vol < prev:
        score += 10
        reasons.append("今日量縮(%s → %s)" % (format(int(prev), ","), format(int(vol), ",")))

    return {
        "score": _clamp(score),
        "is_fake_rally": score >= FAKE_RALLY_PASS,
        "reasons": reasons,
        "missing": missing,
    }


def calculate_stock_fomo_score(m):
    """FOMO 綜合分數。回傳 {score, reasons, missing}"""
    score = 0
    reasons = []
    missing = []

    v = m.get("margin_change_5d_pct")
    if v is None:
        missing.append("融資5日增幅")
    elif v > MARGIN_CHANGE_HIGH:
        score += 40
        reasons.append("融資5日增幅 %.1f%%(>%d%%)" % (v, MARGIN_CHANGE_HIGH))
    elif v >= MARGIN_CHANGE_WARN:
        score += 30
        reasons.append("融資5日增幅 %.1f%%(%d~%d%%)"
                       % (v, MARGIN_CHANGE_WARN, MARGIN_CHANGE_HIGH))
    elif v >= MARGIN_CHANGE_NOTICE:
        score += 20
        reasons.append("融資5日增幅 %.1f%%(%d~%d%%)"
                       % (v, MARGIN_CHANGE_NOTICE, MARGIN_CHANGE_WARN))

    v = m.get("pbr")
    if v is None:
        missing.append("PBR")
    elif v > PBR_HIGH:
        score += 20
        reasons.append("PBR %.2f(>%.1f)" % (v, PBR_HIGH))
    elif v >= PBR_MID:
        score += 10
        reasons.append("PBR %.2f(%.1f~%.1f)" % (v, PBR_MID, PBR_HIGH))

    v = m.get("short_margin_ratio")
    if v is None:
        missing.append("券資比")
    elif v < SHORT_MARGIN_BULL:
        score += 20
        reasons.append("券資比 %.1f%%(<%d%%)" % (v, SHORT_MARGIN_BULL))

    v = m.get("foreign_net")
    if v is None:
        missing.append("外資買賣超")
    elif v < 0:
        score += 10
        reasons.append("外資賣超(%s 股)" % format(int(v), ","))

    return {"score": _clamp(score), "reasons": reasons, "missing": missing}


def score_stock(stock_id, stock_name, m):
    """把三組判斷合成一筆輸出。"""
    real = judge_real_rally(m)
    fake = judge_fake_stock_rally(m)
    fomo = calculate_stock_fomo_score(m)

    missing = []
    for part in (real, fake, fomo):
        for k in part["missing"]:
            if k not in missing:
                missing.append(k)

    return {
        "stock_id": stock_id,
        "stock_name": stock_name,
        "fomo_score": fomo["score"],
        "is_real_rally": real["is_real_rally"],
        "real_rally_score": real["score"],
        "is_fake_rally": fake["is_fake_rally"],
        "fake_rally_score": fake["score"],
        "metrics": {
            "pbr": m.get("pbr"),
            "margin_change_5d_pct": (None if m.get("margin_change_5d_pct") is None
                                     else round(m["margin_change_5d_pct"], 2)),
            "short_margin_ratio": (None if m.get("short_margin_ratio") is None
                                   else round(m["short_margin_ratio"], 2)),
            "foreign_net": m.get("foreign_net"),
            "foreign_consecutive_buy_days": m.get("foreign_consecutive_buy_days"),
            "close": m.get("close"),
            "volume": m.get("volume"),
            "prev_volume": m.get("prev_volume"),
        },
        "reasons": {
            "fomo": fomo["reasons"],
            "real_rally": real["reasons"],
            "fake_rally": fake["reasons"],
        },
        "missing": missing,
    }
