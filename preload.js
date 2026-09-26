'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bpcs', {
  getInfo: () => ipcRenderer.invoke('bpcs:get-info'),
  retry: () => ipcRenderer.send('bpcs:retry'),
})

/**
 * 长列表分页器（壳层注入，不改上游前端）
 *
 * 上游的上传/下载/转存等页面是一次性渲染全部任务的，任务多时会非常卡。
 * 这里在 DOM 层把超过阈值的列表切成页：隐藏非当前页的行，并注入一个
 * 底部悬浮分页条。Vue 对隐藏行仍会做数据修补，但布局/绘制被跳过，
 * 卡顿主要来源即被消除。上游将来若自带分页（列表变短），这里会自动失效。
 */
;(function listPaginator() {
  if (!/^https?:$/.test(location.protocol)) return // 只在上游页面里生效，跳过 loading/error 本地页

  const PAGE_SIZES = [100, 200, 500, 0] // 0 = 不限
  const CSS = `
#bpcs-pager{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:4000;
  display:none;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;
  background:rgba(23,29,42,.95);border:1px solid rgba(255,255,255,.14);color:#d7e0f2;
  font:12px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none}
#bpcs-pager button{all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;font-size:14px;line-height:1.4}
#bpcs-pager button:hover{background:rgba(255,255,255,.12)}
#bpcs-pager button:disabled{opacity:.3;cursor:default;background:none}
#bpcs-pager select{all:unset;cursor:pointer;color:#d7e0f2;background:rgba(255,255,255,.08);
  border-radius:6px;padding:2px 6px;font-size:12px}
#bpcs-pager select option{background:#1c2434;color:#d7e0f2}
#bpcs-pager .info{opacity:.7;white-space:nowrap}
#bpcs-pager .page{min-width:48px;text-align:center}
/* 渲染优化：视口外的卡片/行跳过布局与绘制（分页阈值内也生效） */
.task-card,.config-card,.run-item{content-visibility:auto;contain-intrinsic-size:auto 92px}
.el-table__row{content-visibility:auto;contain-intrinsic-size:auto 44px}
.file-list .file-item{content-visibility:auto;contain-intrinsic-size:auto 56px}
/* 分页：容器激活后，未命中当前页的行一律隐藏（新插入的行默认隐藏，避免闪一下整表） */
.bpcs-paginated > .task-card:not(.bpcs-show),
.bpcs-paginated > tbody > tr.el-table__row:not(.bpcs-show),
.bpcs-paginated > tr.el-table__row:not(.bpcs-show){display:none!important}
`

  // 各页面的列表容器与行元素（依据上游 v2.2.4 前端实际类名；rowOf 用直接子代
  // 匹配，避免把下载卡片里嵌套的 subtask 卡片误当成顶层任务）
  const TARGETS = [
    { id: 'downloads', label: '下载', sel: '.downloads-container .task-list', row: ':scope > .task-card' },
    { id: 'uploads', label: '上传', sel: '.uploads-container .task-list', row: ':scope > .task-card' },
    { id: 'transfers', label: '转存', sel: '.transfers-container .task-list', row: ':scope > .task-card' },
    { id: 'cloud-dl', label: '云下载', sel: '.cloud-dl-view .task-cards', row: ':scope > .task-card' },
    {
      id: 'files', label: '文件', sel: '.files-container .el-table__body',
      row: 'tr.el-table__row', table: true, // el-table 的行不是直接子代，按后代取再过滤
    },
    { id: 'cloud-dl-files', label: '云下载明细', sel: '.cloud-dl-view .el-table__body', row: 'tr.el-table__row', table: true },
  ]

  const stateOf = (id) => {
    if (!stateOf.m) stateOf.m = new Map()
    let s = stateOf.m.get(id)
    if (!s) {
      s = { page: 1, size: Number(localStorage.getItem('bpcs-pager-size') || 100) || 100 }
      stateOf.m.set(id, s)
    }
    return s
  }

  const debounce = (fn, ms) => {
    let t = 0
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
  }

  let bar = null
  function ensureBar() {
    if (bar) return bar
    bar = document.createElement('div')
    bar.id = 'bpcs-pager'
    bar.innerHTML =
      '<span class="info"></span>' +
      '<button data-act="first" title="首页">&laquo;</button>' +
      '<button data-act="prev" title="上一页">&lsaquo;</button>' +
      '<span class="page"></span>' +
      '<button data-act="next" title="下一页">&rsaquo;</button>' +
      '<button data-act="last" title="末页">&raquo;</button>' +
      '<select title="每页条数">' +
      PAGE_SIZES.map((s) => `<option value="${s}">${s === 0 ? '不限' : s + ' 条/页'}</option>`).join('') +
      '</select>'
    bar.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act
      if (!act || !bar._ctx) return
      const { st, pages } = bar._ctx
      if (act === 'first') st.page = 1
      if (act === 'prev') st.page -= 1
      if (act === 'next') st.page += 1
      if (act === 'last') st.page = pages
      pass()
    })
    bar.querySelector('select').addEventListener('change', (e) => {
      const size = Number(e.target.value)
      for (const s of stateOf.m?.values() || []) { s.size = size; s.page = 1 }
      localStorage.setItem('bpcs-pager-size', String(size))
      pass()
    })
    document.body.appendChild(bar)
    return bar
  }

  function rowsOf(target, container) {
    if (target.table) {
      return [...container.querySelectorAll(target.row)].filter((r) => r.closest('.el-table__body') === container)
    }
    return [...container.querySelectorAll(target.row)]
  }

  function updateBar(target, st, total, pages) {
    const b = ensureBar()
    b._ctx = { st, pages }
    b.querySelector('.info').textContent = `${target.label} 共 ${total} 条`
    b.querySelector('.page').textContent = `${st.page} / ${pages}`
    b.querySelector('[data-act=first]').disabled = st.page <= 1
    b.querySelector('[data-act=prev]').disabled = st.page <= 1
    b.querySelector('[data-act=next]').disabled = st.page >= pages
    b.querySelector('[data-act=last]').disabled = st.page >= pages
    b.querySelector('select').value = String(st.size)
    b.style.display = 'flex'
    b.style.bottom = document.querySelector('.main-layout.is-mobile') ? '64px' : '14px'
  }

  function pass() {
    try {
      let barShown = false
      for (const target of TARGETS) {
        for (const container of document.querySelectorAll(target.sel)) {
          if (!container.isConnected || !container.getClientRects().length) continue
          const rows = rowsOf(target, container)
          const total = rows.length
          const st = stateOf(target.id)
          const pages = st.size > 0 ? Math.ceil(total / st.size) : 1

          if (pages <= 1) {
            container.classList.remove('bpcs-paginated')
            for (const r of rows) if (r.classList.contains('bpcs-show')) r.classList.remove('bpcs-show')
            continue
          }
          container.classList.add('bpcs-paginated')
          st.page = Math.min(Math.max(st.page, 1), pages)
          const start = (st.page - 1) * st.size
          rows.forEach((r, i) => {
            const inPage = i >= start && i < start + st.size
            if (r.classList.contains('bpcs-show') !== inPage) r.classList.toggle('bpcs-show', inPage)
          })
          if (!barShown) {
            barShown = true
            updateBar(target, st, total, pages)
          }
        }
      }
      if (!barShown && bar) bar.style.display = 'none'
    } catch { /* 分页是增强功能，任何异常都不能影响页面本身 */ }
  }

  function start() {
    const style = document.createElement('style')
    style.textContent = CSS
    document.documentElement.appendChild(style)

    const lazyPass = debounce(pass, 200)
    // 全局观察路由切换/列表挂载；任务进度这类纯文本更新不会触发 childList
    new MutationObserver(lazyPass).observe(document.body, { childList: true, subtree: true })
    setInterval(lazyPass, 3000) // 兜底自愈
    pass()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
