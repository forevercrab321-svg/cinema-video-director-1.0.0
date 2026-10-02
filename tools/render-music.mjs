// Offline render of the procedural BGM and victory fanfare to MP3 previews (exactly the in-game
// synth: the real AudioEngine runs on an OfflineAudioContext with a driven clock).
//   node tools/render-music.mjs   (needs the dev server: npx vite --port 5195)
// Output: renders/audio/bgm-<city>.mp3 (32 s: tier 1 → 4, a layer every 8 s), victory.mp3
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ffmpeg = process.env.FFMPEG ?? execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
await p.goto(process.env.BASE ?? 'http://127.0.0.1:5195/game/?mode=arena&net=solo&test=1&quality=low');
await p.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180000 });

const render = (job) => p.evaluate(async ({ city, secs, victoryAt, tierEvery }) => {
  const RATE = 44100;
  let now = 0;
  const Off = class extends OfflineAudioContext {
    constructor() { super(2, Math.ceil(RATE * secs), RATE); Object.defineProperty(this, 'currentTime', { get: () => now }); }
  };
  const saved = window.AudioContext;
  window.AudioContext = Off;
  const { AudioEngine } = await import('/game/src/audio/AudioEngine.ts');
  const e = new AudioEngine();
  e.start();
  window.AudioContext = saved;
  clearInterval(e.timer);
  e.setTheme(city);
  e.tier = 1;
  for (now = 0; now < secs; now += 0.05) {
    if (tierEvery) e.tier = Math.min(4, 1 + Math.floor(now / tierEvery));
    if (victoryAt !== null && Math.abs(now - victoryAt) < 0.025) e.victory();
    e.schedule();
  }
  now = 0;
  const buf = await e.ctx.startRendering();
  // 16-bit PCM WAV → base64.
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];
  const len = buf.length, bytes = new DataView(new ArrayBuffer(44 + len * 4));
  const str = (o, s) => [...s].forEach((c, i) => bytes.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); bytes.setUint32(4, 36 + len * 4, true); str(8, 'WAVEfmt '); bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true);
  bytes.setUint32(24, RATE, true); bytes.setUint32(28, RATE * 4, true); bytes.setUint16(32, 4, true); bytes.setUint16(34, 16, true); str(36, 'data'); bytes.setUint32(40, len * 4, true);
  let peak = 0;
  for (let i = 0; i < len; i++) for (let c = 0; c < 2; c++) { const v = Math.max(-1, Math.min(1, ch[c][i])); peak = Math.max(peak, Math.abs(v)); bytes.setInt16(44 + (i * 2 + c) * 2, v * 32767, true); }
  let bin = ''; const u8 = new Uint8Array(bytes.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { wav: btoa(bin), peak };
}, job);

const jobs = [
  ...['shanghai', 'newyork', 'paris', 'scrap', 'halloween', 'halloween-hunt'].map((city) => ({ name: `bgm-${city}`, city, secs: 32, victoryAt: null, tierEvery: 8 })),
  { name: 'victory', city: 'shanghai', secs: 6, victoryAt: 0.5, tierEvery: 0 },
];
for (const j of jobs) {
  const { wav, peak } = await render(j);
  const tmp = resolve(root, `renders/audio/${j.name}.wav`);
  writeFileSync(tmp, Buffer.from(wav, 'base64'));
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', tmp, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '160k', resolve(root, `renders/audio/${j.name}.mp3`)]);
  execFileSync('rm', [tmp]);
  console.log(`${j.name}.mp3 peak=${peak.toFixed(2)}`);
}
await b.close();
