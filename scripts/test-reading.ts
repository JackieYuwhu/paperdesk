import assert from 'node:assert/strict'
import { glossaryInstructions, validTechnicalTerm, type ArticleTerm } from '../src/shared/glossary.ts'
import { canReuseTranslation } from '../src/shared/translation-reuse.ts'

for (const term of ['is', 'to', 'the', 'and', ' IS ']) assert.equal(validTechnicalTerm(term), false)
for (const term of ['pool', 'candidate pool', 'LTL', 'branch-and-bound']) assert.equal(validTechnicalTerm(term), true)
const base: ArticleTerm = { id: 1, attachmentId: 1, term: 'pool', sense: '候选集合', translation: '候选池', context: 'candidate pool', source: 'user', sourceUrl: '', locked: true }
const prompt = glossaryInstructions([base, { ...base, id: 2, sense: '水域', translation: '水池', context: 'swimming pool' }])
assert(prompt.includes('候选池') && prompt.includes('水池') && prompt.includes('matching sense') && prompt.includes('user-locked'))
assert.equal(glossaryInstructions([]), '')
const signature = { backend: 'openai', model: 'fixture', fingerprint: 'pdf-v1', engineKey: 'simple', terminologyHash: 'terms-v1' }
const row = { status: 'done', engine: 'simple', backend: 'openai', qa: JSON.stringify({ reuse: signature }) }
assert.equal(canReuseTranslation(row, signature, 'openai'), true)
assert.equal(canReuseTranslation(row, { ...signature, terminologyHash: 'terms-v2' }, 'openai'), false)
assert.equal(canReuseTranslation(row, { ...signature, fingerprint: 'pdf-v2' }, 'openai'), false)
console.log('READING_REGRESSIONS_OK')
