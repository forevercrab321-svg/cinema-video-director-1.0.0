// Build the Steam desktop app: SDK-free portal build (neutral villain names, no ads) wrapped in
// the Electron shell in steam/. Output: release/steam/GROW EVERYTHING-<platform>-<arch>/ plus a zip
// per platform, ready for a SteamPipe depot.
//   node tools/build-steam.mjs [win32|linux|darwin ...]   (default: win32)
// Needs `npm install` inside steam/ once (electron + @electron/packager).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shell = resolve(root, 'steam');
const platforms = process.argv.slice(2).length ? process.argv.slice(2) : ['win32'];
if (!existsSync(resolve(shell, 'node_modules/@electron/packager'))) throw new Error('run `npm install` in steam/ first');

execSync('node tools/build-portal.mjs nosdk', { cwd: root, stdio: 'inherit' });
// Real names must never reach Steam (store review and the bundle are both checked).
const assets = resolve(root, 'dist-portal/assets');
const leaks = readdirSync(assets).filter((f) => /Yang Yongxin|Norman Bates|Hannibal|杨永信|汉尼拔|诺曼/.test(readFileSync(resolve(assets, f), 'utf8')));
if (leaks.length) throw new Error(`real villain names in the bundle: ${leaks.join(', ')}`);

rmSync(resolve(shell, 'game'), { recursive: true, force: true });
cpSync(resolve(root, 'dist-portal'), resolve(shell, 'game'), { recursive: true });

const outDir = resolve(root, 'release/steam');
for (const platform of platforms) {
  execSync(
    `npx electron-packager . "GROW EVERYTHING" --platform=${platform} --arch=x64 --out="${outDir}" --overwrite --asar ` +
      `--ignore="^/node_modules" --app-copyright="Zhuleli" --win32metadata.CompanyName="Zhuleli" --win32metadata.ProductName="GROW EVERYTHING"`,
    { cwd: shell, stdio: 'inherit' },
  );
  const dir = `GROW EVERYTHING-${platform}-x64`;
  const zip = resolve(outDir, `grow-everything-steam-${platform}-x64.zip`);
  rmSync(zip, { force: true });
  execSync(`zip -qry "${zip}" "${dir}"`, { cwd: outDir });
  console.log(`${zip} ${(statSync(zip).size / 1048576).toFixed(1)} MB`);
}
