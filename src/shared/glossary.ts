export interface ArticleTerm {
  id: number
  attachmentId: number
  term: string
  sense: string
  translation: string
  context: string
  source: 'user' | 'web' | 'model'
  sourceUrl: string
  locked: boolean
}
export type ArticleTermInput = Omit<ArticleTerm, 'id' | 'source' | 'sourceUrl'> & { id?: number }

const STOP = new Set(['is', 'to', 'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'be', 'are', 'was', 'were', 'it', 'this', 'that', 'with', 'as', 'by', 'from'])
export function validTechnicalTerm(term: string): boolean {
  const t = term.trim()
  return t.length >= 2 && t.length <= 160 && !STOP.has(t.toLowerCase()) && !/[\r\n=]/.test(t)
}

/** Sense conditions are instructions, never part of the translated text. */
export function glossaryInstructions(entries: ArticleTerm[]): string {
  return entries.length ? '\nArticle terminology (apply only to the matching sense; never output the metadata):\n' + JSON.stringify(
    entries.map(({ term, sense, translation, context, locked }) => ({ term, sense, translation, context, priority: locked ? 'user-locked' : 'suggested' }))
  ) + '\nDetermine the sense from each sentence. Different senses of the same spelling may require different translations. User-locked entries take precedence.\n' : ''
}
