import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { patchMsys, proxyDefinition } from '../lib/bash-pe.js'
import { confinedBash, restrictedCompatibility } from '../lib/bash-ipc.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
await test('PE patch rejects non-PE input without writing anything', () => {
  assert.throws(()=>patchMsys(Buffer.from('not a DLL')),/Expected PE/)
})
await test('proxy definitions never intercept file, token, or impersonation APIs', () => {
  const kernel=proxyDefinition(['CreateNamedPipeA','CreatePipe','CreateFileA','CreateProcessW','ImpersonateNamedPipeClient'],'kernel32.dll')
  assert.match(kernel,/CreateNamedPipeA=OpsCreateNamedPipeA/)
  assert.match(kernel,/CreateFileA=KERNEL32.CreateFileA/)
  assert.match(kernel,/ImpersonateNamedPipeClient=KERNEL32.ImpersonateNamedPipeClient/)
  const nt=proxyDefinition(['NtCreateNamedPipeFile','NtCreateSection','NtCreateFile','NtSetInformationToken'],'ntdll.dll')
  assert.match(nt,/NtCreateFile=NTDLL.NtCreateFile/)
  assert.match(nt,/NtSetInformationToken=NTDLL.NtSetInformationToken/)
})
await test('private runtime accepts only matching original MSYS, and never edits the original', async () => {
  if(process.platform!=='win32')return
  const source=path.resolve('node_modules/@dsh-ops/bash-win32-x64')
  const original=fs.readFileSync(path.join(source,'usr/bin/msys-2.0.dll'))
  const hash=b=>createHash('sha256').update(b).digest('hex')
  const patched=patchMsys(original)
  assert.notEqual(hash(original),hash(patched.bytes))
  assert.equal(original.includes(Buffer.from('opsipc.dll')),false)
  assert.equal(patched.bytes.includes(Buffer.from('opsipc.dll')),true)
  await withTempDir('unsupported-msys',async root=>{
    fs.mkdirSync(path.join(root,'usr/bin'),{recursive:true})
    fs.writeFileSync(path.join(root,'usr/bin/msys-2.0.dll'),'unsupported')
    const bash=path.join(root,'usr/bin/bash.exe')
    let message=''
    try { confinedBash(bash,{source:'config'}) } catch(error) { message=error.message }
    // The diagnostic is actionable, not "rebuild the proxies" (#42).
    assert.match(message,/^EXECUTOR_UNAVAILABLE: ops_bash cannot run the configured bashPath /)
    assert.ok(message.includes(bash),message)
    assert.match(message,/is not the pinned build/)
    assert.match(message,/works only in danger-full-access/)
    assert.match(message,/remove bashPath/)
    assert.match(message,/provision-shells --bash/)
    assert.match(message,/no per-call sandbox_permissions escalation/)
    assert.doesNotMatch(message,/Rebuild the matching proxies/)
    const check=restrictedCompatibility(bash)
    assert.equal(check.compatible,false)
    assert.equal(check.expectedSha256===undefined,false)
    assert.equal(fs.readFileSync(path.join(root,'usr/bin/msys-2.0.dll'),'utf8'),'unsupported')
    assert.deepEqual(fs.readdirSync(root),['usr'],'the check copies or builds nothing')
  })
  assert.equal(hash(fs.readFileSync(path.join(source,'usr/bin/msys-2.0.dll'))),hash(original))
})
await test('restricted compatibility accepts the pinned payload and explains a missing MSYS layout', async () => {
  if(process.platform!=='win32')return
  const receipt=path.resolve('runtime/win32-x64/bash-ipc/provenance.json')
  if(fs.existsSync(receipt)) {
    const pinned=restrictedCompatibility(path.resolve('node_modules/@dsh-ops/bash-win32-x64/bin/bash.exe'))
    assert.equal(pinned.compatible,true,pinned.reason)
  }
  await withTempDir('no-msys',async root=>{
    const check=restrictedCompatibility(path.join(root,'bin/bash.exe'))
    assert.equal(check.compatible,false)
    assert.match(check.reason,/not the supported MSYS payload layout/)
    assert.throws(()=>confinedBash(path.join(root,'bin/bash.exe'),{source:'well-known'}),/system Git for Windows install .*works only in danger-full-access/s)
  })
})
report('bash-ipc')
