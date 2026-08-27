/**
 * GA-Hub 启动加载动画 —— 「墨旋 · 吸纳与释放」（候选 F）
 *
 * 编排（无刚性整体旋转，杜绝眩晕；全部为差速缠绕的“流动”感）：
 *   第一幕 · 星散成印 (0~1.05s)：聚成「枢纽之印」。
 *   第二幕 · 漩涡缩小 (1.05~3.15s)：印章差速缠绕收拢——内圈缠得多、
 *             外圈缠得少，整体如墨涡吸入，缩至中心浓旋。
 *   待命态 · 墨涡缓旋：就绪前维持极慢的涡旋流动。
 *   就绪幕 · 星系散开：反向解旋（逆转缠绕方向），粒子沿弧形臂向外
 *             扩大飞散、渐隐——如星系旋臂展开，交接 GA-Hub 主界面。
 *
 * 低消耗设计：粒子 ≤900；位置由时间参数确定性重算（爆发幕一次性快照）；
 * 无连线层；dpr ≤1.5；visibilitychange 暂停；reduced-motion 静态降级。
 */
(function () {
  'use strict'

  var IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!IS_TAURI || typeof document === 'undefined') return

  var MIN_DISPLAY_MS = 3700      // 成印 + 漩涡收缩 + 一段缓旋
  var FADE_MS = 560
  var BURST_MS = 1700            // 星系散开时长
  var AUTO_HIDE_MS = 15000
  var T_CONV = 1050              // 第一幕
  var T_VORTEX = 2100            // 第二幕：漩涡缩小
  var HOLD_OMEGA = 0.16          // 待命缓旋角速度 rad/s

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      return v || fallback
    } catch (e) { return fallback }
  }

  var C = {
    bg: cssVar('--c-bg', '#DED6C5'),
    inkStrong: cssVar('--c-text', '#2C2418'),
    inkMuted: cssVar('--c-text-muted', '#665741'),
    accent: cssVar('--c-accent', '#8A6438'),
    faint: cssVar('--c-text-faint', '#86775F'),
  }

  /* ── 样式注入 ─────────────────────────────────────────────────── */
  var style = document.createElement('style')
  style.textContent =
    '#ga-hub-boot{position:fixed;inset:0;z-index:9999;overflow:hidden;' +
    'transition:opacity ' + FADE_MS + 'ms cubic-bezier(0.4,0,0.2,1);' +
    'background-color:' + C.bg + ';' +
    'background-image:linear-gradient(180deg,rgba(255,255,255,0.10),rgba(55,42,25,0.035)),' +
    'radial-gradient(rgba(80,60,35,0.045) 0.8px,transparent 0.9px);' +
    'background-size:auto,4px 4px;}' +
    '#ga-hub-boot .boot-grain{position:absolute;inset:0;pointer-events:none;opacity:0.22;' +
    'mix-blend-mode:multiply;' +
    "background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.72' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.36  0 0 0 0 0.28  0 0 0 0 0.18  0 0 0 0.65 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")," +
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='640' height='10'><rect width='100%25' height='1' y='3' fill='rgba(95,72,42,0.045)'/><rect width='100%25' height='1' y='8' fill='rgba(255,255,255,0.10)'/></svg>\");" +
    'background-size:220px 220px,640px 10px;background-repeat:repeat,repeat;}' +
    '#ga-hub-boot canvas{position:absolute;inset:0;display:block;width:100%;height:100%;}' +
    '#ga-hub-boot .boot-word{position:absolute;top:50%;left:50%;transform:translate(-50%,-58%);' +
    'font:700 clamp(40px,9vw,120px)/1 Inter,"PingFang SC","Noto Sans SC","Segoe UI",system-ui,sans-serif;' +
    'letter-spacing:0.06em;color:' + C.inkStrong + ';display:none;}' +
    '#ga-hub-boot .boot-caption{position:absolute;left:0;right:0;bottom:11%;text-align:center;' +
    'font:400 13px Inter,"PingFang SC","Noto Sans SC",system-ui,sans-serif;' +
    'letter-spacing:0.22em;color:' + C.faint + ';opacity:0;' +
    'animation:ga-boot-caption-in 0.9s ease 1.25s forwards;}'
  document.head.appendChild(style)

  var root = document.createElement('div')
  root.id = 'ga-hub-boot'
  root.setAttribute('aria-hidden', 'true')
  root.innerHTML =
    '<div class="boot-grain"></div>' +
    '<canvas></canvas>' +
    '<div class="boot-word">GA·HUB</div>' +
    '<div class="boot-caption">正在唤醒本地服务</div>'
  ;(document.body || document.documentElement).appendChild(root)

  var canvas = root.querySelector('canvas')
  var ctx = null
  try { ctx = canvas.getContext('2d') } catch (e) { ctx = null }

  var reducedMotion = false
  try {
    reducedMotion = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch (e) { /* keep false */ }

  function useStaticFallback() {
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas)
    var word = root.querySelector('.boot-word')
    if (word) {
      word.style.display = 'block'
      word.style.opacity = '0'
      word.style.transition = 'opacity 0.7s ease'
      requestAnimationFrame(function () { word.style.opacity = '1' })
    }
  }

  /* ── 隐藏协议 ─────────────────────────────────────────────────── */
  var hidden = false
  var startedAt = performance.now()
  var rafId = 0
  var running = false
  var bursting = false
  var burstStart = 0
  var snapshotted = false
  var particles = []
  var W = 0, H = 0, cx = 0, cy = 0

  function teardown() {
    running = false
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
  }

  function hideLoading() {
    if (hidden) return
    hidden = true
    var wait = Math.max(0, MIN_DISPLAY_MS - (performance.now() - startedAt))
    setTimeout(function () {
      if (bursting) return
      if (!running) {
        // 静态降级（reduced-motion / 无 Canvas）或渲染循环已停：
        // 没有粒子可爆发，直接淡出并移除遮罩，否则启动画面永不消失。
        root.style.pointerEvents = 'none'
        root.style.opacity = '0'
        setTimeout(function () {
          if (root.parentNode) root.parentNode.removeChild(root)
        }, FADE_MS + 80)
        return
      }
      bursting = true
      snapshotted = false
      burstStart = performance.now()
      root.style.pointerEvents = 'none'
      setTimeout(function () { root.style.opacity = '0' }, BURST_MS * 0.64)
      setTimeout(function () {
        teardown()
        if (root.parentNode) root.parentNode.removeChild(root)
      }, BURST_MS + FADE_MS + 80)
    }, wait)
  }
  window.__GA_HUB_HIDE_LOADING__ = hideLoading
  window.__GA_HUB_LOADING_READY__ = function () {}
  setTimeout(hideLoading, AUTO_HIDE_MS)

  if (!ctx || reducedMotion) { useStaticFallback(); return }

  /* ── 几何与粒子 ──────────────────────────────────────────────── */
  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim())
    if (!m) return { r: 44, g: 36, b: 24 }
    var n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }

  /* 四色墨：墨黑 / 松绿（侧栏同源）/ 秋金 / 印泥朱红 */
  var INKS = {
    black: { rgb: hexToRgb(C.inkStrong), r: 1.42, amp: 0.10 },
    green: { rgb: hexToRgb('#12382B'), r: 1.34, amp: 0.12 },
    gold: { rgb: hexToRgb('#9C7A2E'), r: 1.62, amp: 0.16 },
    red: { rgb: hexToRgb('#A23B2A'), r: 1.54, amp: 0.14 },
  }

  function pickInk(i) {
    var r = Math.random()
    if (r < 0.52) return INKS.black
    if (r < 0.74) return INKS.green
    if (r < 0.92) return INKS.gold
    return INKS.red
  }

  function particleBudget() {
    var f = (W * H) / (1280 * 800)
    return Math.round(Math.max(520, Math.min(900, 780 * f)))
  }

  function buildSealTargets(count) {
    var m = Math.min(W, H)
    var rHub = m * 0.085
    var rOut = m * 0.205
    var rOrb = rOut + m * 0.028
    var pts = []
    var i, a, r
    for (i = 0; i < 46; i++) {
      a = (i / 46) * Math.PI * 2
      pts.push({ x: cx + Math.cos(a) * rHub, y: cy + Math.sin(a) * rHub })
    }
    for (var s = 0; s < 8; s++) {
      a = (s / 8) * Math.PI * 2 - Math.PI / 2 + 0.18
      for (i = 0; i < 13; i++) {
        r = rHub * 1.25 + (rOut - rHub * 1.25) * (i / 12)
        pts.push({
          x: cx + Math.cos(a) * r + (Math.random() - 0.5) * 3,
          y: cy + Math.sin(a) * r + (Math.random() - 0.5) * 3,
        })
      }
    }
    for (i = 0; i < 96; i++) {
      a = (i / 96) * Math.PI * 2
      r = rOrb + (i % 2 ? m * 0.007 : 0)
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
    }
    for (i = 0; i < 6; i++) {
      a = (i / 6) * Math.PI * 2 + 0.31
      r = rOrb + m * 0.022
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, star: true })
    }
    while (pts.length < count) {
      a = Math.random() * Math.PI * 2
      r = rOrb * (1.04 + Math.random() * 0.38)
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, dust: true })
    }
    return pts.slice(0, count)
  }

  function buildParticles() {
    var count = particleBudget()
    var seal = buildSealTargets(count)
    var ringR = Math.max(W, H) * (0.48 + Math.random() * 0.1)
    var m = Math.min(W, H)
    var rRef = m * 0.16           // 缠绕量参考半径（内多外少的基准）
    particles = new Array(count)
    for (var i = 0; i < count; i++) {
      var ang = Math.random() * Math.PI * 2
      var rr = ringR * (0.72 + Math.random() * 0.5)
      // 轨道星以金为主、偶发朱红；其余按四色配比
      var ink = seal[i].star
        ? (Math.random() < 0.22 ? INKS.red : INKS.gold)
        : pickInk(i)
      var szMul = seal[i].star ? 1.85 : (seal[i].dust ? 0.72 : 1)
      // 尺寸随机：多数中小，少数大墨点（对数偏移）
      var sj = Math.random()
      var sizeJitter = sj < 0.06
        ? 1.9 + Math.random() * 0.8          // ~6% 大墨 blot
        : 0.62 + Math.pow(Math.random(), 1.4) * 0.95
      // 印章极坐标（相对中心）
      var dx = seal[i].x - cx, dy = seal[i].y - cy
      var pr = Math.sqrt(dx * dx + dy * dy) || 1
      var pa = Math.atan2(dy, dx)
      // 差速缠绕量：内圈最多 ~1.7 圈，外圈 ~0.45 圈
      var wind = 2 * Math.PI * (0.45 + 1.25 * Math.pow(rRef / pr, 0.75))
      if (wind > 2 * Math.PI * 1.75) wind = 2 * Math.PI * 1.75
      particles[i] = {
        ox: cx + Math.cos(ang) * rr,
        oy: cy + Math.sin(ang) * rr,
        pr: pr, pa: pa,
        wind: wind,
        shrink: 0.24 + Math.random() * 0.10,   // 收缩后剩余半径比例 24~34%
        d1: Math.random() * 0.36 * T_CONV,
        u1: T_CONV * (0.8 + Math.random() * 0.4),
        dv: Math.random() * 0.30 * T_VORTEX,   // 漩涡错峰
        uv: T_VORTEX * (0.62 + Math.random() * 0.26),
        phi: Math.random() * Math.PI * 2,
        r: ink.r * szMul * sizeJitter,
        ink: ink,
        // 爆发快照（首次爆发帧填写）
        br: 0, ba: 0,
        outR: m * (0.42 + Math.random() * 0.42),
        tanK: 0.85 + Math.random() * 0.5,      // 星系弧臂切向强度
        unbias: 0.9 + Math.random() * 0.25,    // 反向解旋圈数个体差
      }
    }
  }

  /* 缓动 */
  function easeOutQuint(p) { return 1 - Math.pow(1 - p, 5) }
  function easeInOutCubic(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2 }
  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3) }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }

  /* 待命期追加的缓旋角（全局一致，个体经 diffFactor 差速化） */
  function holdExtra(t) {
    var tau = t - T_CONV - T_VORTEX
    return tau > 0 ? HOLD_OMEGA * tau : 0
  }

  var tmp = { x: 0, y: 0, a: 0 }

  /* 待命/加载期的确定性位置 */
  function calmPos(p, t, out) {
    var k1 = easeOutQuint(clamp01((t - p.d1) / p.u1))
    var a = clamp01(k1 * 1.7)
    var tauV = t - T_CONV - p.dv
    var kl = tauV <= 0 ? 0 : easeInOutCubic(clamp01(tauV / p.uv))
    var kgDone = t - T_CONV >= T_VORTEX
    // 半径：印章半径 → 收缩半径（就绪待命期带轻微呼吸）
    var rNow = p.pr * (1 - (1 - p.shrink) * kl)
    if (kl >= 1) rNow *= 1 + 0.035 * Math.sin(t * 0.0019 + p.phi)
    // 角度：印章角 − 差速缠绕（顺时针吸入）− 待命缓旋（差速化）
    var diffFactor = Math.pow((p.pr * p.shrink + 14) / (p.pr + 14), 0.6)
    var angWound = p.pa - p.wind * kl -
      (kgDone ? holdExtra(t) * (0.45 + 0.55 * diffFactor) : 0)
    var x = cx + Math.cos(angWound) * rNow
    var y = cy + Math.sin(angWound) * rNow
    // 第一幕尚在飞行时从起点混入
    if (k1 < 1) {
      x = p.ox + (x - p.ox) * k1
      y = p.oy + (y - p.oy) * k1
    }
    out.x = x; out.y = y; out.a = a
  }

  /* ── 渲染循环 ────────────────────────────────────────────────── */
  function drawDot(x, y, r, ink, a) {
    ctx.globalAlpha = a < 0 ? 0 : a > 1 ? 1 : a
    ctx.fillStyle = 'rgb(' + ink.rgb.r + ',' + ink.rgb.g + ',' + ink.rgb.b + ')'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 6.283185)
    ctx.fill()
  }

  function frame(now) {
    if (!running) return
    var t = now - startedAt
    ctx.clearRect(0, 0, W, H)
    var burstK = bursting ? clamp01((now - burstStart) / BURST_MS) : 0

    if (bursting && !snapshotted) {
      // 快照当前极坐标，作为反向解旋的起点
      for (var si = 0; si < particles.length; si++) {
        var sp = particles[si]
        calmPos(sp, t, tmp)
        var rdx = tmp.x - cx, rdy = tmp.y - cy
        sp.br = Math.sqrt(rdx * rdx + rdy * rdy) || 1
        sp.ba = Math.atan2(rdy, rdx)
      }
      snapshotted = true
    }

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i]
      var x, y, a
      if (!bursting) {
        calmPos(p, t, tmp)
        x = tmp.x; y = tmp.y; a = tmp.a
        if (t > T_CONV) {
          a = 0.86 + p.ink.amp * Math.sin(t * 0.0024 + p.phi)
        }
      } else {
        // 反向解旋 + 星系式扩大
        var g = easeInOutCubic(burstK)
        var gu = easeOutCubic(burstK)
        var ang = p.ba + p.wind * 0.55 * p.unbias * gu   // 正号 = 反向解旋
        var rr2 = p.br + (p.outR + 60 - p.br) * g
        x = cx + Math.cos(ang) * rr2
        y = cy + Math.sin(ang) * rr2
        // 切向拖尾偏移制造弧臂感：位置沿切向前推一点
        var tx = -Math.sin(ang), ty = Math.cos(ang)
        x += tx * p.tanK * 26 * gu
        y += ty * p.tanK * 26 * gu
        a = (0.86 + p.ink.amp * Math.sin(now * 0.0024 + p.phi)) *
            (burstK < 0.5 ? 1 : Math.pow(1 - (burstK - 0.5) / 0.5, 1.2))
      }
      drawDot(x, y, p.r, p.ink, a)
    }
    rafId = requestAnimationFrame(frame)
  }

  /* ── 尺寸与启动 ──────────────────────────────────────────────── */
  var resizeTimer = null
  function onResize() {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(function () {
      resizeCanvas()
      buildParticles()
    }, 180)
  }

  function resizeCanvas() {
    W = window.innerWidth
    H = window.innerHeight
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    canvas.width = Math.floor(W * dpr)
    canvas.height = Math.floor(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cx = W / 2
    cy = H / 2
  }

  resizeCanvas()
  buildParticles()
  running = true
  rafId = requestAnimationFrame(frame)

  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) teardown()
    else if (!hidden) { running = true; rafId = requestAnimationFrame(frame) }
  })
})()
