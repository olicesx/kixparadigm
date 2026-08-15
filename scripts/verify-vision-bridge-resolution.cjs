// Verify dsh-vision-bridge resolves through the (re-pointed) junction
// from the web profile's config anchor — the exact paths dsh uses:
//   1. Loader: require.resolve('dsh-vision-bridge')          -> main entry (server half)
//   2. client-modules registry: require.resolve('<name>/package.json') -> manifest probe
//      (this failed with ERR_PACKAGE_PATH_NOT_EXPORTED before the exports fix,
//       which is why the client half never composed into window.__DSH_BOOT__)
//   3. parse dsh.client declaration + exports["./client"]     -> client bundle path
const { createRequire } = require('module');
const fs = require('fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const anchor = join(dshHome, 'profiles', 'web', 'cordis.yml');
const r = createRequire(anchor);

// 1. main entry
const pkgPath = r.resolve('dsh-vision-bridge');
console.log('[1] main entry      ->', pkgPath);

// 2. manifest probe (the registry's resolveMeta path)
const pkgJsonPath = r.resolve('dsh-vision-bridge/package.json');
console.log('[2] manifest probe  ->', pkgJsonPath);
console.log('    real location   ->', fs.realpathSync(pkgJsonPath));

// 3. dsh.client declaration + client bundle
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
const decl = pkg.dsh && pkg.dsh.client;
if (!decl || typeof decl.platform !== 'string') throw new Error('dsh.client declaration missing/malformed');
const clientRel = pkg.exports && pkg.exports['./client'];
if (typeof clientRel !== 'string') throw new Error('exports["./client"] missing');
const clientAbs = fs.realpathSync(require('path').join(require('path').dirname(pkgJsonPath), clientRel));
if (!fs.existsSync(clientAbs)) throw new Error('client bundle file missing: ' + clientAbs);
console.log('[3] client decl     -> platform=' + decl.platform + ' inject=' + JSON.stringify(decl.inject));
console.log('    client bundle   ->', clientAbs);
console.log('    bundle bytes    ->', fs.statSync(clientAbs).size);

// main module must be loadable (server half) — resolved through the profile anchor
const main = r('dsh-vision-bridge');
console.log('[4] server apply()  ->', typeof main.apply === 'function' ? 'present' : 'MISSING');
console.log('ALL CHECKS PASSED');
