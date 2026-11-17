// 可选：对真实 OpenAlex 跑一遍 M4 的调用链路（验证线上可用）
// 用法: node scripts/net-check.cjs [doi]
const DOI = process.argv[2] || '10.48550/arXiv.1706.03762'
const BASE = process.env.PAPERDESK_OPENALEX_BASE || 'https://api.openalex.org'
const MAILTO = process.env.PAPERDESK_OPENALEX_MAILTO || 'paperdesk@example.com'
const SELECT = 'id,doi,display_name,publication_year,cited_by_count,primary_location'
const shortId = (s) => (s || '').replace(/^https?:\/\/openalex\.org\//, '')

const get = async (path, params = {}) => {
  const u = new URL(BASE.replace(/\/$/, '') + path)
  u.searchParams.set('mailto', MAILTO)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  let lastErr = null
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt))
    const r = await fetch(u, { headers: { 'User-Agent': `PaperDesk/0.1 (mailto:${MAILTO})` } })
    if (r.status === 429) {
      lastErr = new Error('OpenAlex 429（限流，稍后重试）')
      continue
    }
    if (!r.ok) throw new Error(`OpenAlex ${r.status} ${path}`)
    return r.json()
  }
  throw lastErr ?? new Error('OpenAlex 请求失败')
}

const main = async () => {
  const seed = await get(`/works/doi:${encodeURIComponent(DOI)}`, {
    select: `${SELECT},referenced_works,related_works`
  })
  console.log('seed:', seed.display_name, '| citedBy', seed.cited_by_count)

  const refIds = (seed.referenced_works || []).map(shortId).slice(0, 25)
  const relIds = (seed.related_works || []).map(shortId).slice(0, 20)

  const batch = async (ids) => {
    if (!ids.length) return []
    const d = await get('/works', {
      filter: `openalex_id:${ids.join('|')}`,
      per_page: ids.length,
      select: SELECT
    })
    return d.results || []
  }
  const [refs, rels, cites] = await Promise.all([
    batch(refIds),
    batch(relIds),
    get('/works', {
      filter: `cites:${shortId(seed.id)}`,
      per_page: 15,
      sort: 'cited_by_count:desc',
      select: SELECT
    }).then((d) => d.results || [])
  ])

  console.log('references:', refs.length, '| related:', rels.length, '| citations:', cites.length)
  console.log('top reference:', refs[0] && refs[0].display_name)
  console.log('top citation :', cites[0] && `${cites[0].display_name} (被引 ${cites[0].cited_by_count})`)
  const ok = refs.length > 0 && cites.length > 0
  console.log(ok ? 'NET_OK' : 'NET_FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.log('NET_ERROR', e.message)
  process.exit(1)
})
