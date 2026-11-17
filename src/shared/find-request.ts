/**
 * 阅读器「查找框初值」规则（纯函数，便于单测）。
 *
 * 文库全文命中行会把三样东西一起送进阅读器：一次性 `findRequest`（命中词 + 目标页 + nonce）、
 * 父级公共工具栏的 `findQuery`（以 `externalFindQuery` 下发）、以及可能为空的历史查找词。
 *
 * `PdfViewer` **挂载**时必须直接用这次带入的词初始化内部查找框，否则会出现两个连锁问题：
 *  1) 挂载首帧把内部初值 `''` 回传父级，`setFindQuery('')` 把 `openHit` 刚设置的命中词打回空；
 *  2) 「用户改了查找词 → 旧请求失效」的判定（`pending.query !== findQuery`）随即丢弃待定位请求，
 *     结果是查找框空、命中计数 0、页面无高亮 —— 即「新打开文档时命中词丢失」的根因。
 *
 * 规则：请求词优先（纯空白视为未设置）→ 外部词兜底（同样跳过纯空白）→ 空串。
 * 返回原始词（不 trim），因为查找框展示的是用户实际搜索的词；空白判定只用于「是否采用」。
 */
export function seedFindQuery(
  findRequest: { query?: string | null } | null | undefined,
  externalFindQuery?: string | null
): string {
  const fromRequest = findRequest?.query
  if (typeof fromRequest === 'string' && fromRequest.trim() !== '') return fromRequest
  if (typeof externalFindQuery === 'string' && externalFindQuery.trim() !== '') {
    return externalFindQuery
  }
  return ''
}
