/** Native file-tool descriptions must describe the schemas the worker enforces (#44). */
import { DESCRIPTIONS, PARAMETERS } from '../lib/file/contract.js'
import { DESCRIPTIONS as PTC_DESCRIPTIONS } from '../lib/ptc/contract.js'
import { assert, report, test } from './lib/harness.mjs'

const fields = tool => Object.fromEntries(Object.entries(PARAMETERS[tool].properties).map(([name, schema]) => [name, schema.type]))

await test('grep, glob and replace parameters are pinned exactly', () => {
  assert.deepEqual(fields('grep'), {
    path: 'string', pattern: 'string', glob: 'array', outputMode: 'string', caseInsensitive: 'boolean',
    lineNumbers: 'boolean', beforeContext: 'integer', afterContext: 'integer', multiline: 'boolean', offset: 'integer', limit: 'integer',
  })
  assert.deepEqual(fields('glob'), { path: 'string', pattern: 'array', outputMode: 'string', sort: 'string', offset: 'integer', limit: 'integer' })
  assert.deepEqual(fields('replace'), { path: 'string', pattern: 'string', replacement: 'string', glob: 'array', maxReplacements: 'integer', dryRun: 'boolean' })
  for (const tool of ['grep', 'glob', 'replace']) assert.equal(PARAMETERS[tool].properties.include, undefined)
})

await test('descriptions name the array syntax, the missing include and literal replace', () => {
  assert.match(DESCRIPTIONS.glob, /pattern is an ARRAY of globs matched against paths relative to path/)
  assert.match(DESCRIPTIONS.glob, /\["\*\*\/\*\.md","!vendor\/\*\*"\]/)
  assert.match(DESCRIPTIONS.glob, /"\*\.md" matches the top level only/)
  assert.match(DESCRIPTIONS.glob, /at least one positive entry/)
  assert.match(DESCRIPTIONS.grep, /pattern is ONE Rust regex string/)
  assert.match(DESCRIPTIONS.grep, /glob, an ARRAY/)
  assert.match(DESCRIPTIONS.grep, /There is no include field/)
  assert.match(DESCRIPTIONS.replace, /LITERAL text \(pattern is not a regex\)/)
  // Only ops_glob requires a positive entry; the grep/replace filters accept exclude-only lists.
  for (const tool of ['grep', 'replace']) assert.doesNotMatch(DESCRIPTIONS[tool], /positive entry/)
  assert.doesNotMatch(DESCRIPTIONS.glob, /include\/exclude/)
})

await test('every file tool states that failures are values, not thrown errors', () => {
  for (const tool of Object.keys(PARAMETERS)) {
    assert.match(DESCRIPTIONS[tool], /Failures resolve as \{status:"error"\|"rejected", error\.code\}; they are not thrown\.$/, tool)
  }
  assert.doesNotMatch(PTC_DESCRIPTIONS.result, /legacy ops_\*/)
  assert.match(PTC_DESCRIPTIONS.result, /not thrown errors/)
})

report('file-contract')
