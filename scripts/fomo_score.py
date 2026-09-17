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
MARGIN_CONSECUTIVE = 3       # 融資連續買超(散戶連續進場)天數門檻——2026-09-10 使用者
                             # 要求:「真漲」不能只看外資,散戶融資也要連續進場才算,
                             # 顯示文字因此從「真漲」改成「可能會漲」(較保守的講法,
                             # 沒有宣稱一定會漲)。程式內部欄位名稱維持 real_rally,
                             # 避免牽動太多既有程式碼跟已經存出去的資料欄位。

REAL_RALLY_PASS = 60         # 真漲(顯示文字:可能會漲)成立分數
FAKE_RALLY_PASS = 60         # 虛漲成立分數

# --- 2026-09-17 使用者要求的寬鬆版「可能會漲😝/虛漲😝」---
# 跟上面 judge_real_rally()/judge_fake_stock_rally() 平行、獨立存在的第二組
# 判斷,不是取代:門檻放寬(連續天數 3→2、融資5日增幅 15%→10%、PBR 2.5→2.0),
# 拿掉券資比/外資買賣超這些加分項,只留最少的必要條件湊滿 60 分,想看看
# 放寬之後樣本會不會變多、命中率會不會因此變差——兩組判斷各自累積歷史命中率
# (訊號記分板的 fomo_real/fomo_fake 跟 fomo_real_loose/fomo_fake_loose 分開看),
# 不能混在一起比較。
FOREIGN_CONSECUTIVE_LOOSE = 2   # 外資連續買超天數門檻(寬鬆版)
MARGIN_CONSECUTIVE_LOOSE = 2    # 融資連續買超天數門檻(寬鬆版)
PBR_LOOSE_HIGH = 2.0            # 虛漲😝:股價淨值比偏高門檻(寬鬆版,比 PBR_HIGH 低)
REAL_RALLY_LOOSE_PASS = 60      # 可能會漲😝 成立分數
FAKE_RALLY_LOOSE_PASS = 60      # 虛漲😝 成立分數

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
    "MARGIN_CONSECUTIVE": MARGIN_CONSECUTIVE,
    "REAL_RALLY_PASS": REAL_RALLY_PASS,
    "FAKE_RALLY_PASS": FAKE_RALLY_PASS,
    "REAL_RALLY_REQUIRES_FOREIGN": True,
    "REAL_RALLY_REQUIRES_MARGIN": True,
    "FOREIGN_CONSECUTIVE_LOOSE": FOREIGN_CONSECUTIVE_LOOSE,
    "MARGIN_CONSECUTIVE_LOOSE": MARGIN_CONSECUTIVE_LOOSE,
    "PBR_LOOSE_HIGH": PBR_LOOSE_HIGH,
    "REAL_RALLY_LOOSE_PASS": REAL_RALLY_LOOSE_PASS,
    "FAKE_RALLY_LOOSE_PASS": FAKE_RALLY_LOOSE_PASS,
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
    「可能會漲」判斷(原本叫「真漲」,2026-09-10 使用者要求改掉判斷邏輯跟顯示
    文字)。舊版邏輯是「外資買、且散戶沒有追價」;使用者認為這樣不夠——
    真的要漲,散戶融資也要跟著連續進場,只有外資悄悄買、散戶沒感覺,撐不住,
    所以把「融資5日增幅 <10%(散戶沒追價)」拿掉,改成「融資連續買超 ≥3天
    (散戶也連續進場)」,跟外資連續買超一樣當成必要條件。顯示文字也從「真漲」
    改成「可能會漲」,語氣上不再宣稱這是確定的事實,只是機率判斷。

    m 是 metrics dict;缺的欄位一律不給分,並記錄在 missing。
    回傳 {score, is_real_rally, reasons, missing}
    (欄位名稱維持 real_rally/is_real_rally,只有顯示文字改了,避免牽動太多
    既有程式碼跟已經存出去的 JSON 欄位)。
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

    v = m.get("margin_consecutive_buy_days")
    if v is None:
        missing.append("融資連續買超天數")
    elif v >= MARGIN_CONSECUTIVE:
        score += 20
        reasons.append("融資連續買超 %d 天(≥%d,散戶跟著進場)" % (v, MARGIN_CONSECUTIVE))

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

    # 外資連買、融資連買都是「必要條件」而不只是加權:任一邊沒進場,分數
    # 湊到 60 也不算「可能會漲」——外資連買代表法人認同,融資連買代表散戶
    # 也跟上,單靠一邊撐不住,這是這次改動的核心。
    foreign_streak = m.get("foreign_consecutive_buy_days")
    foreign_ok = foreign_streak is not None and foreign_streak >= FOREIGN_CONSECUTIVE
    margin_streak = m.get("margin_consecutive_buy_days")
    margin_ok = margin_streak is not None and margin_streak >= MARGIN_CONSECUTIVE
    passed = score >= REAL_RALLY_PASS and foreign_ok and margin_ok
    if score >= REAL_RALLY_PASS and not (foreign_ok and margin_ok):
        missing_gates = []
        if not foreign_ok:
            missing_gates.append("外資連續買超 %d 天" % FOREIGN_CONSECUTIVE)
        if not margin_ok:
            missing_gates.append("融資連續買超 %d 天" % MARGIN_CONSECUTIVE)
        reasons.append("分數達標但未同時滿足%s,不列為可能會漲" % "、".join(missing_gates))

    return {
        "score": _clamp(score),
        "is_real_rally": passed,
        "foreign_gate_passed": foreign_ok,
        "margin_gate_passed": margin_ok,
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


def judge_real_rally_loose(m):
    """
    「可能會漲😝」——judge_real_rally() 的寬鬆版,平行存在、不是取代。
    只留外資/融資連續買超兩個必要條件,門檻從 ≥3 天降到 ≥2 天,拿掉
    券資比、PBR 這兩個加分項。40+20=60 剛好等於門檻,結構上就必須兩個
    條件都成立才會過(不像原版還要另外寫必要條件檢查,因為原版加分項
    多,單靠外資+其中一項加分就可能湊到 60)。
    """
    score = 0
    reasons = []
    missing = []

    v = m.get("foreign_consecutive_buy_days")
    if v is None:
        missing.append("外資連續買超天數")
    elif v >= FOREIGN_CONSECUTIVE_LOOSE:
        score += 40
        reasons.append("外資連續買超 %d 天(≥%d,寬鬆版)" % (v, FOREIGN_CONSECUTIVE_LOOSE))

    v = m.get("margin_consecutive_buy_days")
    if v is None:
        missing.append("融資連續買超天數")
    elif v >= MARGIN_CONSECUTIVE_LOOSE:
        score += 20
        reasons.append("融資連續買超 %d 天(≥%d,散戶跟著進場,寬鬆版)" % (v, MARGIN_CONSECUTIVE_LOOSE))

    return {
        "score": _clamp(score),
        "is_real_rally_loose": score >= REAL_RALLY_LOOSE_PASS,
        "reasons": reasons,
        "missing": missing,
    }


def judge_fake_stock_rally_loose(m):
    """
    「虛漲😝」——judge_fake_stock_rally() 的寬鬆版,平行存在、不是取代。
    融資5日增幅門檻從 >15% 降到 >10%,PBR 門檻從 >2.5 降到 >2.0,拿掉
    外資買賣超這個加分項,只留融資增幅+PBR+今日量縮三項(30+20+10=60,
    三項都要成立才會過)。
    """
    score = 0
    reasons = []
    missing = []

    v = m.get("margin_change_5d_pct")
    if v is None:
        missing.append("融資5日增幅")
    elif v > MARGIN_CHANGE_NOTICE:
        score += 30
        reasons.append("融資5日增幅 %.1f%%(>%d%%,散戶追價明顯,寬鬆版)"
                       % (v, MARGIN_CHANGE_NOTICE))

    v = m.get("pbr")
    if v is None:
        missing.append("PBR")
    elif v > PBR_LOOSE_HIGH:
        score += 20
        reasons.append("PBR %.2f(>%.1f,評價偏高,寬鬆版)" % (v, PBR_LOOSE_HIGH))

    vol, prev = m.get("volume"), m.get("prev_volume")
    if vol is None or prev is None:
        missing.append("成交量")
    elif vol < prev:
        score += 10
        reasons.append("今日量縮(%s → %s)" % (format(int(prev), ","), format(int(vol), ",")))

    return {
        "score": _clamp(score),
        "is_fake_rally_loose": score >= FAKE_RALLY_LOOSE_PASS,
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
    real_loose = judge_real_rally_loose(m)
    fake_loose = judge_fake_stock_rally_loose(m)
    fomo = calculate_stock_fomo_score(m)
    diverge = judge_divergence(m)

    missing = []
    for part in (real, fake, real_loose, fake_loose, fomo, diverge):
        for k in part["missing"]:
            if k not in missing:
                missing.append(k)

    # 2026-09-17 使用者要求:「可能會漲」跟「虛漲」是兩個各自獨立打分的判斷,
    # 沒有互斥檢查——外資連買(可能會漲的必要條件)常常跟融資5日暴增(虛漲的
    # 加分項)同時出現,因為兩者都是在量「散戶/籌碼是不是在瘋狂追價」,只是
    # 用「連續天數」跟「5日累積%」兩把不同的尺量同一件事;PBR 對「可能會漲」
    # 只是加分項不是必要條件,分數已經靠外資+融資兩個必要條件湊滿也不會被
    # PBR 偏高卡住。使用者決定不做互斥(不強制二選一),只加一個衝突旗標,
    # 兩個判斷各自的 reasons 都留著給人自己判斷——不是「可能會漲」或「虛漲」
    # 錯了,是兩者本來就是從不同角度打分,同時成立時代表法人籌碼跟散戶
    # 行為/估值站在對立面,這本身就是值得注意的資訊,不該被合併掩蓋掉。
    conflict = bool(real["is_real_rally"] and fake["is_fake_rally"])
    # 2026-09-17 使用者要求的寬鬆版(😝),跟上面的 is_conflict 同一個道理:
    # 兩個放寬後的判斷各自獨立打分,沒有互斥檢查,只加衝突旗標。跟原版
    # is_conflict 是各自獨立的旗標,不會互相影響。
    conflict_loose = bool(real_loose["is_real_rally_loose"] and fake_loose["is_fake_rally_loose"])

    return {
        "stock_id": stock_id,
        "stock_name": stock_name,
        "fomo_score": fomo["score"],
        "is_real_rally": real["is_real_rally"],
        "real_rally_score": real["score"],
        "is_fake_rally": fake["is_fake_rally"],
        "fake_rally_score": fake["score"],
        "is_conflict": conflict,
        "is_real_rally_loose": real_loose["is_real_rally_loose"],
        "real_rally_loose_score": real_loose["score"],
        "is_fake_rally_loose": fake_loose["is_fake_rally_loose"],
        "fake_rally_loose_score": fake_loose["score"],
        "is_conflict_loose": conflict_loose,
        "is_divergence": diverge["is_divergence"],
        "divergence_reason": diverge["reason"],
        "foreign_note": foreign_annotation(m),
        "trust_note": trust_annotation(m),
        "metrics": {
            "pbr": m.get("pbr"),
            "per": m.get("per"),
            "margin_change_5d_pct": (None if m.get("margin_change_5d_pct") is None
                                     else round(m["margin_change_5d_pct"], 2)),
            "short_margin_ratio": (None if m.get("short_margin_ratio") is None
                                   else round(m["short_margin_ratio"], 2)),
            "foreign_net": m.get("foreign_net"),
            "foreign_consecutive_buy_days": m.get("foreign_consecutive_buy_days"),
            "margin_consecutive_buy_days": m.get("margin_consecutive_buy_days"),
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
            "real_rally_loose": real_loose["reasons"],
            "fake_rally_loose": fake_loose["reasons"],
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

    # 跟 score_stock() 的 is_conflict 同一個道理:真跌(外資連賣)跟虛跌
    # (融資斷頭式減倉)理論上是相反的判斷,但沒有互斥檢查,同時成立時只標記
    # 不強制二選一。
    conflict = bool(real["is_real_crash"] and fake["is_fake_crash"])

    return {
        "stock_id": stock_id,
        "stock_name": stock_name,
        "crash_score": fake["score"],
        "is_real_crash": real["is_real_crash"],
        "real_crash_score": real["score"],
        "is_fake_crash": fake["is_fake_crash"],
        "fake_crash_score": fake["score"],
        "is_conflict": conflict,
        "is_divergence": diverge["is_divergence"],
        "divergence_reason": diverge["reason"],
        "foreign_note": foreign_annotation(m),
        "trust_note": trust_annotation(m),
        "metrics": {
            "pbr": m.get("pbr"),
            "per": m.get("per"),
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
