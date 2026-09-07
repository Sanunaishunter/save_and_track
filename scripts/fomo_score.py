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
SHORT_MARGIN_BULL = 5        # 券資比(%)低於此視為籌碼偏多
                             # 原本 15%,但實測大型股都在 1% 以下,等於恆真、沒有鑑別力
FOREIGN_CONSECUTIVE = 3      # 外資連續買超天數門檻

REAL_RALLY_PASS = 60         # 真漲成立分數
FAKE_RALLY_PASS = 60         # 虛漲成立分數

# --- 暴跌 FOMO(真跌/虛跌)專用門檻 ---
# 概念上是真漲/虛漲的鏡射,但方向不是單純把號誌反過來就好,見 compute_crash_fomo.py
# 開頭的說明。PBR_CRASH_CHEAP、MARGIN_DROP_PANIC 是這裡新增、原本 FOMO 沒有的門檻。
PBR_CRASH_CHEAP = 1.2        # 虛跌:PBR 已經跌到明顯便宜
MARGIN_DROP_PANIC = -15      # 虛跌:融資 5 日大減(斷頭/認賠殺出的門檻,注意是負值)
REAL_CRASH_PASS = 60         # 真跌成立分數
FAKE_CRASH_PASS = 60         # 虛跌成立分數

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
    "REAL_RALLY_REQUIRES_FOREIGN": True,
    "PBR_CRASH_CHEAP": PBR_CRASH_CHEAP,
    "MARGIN_DROP_PANIC": MARGIN_DROP_PANIC,
    "REAL_CRASH_PASS": REAL_CRASH_PASS,
    "FAKE_CRASH_PASS": FAKE_CRASH_PASS,
    "REAL_CRASH_REQUIRES_FOREIGN": True,
}


def _round(v, n=2):
    return None if v is None else round(v, n)


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
        score += 10
        reasons.append("券資比 %.1f%%(<%d%%,空方壓力低)" % (v, SHORT_MARGIN_BULL))

    v = m.get("pbr")
    if v is None:
        missing.append("PBR")
    elif v < PBR_REAL_RALLY_MAX:
        score += 20
        reasons.append("PBR %.2f(<%.1f,評價未偏高)" % (v, PBR_REAL_RALLY_MAX))

    # 外資連買是「必要條件」而不只是加權:分數夠但外資沒進場,不算真漲。
    # 否則融資、券資比、PBR 三項就能湊到 60,出現「外資在賣卻標成真漲」。
    streak = m.get("foreign_consecutive_buy_days")
    foreign_ok = streak is not None and streak >= FOREIGN_CONSECUTIVE
    passed = score >= REAL_RALLY_PASS and foreign_ok
    if score >= REAL_RALLY_PASS and not foreign_ok:
        reasons.append("分數達標但外資未連續買超 %d 天,不列為真漲" % FOREIGN_CONSECUTIVE)

    return {
        "score": _clamp(score),
        "is_real_rally": passed,
        "foreign_gate_passed": foreign_ok,
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
        reasons.append("外資賣超或中性(%s 股)" % format(abs(int(v)), ","))

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


def judge_real_crash(m):
    """
    真跌判斷:這波下跌是法人主導的出貨,不是散戶恐慌錯殺,大機率續跌。
    是 judge_real_rally() 的鏡射,但方向不是單純把號誌反過來 —— 見
    compute_crash_fomo.py 開頭的說明。回傳形狀跟 judge_real_rally() 一致。
    """
    score = 0
    reasons = []
    missing = []

    v = m.get("foreign_consecutive_sell_days")
    if v is None:
        missing.append("外資連續賣超天數")
    elif v >= FOREIGN_CONSECUTIVE:
        score += 40
        reasons.append("外資連續賣超 %d 天(≥%d)" % (v, FOREIGN_CONSECUTIVE))

    v = m.get("margin_change_5d_pct")
    if v is None:
        missing.append("融資5日增幅")
    elif v > -MARGIN_CHANGE_NOTICE:
        score += 20
        reasons.append("融資5日增幅 %.1f%%(>-%d%%,散戶還沒認賠減倉)"
                       % (v, MARGIN_CHANGE_NOTICE))

    v = m.get("short_margin_ratio")
    if v is None:
        missing.append("券資比")
    elif v < SHORT_MARGIN_BULL:
        score += 10
        reasons.append("券資比 %.1f%%(<%d%%,空方還沒大量進場對敲)" % (v, SHORT_MARGIN_BULL))

    v = m.get("pbr")
    if v is None:
        missing.append("PBR")
    elif v > PBR_MID:
        score += 20
        reasons.append("PBR %.2f(>%.1f,還沒跌到便宜)" % (v, PBR_MID))

    # 外資連賣是「必要條件」而不只是加權,理由跟真漲的外資連買閘門對稱:
    # 分數夠但外資沒賣,不該標成真跌(可能只是融資戶自己在減碼)。
    streak = m.get("foreign_consecutive_sell_days")
    foreign_ok = streak is not None and streak >= FOREIGN_CONSECUTIVE
    passed = score >= REAL_CRASH_PASS and foreign_ok
    if score >= REAL_CRASH_PASS and not foreign_ok:
        reasons.append("分數達標但外資未連續賣超 %d 天,不列為真跌" % FOREIGN_CONSECUTIVE)

    return {
        "score": _clamp(score),
        "is_real_crash": passed,
        "foreign_gate_passed": foreign_ok,
        "reasons": reasons,
        "missing": missing,
    }


def judge_fake_crash(m):
    """
    虛跌判斷:融資斷頭式減倉造成的恐慌性錯殺,法人反而趁機承接,
    是 judge_fake_stock_rally() 的鏡射。回傳形狀跟它一致。
    """
    score = 0
    reasons = []
    missing = []

    v = m.get("margin_change_5d_pct")
    if v is None:
        missing.append("融資5日增幅")
    elif v < MARGIN_DROP_PANIC:
        score += 30
        reasons.append("融資5日增幅 %.1f%%(<%d%%,疑似斷頭/恐慌認賠殺出)"
                       % (v, MARGIN_DROP_PANIC))

    v = m.get("foreign_net")
    if v is None:
        missing.append("外資買賣超")
    elif v >= 0:
        score += 20
        reasons.append("外資買超或中性(%s 股),趁機承接" % format(int(v), ","))

    v = m.get("pbr")
    if v is None:
        missing.append("PBR")
    elif v < PBR_CRASH_CHEAP:
        score += 20
        reasons.append("PBR %.2f(<%.1f,評價已明顯偏低)" % (v, PBR_CRASH_CHEAP))

    vol, prev = m.get("volume"), m.get("prev_volume")
    if vol is None or prev is None:
        missing.append("成交量")
    elif vol < prev:
        score += 10
        reasons.append("今日量縮(%s → %s,賣壓漸緩)" % (format(int(prev), ","), format(int(vol), ",")))

    return {
        "score": _clamp(score),
        "is_fake_crash": score >= FAKE_CRASH_PASS,
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
        score += 10
        reasons.append("券資比 %.1f%%(<%d%%)" % (v, SHORT_MARGIN_BULL))

    v = m.get("foreign_net")
    if v is None:
        missing.append("外資買賣超")
    elif v < 0:
        score += 10
        reasons.append("外資賣超(%s 股)" % format(abs(int(v)), ","))

    return {"score": _clamp(score), "reasons": reasons, "missing": missing}


def judge_divergence(m):
    """
    背離訊號:外資賣超但投信買進。

    兩者方向相反時通常是投信短打(作帳、題材追價),不宜視為長線轉強,
    所以獨立成一個訊號,不併入真漲分數。
    """
    fn = m.get("foreign_net")
    tn = m.get("trust_net")
    if fn is None or tn is None:
        return {"is_divergence": False, "reason": "", "missing": ["法人買賣超"]}

    if fn < 0 and tn > 0:
        return {
            "is_divergence": True,
            "reason": "外資賣超 %s 股、投信買進 %s 股,方向背離,可能是投信短打"
                      % (format(abs(int(fn)), ","), format(int(tn), ",")),
            "missing": [],
        }
    return {"is_divergence": False, "reason": "", "missing": []}


# ---------------------------------------------------------------- 標記文字

def _lots(shares):
    """股數轉張數(1 張 = 1000 股)。"""
    return abs(shares) / 1000.0


def _money(amount):
    """金額轉易讀字串。這是用收盤價推估的,呼叫端會標「約」。"""
    a = abs(amount)
    if a >= 1e8:
        return "%.1f 億" % (a / 1e8)
    if a >= 1e4:
        return "%.0f 萬" % (a / 1e4)
    return "%.0f 元" % a


def _pct_clause(of_volume, of_market, market_label):
    parts = []
    if of_volume is not None:
        parts.append("佔該股成交量 %.1f%%" % of_volume)
    if of_market is not None:
        parts.append("佔全市場%s %.1f%%" % (market_label, of_market))
    return "、".join(parts)


def foreign_annotation(m):
    """
    外資連買/連賣的標記。資料不足時回傳 None,不硬湊。
    """
    days = m.get("foreign_streak_days")
    direction = m.get("foreign_streak_direction")
    if not days or direction not in ("buy", "sell"):
        return None

    verb = "連買" if direction == "buy" else "連賣"
    label = "外資買超" if direction == "buy" else "外資賣超"
    bits = ["外資%s %d 天" % (verb, days)]

    shares = m.get("foreign_streak_shares")
    if shares is not None:
        bits.append("總共 %s 張" % format(round(_lots(shares)), ","))
    amount = m.get("foreign_streak_amount")
    if amount is not None:
        bits.append("約 $%s" % _money(amount))

    pct = _pct_clause(m.get("foreign_pct_of_volume"),
                      m.get("foreign_pct_of_market"), label)
    if pct:
        bits.append(pct)
    bits.append("注意長線變化")
    return ",".join(bits)


def trust_annotation(m):
    """投信買進時的標記(賣超不標,依規格只在買進時提示)。"""
    net = m.get("trust_net")
    if net is None or net <= 0:
        return None

    bits = ["此股投信買進 %s 張" % format(round(_lots(net)), ",")]
    amount = m.get("trust_amount")
    if amount is not None:
        bits.append("約 $%s" % _money(amount))
    pct = _pct_clause(m.get("trust_pct_of_volume"),
                      m.get("trust_pct_of_market"), "投信買超")
    if pct:
        bits.append(pct)
    bits.append("注意可能是短打")
    return ",".join(bits)


def score_stock(stock_id, stock_name, m):
    """把三組判斷合成一筆輸出。"""
    real = judge_real_rally(m)
    fake = judge_fake_stock_rally(m)
    fomo = calculate_stock_fomo_score(m)
    diverge = judge_divergence(m)

    missing = []
    for part in (real, fake, fomo, diverge):
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
        "is_divergence": diverge["is_divergence"],
        "divergence_reason": diverge["reason"],
        "foreign_note": foreign_annotation(m),
        "trust_note": trust_annotation(m),
        "metrics": {
            "pbr": m.get("pbr"),
            "margin_change_5d_pct": (None if m.get("margin_change_5d_pct") is None
                                     else round(m["margin_change_5d_pct"], 2)),
            "short_margin_ratio": (None if m.get("short_margin_ratio") is None
                                   else round(m["short_margin_ratio"], 2)),
            "foreign_net": m.get("foreign_net"),
            "foreign_consecutive_buy_days": m.get("foreign_consecutive_buy_days"),
            "trust_net": m.get("trust_net"),
            "foreign_streak_days": m.get("foreign_streak_days"),
            "foreign_streak_direction": m.get("foreign_streak_direction"),
            "foreign_streak_shares": m.get("foreign_streak_shares"),
            "foreign_streak_amount": m.get("foreign_streak_amount"),
            "foreign_pct_of_volume": _round(m.get("foreign_pct_of_volume")),
            "foreign_pct_of_market": _round(m.get("foreign_pct_of_market")),
            "trust_amount": m.get("trust_amount"),
            "trust_pct_of_volume": _round(m.get("trust_pct_of_volume")),
            "trust_pct_of_market": _round(m.get("trust_pct_of_market")),
            "vol_ratio": m.get("vol_ratio"),
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


def score_stock_crash(stock_id, stock_name, m):
    """
    暴跌 FOMO 版本的 score_stock():用真跌/虛跌取代真漲/虛漲。
    背離(judge_divergence)是法人分歧訊號,方向無關,直接沿用同一份判斷。

    沒有另外做一個「暴跌綜合分數」——虛跌分數本身就是「這波下跌像不像
    散戶恐慌錯殺」的強度,拿來當主要排序/顯示分數(crash_score)就夠了,
    不重複發明一套跟虛跌高度重疊的指標。
    """
    real = judge_real_crash(m)
    fake = judge_fake_crash(m)
    diverge = judge_divergence(m)

    missing = []
    for part in (real, fake, diverge):
        for k in part["missing"]:
            if k not in missing:
                missing.append(k)

    return {
        "stock_id": stock_id,
        "stock_name": stock_name,
        "crash_score": fake["score"],
        "is_real_crash": real["is_real_crash"],
        "real_crash_score": real["score"],
        "is_fake_crash": fake["is_fake_crash"],
        "fake_crash_score": fake["score"],
        "is_divergence": diverge["is_divergence"],
        "divergence_reason": diverge["reason"],
        "foreign_note": foreign_annotation(m),
        "trust_note": trust_annotation(m),
        "metrics": {
            "pbr": m.get("pbr"),
            "margin_change_5d_pct": (None if m.get("margin_change_5d_pct") is None
                                     else round(m["margin_change_5d_pct"], 2)),
            "short_margin_ratio": (None if m.get("short_margin_ratio") is None
                                   else round(m["short_margin_ratio"], 2)),
            "foreign_net": m.get("foreign_net"),
            "foreign_consecutive_sell_days": m.get("foreign_consecutive_sell_days"),
            "trust_net": m.get("trust_net"),
            "foreign_streak_days": m.get("foreign_streak_days"),
            "foreign_streak_direction": m.get("foreign_streak_direction"),
            "foreign_streak_shares": m.get("foreign_streak_shares"),
            "foreign_streak_amount": m.get("foreign_streak_amount"),
            "foreign_pct_of_volume": _round(m.get("foreign_pct_of_volume")),
            "foreign_pct_of_market": _round(m.get("foreign_pct_of_market")),
            "trust_amount": m.get("trust_amount"),
            "trust_pct_of_volume": _round(m.get("trust_pct_of_volume")),
            "trust_pct_of_market": _round(m.get("trust_pct_of_market")),
            "vol_ratio": m.get("vol_ratio"),
            "close": m.get("close"),
            "volume": m.get("volume"),
            "prev_volume": m.get("prev_volume"),
        },
        "reasons": {
            "real_crash": real["reasons"],
            "fake_crash": fake["reasons"],
        },
        "missing": missing,
    }
