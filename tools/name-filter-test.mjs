#!/usr/bin/env node
// GROW EVERYTHING — name filter regression cases (Scunthorpe false positives + real slurs).
// Usage: npm run test:names   (node --experimental-strip-types tools/name-filter-test.mjs)
import { cleanName, isOffensiveName, nameTokens } from '../game/src/arena/nameFilter.ts';

/** Innocent names that contain a blocked string somewhere: must pass unchanged. */
const ALLOW = [
  'Dickens', 'Charles Dickens', 'Scunthorpe', 'Cassandra', 'Essex', 'Matsushita', 'Sussex', 'Middlesex', 'Hancock', 'Cockburn',
  'Therapist', 'Grape', 'Assassin', 'Classic', 'Bass', 'Pass', 'Shitara', 'Penistone', 'Arsenal', 'Titan', 'Petit', 'Cumberland',
  'Cummings', 'Analysis', 'Hitchcock', 'Wankel', 'Nazir', 'Shoe', 'Sbarro', 'Player123', 'Alice', 'Bob', 'xX_Gamer_Xx', '小明', '吃货一号',
  'Matt',
];
// Known, accepted trade-off: the first name "Dick" on its own is blocked (token "dick").

/** Offensive names (plain, leetspeak, spaced, stretched, camelCase, zh): must be replaced. */
const BLOCK = [
  'fuck', 'FUCK', 'fuckface', 'Clusterfuck', 'f.u.c.k', 'f u c k', 'fuuuuck', 'FuckU', 'sh1t', 'Shit', 'bullshit', 'ShitLord', 's.h.i.t',
  'bitch', 'B1tch', 'biitch', 'Bitches', 'cunt', 'CUNT', 'dick', 'BigDick', 'big dick', 'Dickhead', 'ass', '@ss', 'a$$', 'asshole',
  'Assh0le', 'nigger', 'n1gga', 'faggot', 'retard', 'whore', 'slut', 'pussy', 'rapist', 'rape', 'nazi', 'Hitler', 'porn', 'pornstar', 'motherfucker',
  'cocksucker', 'sex', 'SEXY', 'cum', 'tits', 'wanker', 'twat', 'kys', 'kill yourself', 'stfu', 'wtf', '傻逼', '操你妈', '尼玛', 'sb', 'nmsl', '你妈的',
];

let fail = 0;
for (const n of ALLOW) {
  if (isOffensiveName(n) || cleanName(n, 'Player123') !== n) {
    fail++;
    console.log(`FALSE POSITIVE  ${JSON.stringify(n)}  tokens=${JSON.stringify(nameTokens(n))}`);
  }
}
for (const n of BLOCK) {
  if (!isOffensiveName(n) || cleanName(n, 'Player123') !== 'Player123') {
    fail++;
    console.log(`MISSED          ${JSON.stringify(n)}  tokens=${JSON.stringify(nameTokens(n))}`);
  }
}
console.log(`name filter: ${ALLOW.length} allowed + ${BLOCK.length} blocked cases, ${fail} failure(s)`);
process.exit(fail ? 1 : 0);
