/**
 * GA-Hub 启动加载动画 —— 「银河开机 · 四旋臂演化」（依据 temp/galaxy_boot_animation_preview.html 方案）
 *
 * 编排（星系旋转匹配开机等待时间：稳态自转段无固定时长，持续到后端就绪信号）：
 *   第一幕 · 极速凝聚 (0~0.75s)：全屏弥漫星尘向四旋臂银河汇聚成型。
 *   稳态幕 · 银河自转 (0.75s ~ 就绪)：双段差速持续旋转；缠绕紧度 b 与镜头
 *             缩放以饱和曲线无限趋近终值——等待多久都保持自然演化不僵住。
 *   就绪幕 · 反向解旋扩散 (0.8s)：快照当前极坐标，逆向解开缠绕 + 径向膨胀
 *             + 弧臂切向扫掠，渐隐交接 GA-Hub 主界面。
 *
 * 结构设计（方案要点）：
 *   - 4 条主旋臂 90° 均匀对称，高斯正态（Box-Muller）法向羽化，无人工硬边界；
 *   - 三层明亮核球（深空弥散辉光 / 致密高亮核 / 超白核心）+ 十字耀斑；
 *   - 色彩：核心金白 → 旋臂冰蓝/天青 → 紫粉 H-II 星团点缀；
 *   - 就绪交接继承原 gahub-loader 协议（__GA_HUB_HIDE_LOADING__）。
 *
 * 低消耗设计：位置由时间参数确定性重算；爆发幕一次性快照；dpr ≤2；
 * visibilitychange 暂停；reduced-motion 静态降级；AUTO_HIDE 15s 兜底。
 */
(function () {
  'use strict'

  var IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!IS_TAURI || typeof document === 'undefined') return

  var MIN_DISPLAY_MS = 3200      // 凝聚 + 至少一段可观的自转
  var FADE_MS = 560
  var BURST_MS = 800             // 反向解旋扩散时长
  var AUTO_HIDE_MS = 15000       // 就绪信号缺失时的兜底
  var T_CONVERGE = 750           // 第一幕：极速凝聚

  /* ── 样式注入（深空主题） ─────────────────────────────────────── */
  var style = document.createElement('style')
  style.textContent =
    '#ga-hub-boot{position:fixed;inset:0;z-index:9999;overflow:hidden;' +
    'transition:opacity ' + FADE_MS + 'ms cubic-bezier(0.4,0,0.2,1);' +
    'background:#02040a;' +
    'background-image:radial-gradient(circle at center,#090e21 0%,#030611 70%,#010206 100%);}' +
    '#ga-hub-boot canvas{position:absolute;inset:0;display:block;width:100%;height:100%;}' +
    '#ga-hub-boot .boot-vignette{position:absolute;inset:0;pointer-events:none;' +
    'background:radial-gradient(circle at center,transparent 30%,rgba(1,2,6,0.85) 100%);' +
    'box-shadow:inset 0 0 120px rgba(0,0,0,0.95);}' +
    '#ga-hub-boot .boot-word{position:absolute;top:50%;left:50%;transform:translate(-50%,-58%);' +
    'font:700 clamp(40px,9vw,120px)/1 Inter,"Segoe UI",system-ui,sans-serif;' +
    'letter-spacing:0.14em;color:#f8fafc;display:none;}' +
    '#ga-hub-boot .boot-caption{position:absolute;left:0;right:0;bottom:9%;text-align:center;' +
    'font:400 12px Inter,"Segoe UI",system-ui,sans-serif;letter-spacing:0.26em;' +
    'color:#64748b;opacity:0;animation:ga-boot-caption-in 0.9s ease 0.9s forwards;}' +
    '@keyframes ga-boot-caption-in{to{opacity:1}}'
  document.head.appendChild(style)

  var root = document.createElement('div')
  root.id = 'ga-hub-boot'
  root.setAttribute('aria-hidden', 'true')
  root.innerHTML =
    '<canvas></canvas>' +
    '<div class="boot-vignette"></div>' +
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

  /* ── 隐藏协议（与旧版完全一致） ───────────────────────────────── */
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
        // 静态降级（reduced-motion / 无 Canvas）或渲染循环已停：直接淡出移除。
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

  // 产品决策：prefers-reduced-motion 不再切换静态占位。开机画面仅数秒，
  // 而 Windows「动画效果=关」（新装机/OEM 默认）、节电模式、远程会话都会
  // 误报 reduce，导致银河开场整段缺失、被用户当成故障。只有 canvas 2D
  // 上下文真正不可用（无法渲染）才降级静态兜底。
  if (!ctx) { useStaticFallback(); return }

  /* ── 缓动与工具 ──────────────────────────────────────────────── */
  function easeInOutCubic(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2 }
  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3) }
  function easeOutQuint(p) { return 1 - Math.pow(1 - p, 5) }
  function clamp(v, min, max) { return Math.min(Math.max(v, min), max) }
  function gaussianRandom() {
    var u = 0, v = 0
    while (u === 0) u = Math.random()
    while (v === 0) v = Math.random()
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
  }
  /* 饱和曲线：稳态幕时长不定，缠绕/缩放无限趋近终值而不僵死 */
  function saturate(tMs, tau) { return 1 - Math.exp(-tMs / tau) }

  /* ── 四旋臂银河粒子构建 ──────────────────────────────────────── */
  function particleBudget() {
    var f = (W * H) / (1280 * 800)
    return Math.round(clamp(3200 * f, 2400, 3600))
  }

  function buildGalaxy() {
    var count = particleBudget()
    particles = new Array(count)
    var maxR = Math.min(W, H) * 0.46
    var rRef = Math.min(W, H) * 0.22

    for (var i = 0; i < count; i++) {
      // 初始弥漫全屏位置（t=0）
      var spreadAng = Math.random() * Math.PI * 2
      var spreadDist = Math.pow(Math.random(), 0.55) * Math.max(W, H) * 0.72
      var initX = cx + Math.cos(spreadAng) * spreadDist + (Math.random() - 0.5) * 80
      var initY = cy + Math.sin(spreadAng) * spreadDist + (Math.random() - 0.5) * 80

      // 4 条主旋臂：严格 4 等分，每臂相位 90°
      var armIdx = i % 4
      var armBaseAngle = armIdx * (Math.PI / 2)

      // 半径分布（近核 0.05 → 远端 1.0）
      var normDist = 0.05 + Math.pow(Math.random(), 1.15) * 0.95
      var targetR = normDist * maxR

      // 高斯物理展宽：旋臂法向的物理扩散（中段最宽，两端自然收束）
      var sigmaPx = Math.min(W, H) * (0.024 + 0.038 * Math.sin(normDist * Math.PI))
      var lateralOffset = gaussianRandom() * sigmaPx

      // 色彩：核心致密暖白恒星、旋臂冰蓝/天青、紫粉 H-II 星团与暗尘埃
      var colorPick = Math.random()
      var color, size, glow = false
      if (normDist < 0.22) {
        color = colorPick < 0.65 ? '#fff6e0' : (colorPick < 0.88 ? '#fef4c0' : '#a5c8e8')
        size = 0.5 + Math.random() * 0.8
      } else {
        if (colorPick < 0.52) {
          color = '#60a5fa'; size = 0.45 + Math.random() * 0.75
        } else if (colorPick < 0.76) {
          color = '#93c5fd'; size = 0.55 + Math.random() * 0.9
          glow = Math.random() < 0.22
        } else if (colorPick < 0.88) {
          color = '#c084fc'; size = 0.65 + Math.random() * 1.0
          glow = true
        } else {
          color = '#38bdf8'; size = 0.4 + Math.random() * 0.65
        }
      }

      // 扩散参数（反向解旋圈数：内圈多外圈少，封顶防散架）
      var wind = 2 * Math.PI * (0.65 + 1.35 * Math.pow(rRef / Math.max(targetR, 12), 0.7))
      if (wind > 2 * Math.PI * 2.2) wind = 2 * Math.PI * 2.2

      particles[i] = {
        initX: initX, initY: initY,
        targetR: targetR, normDist: normDist,
        armBaseAngle: armBaseAngle,
        lateralOffset: lateralOffset,
        currentR: targetR, currentTheta: armBaseAngle,
        color: color, size: size, glow: glow,
        alpha: normDist < 0.22 ? (0.36 + Math.random() * 0.42) : (0.45 + Math.random() * 0.55),
        phi: Math.random() * Math.PI * 2,
        snapR: 0, snapTheta: 0,
        wind: wind,
        unbias: 0.85 + Math.random() * 0.35,
        outR: Math.min(W, H) * (0.52 + Math.random() * 0.48),
        tanK: 0.9 + Math.random() * 0.6,
      }
    }
  }

  /* ── 渲染循环 ────────────────────────────────────────────────── */
  function drawCore(coreIntensity) {
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    // A. 外围深空弥散辉光（柔）
    var rOuter = Math.min(W, H) * (0.28 + 0.05 * Math.sin(performance.now() * 0.003))
    var g1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, rOuter)
    g1.addColorStop(0, 'rgba(147,197,253,' + (0.38 * coreIntensity) + ')')
    g1.addColorStop(0.25, 'rgba(96,165,250,' + (0.24 * coreIntensity) + ')')
    g1.addColorStop(0.65, 'rgba(59,130,246,' + (0.08 * coreIntensity) + ')')
    g1.addColorStop(1, 'rgba(59,130,246,0)')
    ctx.fillStyle = g1
    ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, 6.283185); ctx.fill()
    // B. 中层核球（暖白，峰值压到 0.5，过渡带加宽）
    var rMid = Math.min(W, H) * 0.09
    var g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMid)
    g2.addColorStop(0, 'rgba(255,244,214,' + (0.5 * coreIntensity) + ')')
    g2.addColorStop(0.35, 'rgba(254,232,160,' + (0.4 * coreIntensity) + ')')
    g2.addColorStop(0.7, 'rgba(147,197,253,' + (0.2 * coreIntensity) + ')')
    g2.addColorStop(1, 'rgba(147,197,253,0)')
    ctx.fillStyle = g2
    ctx.beginPath(); ctx.arc(cx, cy, rMid, 0, 6.283185); ctx.fill()
    // C. 中心亮核（暖奶油白，峰值 0.5，平滑双段衰减）
    var rCore = Math.min(W, H) * 0.026
    var g3 = ctx.createRadialGradient(cx, cy, 0, cx, cy, rCore)
    g3.addColorStop(0, 'rgba(255,248,228,' + (0.5 * coreIntensity) + ')')
    g3.addColorStop(0.55, 'rgba(255,240,200,' + (0.35 * coreIntensity) + ')')
    g3.addColorStop(1, 'rgba(254,232,160,0)')
    ctx.fillStyle = g3
    ctx.beginPath(); ctx.arc(cx, cy, rCore, 0, 6.283185); ctx.fill()
    // D. 十字耀斑微光（减半：0.28，更短更细）
    var flareLen = Math.min(W, H) * 0.11 * coreIntensity
    var fa = 0.28 * coreIntensity
    var gx = ctx.createLinearGradient(cx - flareLen, cy, cx + flareLen, cy)
    gx.addColorStop(0, 'rgba(255,244,214,0)')
    gx.addColorStop(0.5, 'rgba(255,244,214,' + fa + ')')
    gx.addColorStop(1, 'rgba(255,244,214,0)')
    ctx.fillStyle = gx
    ctx.fillRect(cx - flareLen, cy - 0.8, flareLen * 2, 1.6)
    var gy = ctx.createLinearGradient(cx, cy - flareLen, cx, cy + flareLen)
    gy.addColorStop(0, 'rgba(255,244,214,0)')
    gy.addColorStop(0.5, 'rgba(255,244,214,' + fa + ')')
    gy.addColorStop(1, 'rgba(255,244,214,0)')
    ctx.fillStyle = gy
    ctx.fillRect(cx - 0.8, cy - flareLen, 1.6, flareLen * 2)
    ctx.restore()
  }

  function frame(now) {
    if (!running) return
    var t = now - startedAt
    var burstK = bursting ? clamp((now - burstStart) / BURST_MS, 0, 1) : 0

    ctx.clearRect(0, 0, W, H)

    var convergeK = clamp(t / T_CONVERGE, 0, 1)
    var easeConverge = easeOutCubic(convergeK)
    var holdT = Math.max(0, t - T_CONVERGE)

    // 镜头缩放 0.82 → 1.08（饱和趋近），爆发时再前推
    var zoom = 0.82 + 0.26 * saturate(t, 1900)
    if (bursting) zoom += easeOutQuint(burstK) * 0.35

    // 缠绕紧度 b：1.8 → 4.2（饱和趋近，等待期间持续缓慢演化）
    var currentTightness = 1.8 + 2.4 * saturate(t, 1500)

    // 全局逆时针自转（持续到扩散开始）
    var globalRotation = -(t * 0.001) * 1.35

    // 核心强度
    var coreIntensity = (0.35 + 0.65 * easeConverge) * (1 - (bursting ? burstK * 0.85 : 0))

    // 爆发快照（首帧记录当前极坐标）
    if (bursting && !snapshotted) {
      for (var si = 0; si < particles.length; si++) {
        var sp = particles[si]
        sp.snapR = sp.currentR
        sp.snapTheta = sp.currentTheta
      }
      snapshotted = true
    }

    drawCore(coreIntensity)

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i]
      var px, py, finalAlpha = p.alpha

      if (!bursting) {
        // 第一/二幕：凝聚 + 逆时针自转 + 对数螺线逐渐紧密缠绕
        var spineAngle = p.armBaseAngle + currentTightness * Math.log(p.normDist + 0.15) + globalRotation
        var spineR = p.targetR * zoom
        var spineX = cx + Math.cos(spineAngle) * spineR
        var spineY = cy + Math.sin(spineAngle) * spineR
        var normalAngle = spineAngle + Math.PI / 2
        var targetX = spineX + Math.cos(normalAngle) * (p.lateralOffset * zoom)
        var targetY = spineY + Math.sin(normalAngle) * (p.lateralOffset * zoom)

        p.currentR = Math.sqrt(Math.pow(targetX - cx, 2) + Math.pow(targetY - cy, 2)) / zoom
        p.currentTheta = Math.atan2(targetY - cy, targetX - cx)

        var startX = p.initX + Math.sin(t * 0.002 + i) * 10
        var startY = p.initY + Math.cos(t * 0.0018 + i) * 10
        px = startX + (targetX - startX) * easeConverge
        py = startY + (targetY - startY) * easeConverge

        finalAlpha = p.alpha * (0.35 + 0.65 * easeConverge) *
          (0.85 + 0.15 * Math.sin(t * 0.003 + p.phi))
      } else {
        // 就绪幕：反向解旋 + 径向扩散 + 切向弧臂拖尾
        var g = easeInOutCubic(burstK)
        var gu = easeOutCubic(burstK)
        var unwrapAngle = p.snapTheta - p.wind * 0.55 * p.unbias * gu
        var radialDist = p.snapR + (p.outR + 60 - p.snapR) * g
        px = cx + Math.cos(unwrapAngle) * (radialDist * zoom)
        py = cy + Math.sin(unwrapAngle) * (radialDist * zoom)
        var tx = -Math.sin(unwrapAngle), ty = Math.cos(unwrapAngle)
        px += tx * p.tanK * 32 * gu
        py += ty * p.tanK * 32 * gu
        var fadeK = burstK < 0.4 ? 1 : Math.pow(1 - (burstK - 0.4) / 0.6, 1.2)
        finalAlpha = p.alpha * fadeK
      }

      if (finalAlpha > 0.02) {
        ctx.globalAlpha = clamp(finalAlpha, 0, 1)
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(px, py, p.size, 0, 6.283185)
        ctx.fill()

        if (p.glow && easeConverge > 0.5 && !bursting) {
          ctx.globalAlpha = clamp(finalAlpha * 0.3, 0, 1)
          ctx.beginPath()
          ctx.arc(px, py, p.size * 2.4, 0, 6.283185)
          ctx.fill()
        }
      }
    }

    ctx.restore()
    rafId = requestAnimationFrame(frame)
  }

  /* ── 尺寸与启动 ──────────────────────────────────────────────── */
  var resizeTimer = null
  function onResize() {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(function () {
      resizeCanvas()
      buildGalaxy()
    }, 180)
  }

  function resizeCanvas() {
    W = window.innerWidth
    H = window.innerHeight
    var dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(W * dpr)
    canvas.height = Math.floor(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cx = W / 2
    cy = H / 2
  }

  resizeCanvas()
  buildGalaxy()
  running = true
  rafId = requestAnimationFrame(frame)

  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) teardown()
    else if (!hidden) { running = true; rafId = requestAnimationFrame(frame) }
  })
})()
